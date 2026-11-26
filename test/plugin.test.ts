import { describe, expect, test } from "bun:test";
// A fixed port made this suite depend on whatever else is running: another
// project's gateway squatting 8897 answered the health check, the plugin failed
// silently on EADDRINUSE, and every assertion then measured the wrong server.
// Pick a free port instead so the test can only ever talk to its own.
function freePort(start) {
  for (let p = start; p < start + 200; p++) {
    try {
      const s = Bun.serve({ port: p, hostname: "127.0.0.1", fetch: () => new Response("") });
      s.stop(true);
      return p;
    } catch { /* occupied, try the next */ }
  }
  throw new Error("no free port");
}

const MOCK_PORT = freePort(18900);
process.env.MISTRAL_BASE = `http://127.0.0.1:${MOCK_PORT}`;
process.env.MISTRAL_VIBE_KEY = "mstrl_octest";
process.env.MISTRAL_VIBE_OC_PORT = String(freePort(MOCK_PORT + 1));
// Scratch state dir: the plugin publishes its bound port there, and a real
// ~/.mistral-vibe/keys.json would otherwise add keys the scenarios did not plan
// for (round-robin would then reach the mock with unexpected credentials).
const STATE_DIR = `${process.env.TMPDIR ?? "/tmp"}/mv-oc-state-${process.pid}`;
process.env.MISTRAL_VIBE_STATE_DIR = STATE_DIR;
process.env.VIBE_KEYS = `${STATE_DIR}/keys.json`;

type Captured = { auth: string | null; ua: string | null; body: Record<string, unknown> };
const seen: Captured[] = [];

// Per-scenario scripted behaviour, keyed by the request body's `__scenario`
// marker (normalizeBody keeps unknown fields) or by model when absent. Each
// entry is consumed in order, so a scenario can answer the first attempt
// differently from the retry it expects.
type Line =
  | "starved"
  | "answer"
  | "truncated"
  | "truncated-always"
  | 429
  | "capacity-always"
  | "stall"
  | "stall-always"
  | 500
  | "boom-always";
const script: Record<string, Line[]> = {};
const HITS: Record<string, number> = {};
const hitCount = (model: string) => HITS[model] ?? 0;

const thinking = [{ type: "thinking", thinking: [{ type: "text", text: "think" }] }];
const answerContent = [...thinking, { type: "text", text: "144" }];
const truncatedCall = [
  {
    id: "call_1",
    type: "function",
    function: { name: "write", arguments: '{"path":"a.txt","content":"hel' },
  },
];

function nonStream(model: unknown, line: Line) {
  if (line === "starved") {
    return Response.json({
      id: "m", object: "chat.completion", model,
      choices: [{ index: 0, message: { role: "assistant", content: thinking }, finish_reason: "length" }],
    });
  }
  if (line === "truncated" || line === "truncated-always") {
    return Response.json({
      id: "m", object: "chat.completion", model,
      choices: [{ index: 0, message: { role: "assistant", content: [], tool_calls: truncatedCall }, finish_reason: "tool_calls" }],
    });
  }
  return Response.json({
    id: "m", object: "chat.completion", model,
    choices: [{ index: 0, message: { role: "assistant", content: answerContent }, finish_reason: "stop" }],
  });
}

function sse(events: unknown[]) {
  return new Response(events.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function streamed(model: unknown, line: Line) {
  if (line === "stall" || line === "stall-always") {
    // One reasoning delta, then silence: a thinking model can look like this
    // forever, so the reader must give up on its own.
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({ id: "m", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { reasoning_content: "think" }, finish_reason: null }] })}\n\n`,
        ));
        // never close, never send another byte
      },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  }
  if (line === "starved") {
    return sse([
      { id: "m", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: thinking }, finish_reason: null }] },
      { id: "m", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
    ]);
  }
  if (line === "truncated-always") {
    return sse([
      { id: "m", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...truncatedCall[0] }] }, finish_reason: null }] },
      { id: "m", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);
  }
  return sse([
    { id: "m", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: answerContent }, finish_reason: null }] },
    { id: "m", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]);
}

Bun.serve({
  port: MOCK_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET") {
      if (url.pathname === "/v1/billing/budget") {
        // usage_percentage is already a percent: 10 means 10% of $300 = $30.
        return Response.json({ vibe_budget: { initial_budget: 300, usage_percentage: 10, reset_at: "2026-12-01T00:00:00Z" } });
      }
      return Response.json({ data: [] });
    }
    const body = (await req.json()) as Record<string, unknown>;
    seen.push({ auth: req.headers.get("authorization"), ua: req.headers.get("user-agent"), body });
    const model = String(body.model ?? "");
    const key = String(body.__scenario ?? model);
    const auth = req.headers.get("authorization");
    // Cooldown scenario: every key but the good one is rejected, so the pool has
    // to move on regardless of which key the round-robin reaches first.
    if (key === "cooldown" && auth !== "Bearer mstrl_cooldown_b") {
      return Response.json({ error: { message: "bad key" } }, { status: 401 });
    }
    HITS[key] = hitCount(key) + 1;
    const planned = script[key];
    let line: Line = "answer";
    if (planned?.length) {
      // The "-always" lines describe a whole scenario, not one attempt: they must
      // answer every rung until the ladder gives up.
      const peek = planned[0];
      line = peek === "truncated-always" || peek === "capacity-always" || peek === "stall-always" || peek === "boom-always" ? peek : (planned.shift() as Line);
    }
    if (line === 429 || line === "capacity-always") {
      return Response.json({ error: { message: "no capacity" } }, { status: 429 });
    }
    if (line === 500 || line === "boom-always") {
      return Response.json({ error: { message: "upstream broke" } }, { status: 500 });
    }
    if (line === "truncated-always") {
      return body.stream === true ? streamed(model, line) : nonStream(model, line);
    }
    if (body.stream !== true) return nonStream(model, line);
    return streamed(model, line);
  },
});

// Dynamic import is required: the plugin binds its loopback server and reads its
// env at module load, so a static import would run before the mock above exists.
await import("../plugins/mistral-vibe.ts");
await new Promise((r) => setTimeout(r, 400));
const base = `http://127.0.0.1:${process.env.MISTRAL_VIBE_OC_PORT}`;
const post = (body: unknown) =>
  fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer local" }, body: JSON.stringify(body) });

describe("opencode mistral-vibe plugin", () => {
  test("health and catalog", async () => {
    const h: any = await (await fetch(`${base}/health`)).json();
    expect(h.mode).toBe("in-process");
    expect(h.user_agent).toMatch(/^mistral-client-python\/Mistral-Vibe\//);
    const m: any = await (await fetch(`${base}/v1/models`)).json();
    expect(Array.isArray(m.data)).toBe(true);
  });

  test("typed parts flatten and effort clamps", async () => {
    const r = await post({ model: "zai-glm-5-3-flash", messages: [{ role: "user", content: "x" }], reasoning_effort: "medium", max_completion_tokens: 50, store: true });
    const j: any = await r.json();
    expect(j.choices[0].message.content).toBe("144");
    expect(j.choices[0].message.reasoning_content).toBe("think");
    const sent = seen.at(-1)!;
    expect(sent.auth).toBe("Bearer mstrl_octest");
    // GLM accepts only {low, high, max}; `medium` maps DOWN to low. It used to
    // map to `high`, which spends the whole output budget on reasoning and
    // returns an empty reply (measured).
    expect(sent.body.reasoning_effort).toBe("low");
    expect(sent.body.max_tokens).toBe(50);
    expect(sent.body.store).toBeUndefined();
    // What routes spend to the Vibe allowance (UA alone stopped working 2026-11-25).
    expect(sent.body.metadata).toEqual({ call_source: "vibe_code" });
  });

  test("stream is ASCII-only with split finish chunk", async () => {
    const text = await (await post({ model: "zai-glm-5-3-flash", messages: [], stream: true })).text();
    expect([...text].every((c) => c.charCodeAt(0) <= 126)).toBe(true);
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    const events = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)));
    expect(events.some((e: any) => e.choices[0].delta.reasoning_content === "think")).toBe(true);
  });

  test("state exposes the budget in proxy shape", async () => {
    const s: any = await (await fetch(`${base}/api/state`)).json();
    expect(s.budget.vibe_budget.initial_budget).toBe(300);
    expect(Array.isArray(s.keys.list)).toBe(true);
  });
});

describe("prefix-cache accounting", () => {
  test("state exposes cached tokens and a hit rate", async () => {
    const s: any = await (await fetch(`http://127.0.0.1:${process.env.MISTRAL_VIBE_OC_PORT}/api/state`)).json();
    // Fields must exist even before traffic, so a client can read them safely.
    expect(typeof s.requests.tokens_cached).toBe("number");
    expect(typeof s.requests.cache_hit_pct).toBe("number");
  });
});

describe("starved-turn recovery", () => {
  test("non-stream retries at the next lower effort and answers", async () => {
    script["starved"] = ["starved", "answer"];
    // A real ladder model: recovery only walks levels the model accepts.
    const r = await post({ model: "zai-glm-5-3-flash", messages: [], reasoning_effort: "high", __scenario: "starved" });
    const j: any = await r.json();
    expect(r.status).toBe(200);
    expect(j.choices[0].message.content).toBe("144");
    expect(j.choices[0].message.reasoning_content).toBe("think");
  });

  test("the retry carries the lowered effort", async () => {
    script["effort"] = ["starved", "answer"];
    const before = seen.length;
    await post({ model: "zai-glm-5-3-flash", messages: [], reasoning_effort: "high", __scenario: "effort" });
    const attempts = seen.slice(before);
    expect(attempts.length).toBe(2);
    expect(attempts[0].body.reasoning_effort).toBe("high");
    // zai-glm-5-3-flash's ladder is [max, high, low]; `high` steps down to `low`.
    expect(attempts[1].body.reasoning_effort).toBe("low");
  });

  test("state counts the ladder retries", async () => {
    const s: any = await (await fetch(`${base}/api/state`)).json();
    expect(s.requests.reasoning_retries).toBeGreaterThanOrEqual(2);
  });

  test("stream retries before any finish reaches the client", async () => {
    script["stream-starved"] = ["starved", "answer"];
    const text = await (
      await post({ model: "zai-glm-5-3-flash", messages: [], stream: true, reasoning_effort: "high", __scenario: "stream-starved" })
    ).text();
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    const events = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)));
    const finishes = events.filter((e: any) => e.choices[0].finish_reason);
    // Exactly one finish, and it is the recovered attempt's, not the starved one.
    expect(finishes.length).toBe(1);
    expect(finishes[0].choices[0].finish_reason).toBe("stop");
    expect(events.some((e: any) => e.choices[0].delta.content === "144")).toBe(true);
  });

  test("gives up with a starved message when the ladder is exhausted", async () => {
    // Every rung starves: the client gets an error, never an empty 200.
    script["always-starved"] = ["starved", "starved", "starved", "starved", "starved", "starved"];
    const r = await post({ model: "zai-glm-5-3-flash", messages: [], reasoning_effort: "high", __scenario: "always-starved" });
    expect(r.status).toBe(502);
    const j: any = await r.json();
    expect(j.error.message).toMatch(/exhausted max_tokens on reasoning/);
  });
});

describe("truncated tool-call recovery", () => {
  test("non-stream retries lower and returns the complete call", async () => {
    script["truncated"] = ["truncated", "answer"];
    const r = await post({ model: "zai-glm-5-3-flash", messages: [], reasoning_effort: "high", __scenario: "truncated" });
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.choices[0].message.content).toBe("144");
  });

  test("non-stream reports the truncation when every rung truncates", async () => {
    script["truncated-forever"] = ["truncated-always"];
    const r = await post({ model: "zai-glm-5-3-flash", messages: [], reasoning_effort: "high", __scenario: "truncated-forever" });
    expect(r.status).toBe(502);
    const j: any = await r.json();
    expect(j.error.code).toBe("truncated_tool_call");
    expect(j.error.message).toMatch(/cut off by max_tokens after \d+ characters/);
  });

  test("stream drops the unusable call and fails loudly", async () => {
    script["stream-truncated"] = ["truncated-always"];
    const text = await (
      await post({ model: "zai-glm-5-3-flash", messages: [], stream: true, reasoning_effort: "high", __scenario: "stream-truncated" })
    ).text();
    const events = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)));
    // No tool-call delta may reach the client: its arguments are invalid JSON.
    expect(events.some((e: any) => Array.isArray(e.choices?.[0]?.delta?.tool_calls))).toBe(false);
    // An unknown finish_reason is what makes the agent's SDK fail the turn.
    expect(events.some((e: any) => e.choices?.[0]?.finish_reason === "incomplete_reasoning")).toBe(true);
  });
});

describe("key pool and failure classification", () => {
  test("a rejected key cools down and the request still succeeds on the other", async () => {
    const dir = process.env.MISTRAL_VIBE_STATE_DIR!;
    // Exactly two keys in the pool: the env key is pinned to the bad one, the key
    // file supplies the good one. Round-robin may start at either, so two
    // requests guarantee both are exercised.
    const envKey = process.env.MISTRAL_VIBE_KEY;
    process.env.MISTRAL_VIBE_KEY = "mstrl_cooldown_a";
    await Bun.write(`${dir}/keys.json`, JSON.stringify({ keys: ["mstrl_cooldown_b"] }));
    try {
      for (let i = 0; i < 2; i++) {
        const r = await fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer mstrl_cooldown_a" },
          body: JSON.stringify({ model: "zai-glm-5-3-flash", messages: [], __scenario: "cooldown" }),
        });
        expect(r.status).toBe(200);
      }
      const s: any = await (await fetch(`${base}/api/state`, { headers: { Authorization: "Bearer mstrl_cooldown_a" } })).json();
      // A was rejected, so it cools for 10 minutes; B carried every turn.
      const cooling = s.keys.list.filter((k: any) => k.cooldown_s > 0);
      expect(cooling.length).toBe(1);
      expect(cooling[0].cooldown_s).toBeGreaterThan(500);
    } finally {
      process.env.MISTRAL_VIBE_KEY = envKey;
      await Bun.write(`${dir}/keys.json`, JSON.stringify({ keys: [] }));
    }
  });

  test("capacity is a 429 with Retry-After and never disables the key", async () => {
    script["capacity"] = ["capacity-always"];
    const coolingBefore = (await (await fetch(`${base}/api/state`)).json() as any).keys.list.filter((k: any) => k.cooldown_s > 0).length;
    const r = await post({ model: "zai-glm-5-3-flash", messages: [], __scenario: "capacity" });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    const j: any = await r.json();
    expect(j.error.message).toMatch(/key was not disabled/);
    // A 429 must not cool any key, so the count of cooling keys cannot grow —
    // and the very next request still goes through.
    const s: any = await (await fetch(`${base}/api/state`)).json();
    expect(s.keys.list.filter((k: any) => k.cooldown_s > 0).length).toBe(coolingBefore);
    const again = await post({ model: "zai-glm-5-3-flash", messages: [] });
    expect(again.status).toBe(200);
  });
});

describe("port contract", () => {
  test("health names the service and the state file carries the port", async () => {
    const h: any = await (await fetch(`${base}/health`)).json();
    expect(h.service).toBe("mistral-vibe-opencode");
    const published = JSON.parse(await Bun.file(`${process.env.MISTRAL_VIBE_STATE_DIR}/opencode-server.json`).text());
    expect(published.service).toBe("mistral-vibe-opencode");
    expect(published.port).toBe(Number(process.env.MISTRAL_VIBE_OC_PORT));
  });

  test("state names the service too", async () => {
    const s: any = await (await fetch(`${base}/api/state`)).json();
    expect(s.service).toBe("mistral-vibe-opencode");
    expect(typeof s.requests.reasoning_out).toBe("number");
  });
});

describe("hardening parity with the omp/pi extension", () => {
  test("a stalled upstream is abandoned instead of hanging the turn", async () => {
    // The mock sends one reasoning delta and then never another byte. Without an
    // idle budget the turn would sit until the 1 h request timeout.
    const prior = process.env.MV_STREAM_IDLE_MS;
    process.env.MV_STREAM_IDLE_MS = "300";
    try {
      script["stall"] = ["stall-always"];
      const started = Date.now();
      const text = await (
        await post({ model: "zai-glm-5-3-flash", messages: [], stream: true, __scenario: "stall" })
      ).text();
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(5000);
      // The reasoning delta arrived before the stall, so a retry is impossible
      // (the client saw output) and the turn must fail loudly instead of
      // ending with a bare [DONE] the agent would accept as complete.
      const events = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)));
      expect(events.some((e: any) => e.choices?.[0]?.delta?.reasoning_content === "think")).toBe(true);
      expect(events.some((e: any) => e.choices?.[0]?.finish_reason === "incomplete_reasoning")).toBe(true);
      expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    } finally {
      process.env.MV_STREAM_IDLE_MS = prior;
    }
  });

  test("an oversized body is drained and answered 413, not an aborted socket", async () => {
    const big = "x".repeat(33 * 1024 * 1024);
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer local" },
      body: JSON.stringify({ model: "zai-glm-5-3-flash", messages: [{ role: "user", content: big }] }),
    });
    expect(r.status).toBe(413);
    expect(r.headers.get("connection")).toBe("close");
    // The body is still readable: draining is what makes this a 413 rather than
    // a reset connection.
    const j: any = await r.json();
    expect(j.error.message).toBe("request body too large");
  });

  test("a foreign browser Origin is refused", async () => {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example", Authorization: "Bearer local" },
      body: JSON.stringify({ model: "zai-glm-5-3-flash", messages: [] }),
    });
    expect(r.status).toBe(403);
    const j: any = await r.json();
    expect(j.error.message).toMatch(/cross-origin/);
  });

  test("OPTIONS preflights carry no wildcard origin", async () => {
    const r = await fetch(`${base}/api/state`, { method: "OPTIONS" });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("no response ever returns a wildcard CORS origin", async () => {
    for (const path of ["/health", "/healthz", "/api/state", "/v1/models"]) {
      const r = await fetch(`${base}${path}`);
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  test("healthz answers without touching the network", async () => {
    const t0 = Date.now();
    const z: any = await (await fetch(`${base}/healthz`)).json();
    expect(z.service).toBe("mistral-vibe-opencode");
    expect(z.ok).toBe(true);
    // The catalog probe would 10s-timeout against the mock's empty list; this
    // route must never await it.
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test("an unrecognised reasoning level is floored, never forwarded verbatim", async () => {
    const before = seen.length;
    await post({ model: "zai-glm-5-3-flash", messages: [], reasoning_effort: "definitely-not-a-level" });
    const sent = seen.slice(before).at(-1)!;
    // Mistral 422s the whole turn on any level outside its enum. GLM's weakest
    // wire level is `low`.
    expect(sent.body.reasoning_effort).toBe("low");
  });

  test("a 5xx is logged and surfaced as transient, a 429 never is", async () => {
    const logPath = `${process.env.MISTRAL_VIBE_STATE_DIR}/opencode-errors.log`;
    // A Bun.file handle caches its stat, so each check re-creates it.
    const readLog = () => Bun.file(logPath);
    await readLog().delete().catch(() => undefined);
    // A 429 is capacity pressure, not an upstream fault: nothing to log.
    script["cap-only"] = ["capacity-always"];
    await post({ model: "zai-glm-5-3-flash", messages: [], __scenario: "cap-only" });
    expect(await readLog().exists()).toBe(false);

    // A 5xx is exhausted over MAX_ATTEMPTS and reported as transient, with the
    // body preserved in the log so a 422-class rejection is diagnosable.
    script["boom"] = ["boom-always"];
    const r = await post({ model: "zai-glm-5-3-flash", messages: [], reasoning_effort: "high", __scenario: "boom" });
    expect(r.status).toBe(500);
    const j: any = await r.json();
    expect(j.error.message).toMatch(/temporary error/);
    expect(j.error.upstream_status).toBe(500);
    const written = await readLog().text();
    const entry = JSON.parse(written.trim().split("\n").at(-1)!);
    expect(entry.status).toBe(500);
    expect(entry.model).toBe("zai-glm-5-3-flash");
    expect(entry.effort).toBe("high");
    expect(entry.detail).toMatch(/upstream broke/);
    // Never leak the key into diagnostics.
    expect(written).not.toContain("mstrl_");
  });
});

describe("secret hygiene", () => {
  test("state never reveals a key beyond an irreversible fingerprint", async () => {
    await Bun.write(
      `${process.env.MISTRAL_VIBE_STATE_DIR}/keys.json`,
      JSON.stringify({ keys: ["mstrl_SUPERSECRETVALUE0123456789"] }),
    );
    try {
      const raw = await (await fetch(`${base}/api/state`)).text();
      // The full secret, and enough of its tail to reconstruct it, must not appear.
      expect(raw).not.toContain("SUPERSECRETVALUE");
      expect(raw).not.toContain("6789");
      const s = JSON.parse(raw);
      expect(s.keys.list.some((k: any) => /…[0-9a-f]{8}$/.test(k.key))).toBe(true);
    } finally {
      await Bun.write(`${process.env.MISTRAL_VIBE_STATE_DIR}/keys.json`, JSON.stringify({ keys: [] }));
    }
  });
});
