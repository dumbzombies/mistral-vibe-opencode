# mistral-vibe-opencode

Mistral Vibe as an [opencode](https://opencode.ai) plugin.

Mistral bills tool use against an API key's $30/month budget. The Vibe client draws on a
separate $300/month allowance and marks its traffic with a Vibe `User-Agent` plus
`metadata.call_source: "vibe_code"`. This plugin puts the plain OpenAI-compatible surface on
that endpoint with those markers, so agent traffic comes out of the Vibe allowance.

The plugin is one self-contained file. It starts an OpenAI-compatible server on
`127.0.0.1:8810` when opencode loads it, because Mistral's Vibe surface returns typed content
parts (`{type:"text"}`, `{type:"thinking"}`) that opencode's OpenAI client rejects as an
invalid stream event. The local server flattens them into `content` + `reasoning_content`,
clamps `reasoning_effort` per model, strips replayed reasoning, and ASCII-escapes SSE.

## Install

```bash
git clone https://github.com/dumbzombies/mistral-vibe-opencode
cd mistral-vibe-opencode
./install.sh
```

That copies the plugin into `~/.config/opencode/plugins/`, merges the provider block into
`opencode.jsonc`, and puts `vibe-quota` on `PATH`. A re-run is idempotent and backs up every
file it overwrites to `*.bak-vibe2api`. `./install.sh --dry-run` prints the plan and writes
nothing.

`OPENCODE_CONFIG_DIR` and `VIBE2API_BIN` override the two destinations.

## First run

Restart opencode, pick a `mistral-vibe/*` model, then:

```
/vibe-quota    used %, dollars left, reset date, configured keys
```

The key comes from `MISTRAL_VIBE_KEY`, the provider block's `apiKey`, the request's
`Authorization` header, or `~/.mistral-vibe/keys.json`. There is no `/login` command:
opencode reads the key from its own provider config.

## Models

| id | context | notes |
|---|---|---|
| `mistral-large-4-0` | 1M | reasoning, vision |
| `mistral-medium-latest` | 256k | reasoning, vision |
| `zai-glm-5-3` | 1M | reasoning |
| `zai-glm-5-3-flash` | 1M | reasoning, vision |
| `deepseek-v4-1-flash-1017` | 1M | reasoning, vision |

Thinking levels are clamped per model, so no `reasoningEffort` value gets a 422. A level the
model does not accept is floored to its weakest wire level rather than forwarded verbatim.

## How it runs

One server per user. It binds `127.0.0.1:8810` at module load, because opencode evaluates
plugin modules and the provider block's `baseURL` is a constant. The port is fixed: walking
ports would point the provider at nothing.

A second opencode process finds 8810 answering `/health` with
`service: "mistral-vibe-opencode"` and reuses that server. A listener answering with anything
else is reported, never taken over; `MISTRAL_VIBE_OC_PORT` moves both the bind and the
`baseURL`. The bound port is published to `~/.mistral-vibe/opencode-server.json` as
`{service, port, pid, startedAt}`, and `vibe-quota` reads it after confirming the service.

`GET /healthz` reports liveness without touching the network.

Upstream rejections are appended to `~/.mistral-vibe/opencode-errors.log` with the status,
model, effort, and error body, rolling to `.1` at 256 KiB.

## Configuration

| variable | default | meaning |
|---|---|---|
| `MISTRAL_VIBE_KEY` | unset | key to use when the request carries none |
| `MISTRAL_VIBE_OC_PORT` | `8810` | port to bind, and the port the provider block expects |
| `MISTRAL_VIBE_STATE_DIR` | `~/.mistral-vibe` | server file, error log |
| `MISTRAL_VIBE_VERSION` | `3.1.4` | version in the Vibe `User-Agent` |
| `MV_STREAM_IDLE_MS` | `300000` | abandon an upstream stream after this long with no data |
| `MISTRAL_BASE` | `https://api.mistral.ai` | upstream override |
| `VIBE_PROXY` | plugin port | proxy the quota script talks to |

Keys are read round-robin with a 10-minute cooldown. Only a 401/403 implicates a key; a 429
is capacity pressure and never disables one.

## Behaviour worth knowing

A turn whose whole output budget went to reasoning comes back as `finish_reason: "length"`
with no visible text. A tool call cut off by the output budget keeps
`finish_reason: "tool_calls"` with arguments ending mid-string. Both are retried at the next
lower `reasoning_effort` the model accepts, streaming and not. On a stream, only the finish
chunk and tool-call deltas are held back, so a retry is invisible unless text was already
shown.

Failures are reported by kind: no key 401, rejected key 401, capacity 429 with
`Retry-After: 60`, transient 5xx 502, unreachable upstream 502. `/api/state` exposes one-way
key fingerprints, never key material, and no response carries a wildcard CORS origin.

## Troubleshooting

`/vibe-quota` says no key: export `MISTRAL_VIBE_KEY` or set the provider's `apiKey`.
Provider missing from the model list: the plugin failed to load; start `opencode run` from a
terminal to see the error.
`port 8810 is held by another service`: something else owns the port. Set
`MISTRAL_VIBE_OC_PORT` and set the same value in the provider block's `baseURL`.
Chat works but quota fails: the key came from the request header only; set
`MISTRAL_VIBE_KEY` so the quota script can read it.

## Tests

```bash
bun test
```

26 tests against a mock upstream: health and catalog, typed-part flattening, effort clamping
and flooring, stream finish-chunk splitting, starved-turn recovery (both paths), truncated
tool calls (both paths), auth cooldown, capacity 429, transient error logging, the port
contract and state file, stream idle abort, 413 body drain, Origin guard, and key-fingerprint
hygiene.

## License

MIT
