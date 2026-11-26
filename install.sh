#!/usr/bin/env bash
# Install the Mistral Vibe provider + /vibe-quota into opencode from this repo.
#   1. plugin file into <config>/plugins/. It starts its own loopback server on
#      127.0.0.1:8810 when opencode loads it, so no proxy or Worker is needed.
#   2. provider block merged into <config>/opencode.jsonc
#   3. /vibe-quota command + the quota script on PATH
#
#   ./install.sh                      # ~/.config/opencode
#   OPENCODE_CONFIG_DIR=… ./install.sh
#   VIBE2API_BIN=… ./install.sh       # where vibe-quota lands
#   ./install.sh --dry-run            # print the plan, write nothing
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
cfg="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
bin="${VIBE2API_BIN:-${VIBE_QUOTA_BIN:-$HOME/.local/bin}}"
DRY=0

step() { printf '==> %s\n' "$*"; }
ok() { printf ' ok  %s\n' "$*"; }
note() { printf '     %s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

for a in "$@"; do
  case "$a" in
    -h|--help) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
    --dry-run) DRY=1 ;;
    *) die "unknown option: $a" ;;
  esac
done

# Every file this script overwrites is backed up first, so a re-run and a
# hand-edited config are both safe.
install_file() {
  local src="$1" dest="$2"
  if [ "$DRY" = 1 ]; then note "would copy $src -> $dest"; return 0; fi
  mkdir -p "$(dirname "$dest")"
  [ -f "$dest" ] && [ ! "$src" -ef "$dest" ] && cp "$dest" "$dest.bak-vibe2api"
  cp "$src" "$dest"
}

[ -d "$cfg" ] || die "opencode config dir not found: $cfg (create it, or set OPENCODE_CONFIG_DIR)"

step "plugin -> $cfg/plugins"
install_file "$here/plugins/mistral-vibe.ts" "$cfg/plugins/mistral-vibe.ts"
ok "$cfg/plugins/mistral-vibe.ts"

step "command -> $cfg/command"
install_file "$here/commands/vibe-quota.md" "$cfg/command/vibe-quota.md"
install_file "$here/bin/vibe-quota.sh" "$bin/vibe-quota"
[ "$DRY" = 1 ] || chmod +x "$bin/vibe-quota"
ok "$bin/vibe-quota"

step "provider block -> $cfg/opencode.jsonc"
conf="$cfg/opencode.jsonc"
if [ ! -f "$conf" ]; then
  if [ "$DRY" = 1 ]; then note "would create $conf"; else printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' > "$conf"; fi
fi
if [ "$DRY" = 1 ]; then
  note "would merge provider.mistral-vibe into $conf"
else
  python3 - "$conf" "$here/opencode.jsonc.example" <<'PY'
import json, shutil, sys
conf, example = sys.argv[1], sys.argv[2]
with open(conf) as f:
    data = json.load(f)
with open(example) as f:
    block = json.load(f)["provider"]["mistral-vibe"]
existing = data.get("provider", {}).get("mistral-vibe")
# The baseURL is ours by design (the plugin owns 8810); a stale remote endpoint
# from an older install is replaced too.
if existing == block:
    print("provider already present in", conf)
    raise SystemExit
shutil.copy(conf, conf + ".bak-vibe2api")
data.setdefault("provider", {})["mistral-vibe"] = block
with open(conf, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print("merged mistral-vibe provider into", conf, "(backup: opencode.jsonc.bak-vibe2api)")
PY
fi

step "next"
cat <<'EOF'
    restart opencode, pick a mistral-vibe/* model, then run /vibe-quota.
    Key: MISTRAL_VIBE_KEY, or the provider's apiKey in opencode.jsonc.
    The plugin binds 127.0.0.1:8810 on load; nothing else needs to run.
    Port taken? A second opencode process reuses a server that answers
    /health with service "mistral-vibe-opencode"; a foreign listener is
    reported instead. Set MISTRAL_VIBE_OC_PORT (and the provider baseURL).
    Bound port: ~/.mistral-vibe/opencode-server.json (vibe-quota reads it).
EOF
