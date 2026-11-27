#!/usr/bin/env bash
# Runs the built-server checks from PATCHES.md against a t3 archive from build.sh.
# Usage: .fork/check-built-server.sh <archive>
# Starts a throwaway `t3 serve` with its own home and free ports, a fake keychain and a test site,
# and has a cheap Claude model drive the preview tools. Verdicts come from what the tools and the
# test site record, never from the agent's own report. Last stdout line: PASS or FAIL.
set -uo pipefail

archive=$(realpath "${1:?usage: check-built-server.sh <archive>}")
model=${T3_FORK_CHECK_MODEL:-claude-haiku-5-5}
export PATH="$HOME/.local/bin:$PATH"

work=$(mktemp -d "${TMPDIR:-/tmp}/t3-fork-check-XXXXXX")
mkdir -p "$work/app" "$work/bin" "$work/home" "$work/proj"
tar -xzf "$archive" -C "$work/app"
t3=$(find "$work/app" -mindepth 2 -maxdepth 2 -name t3 -type f | head -1)
# Claude Code keeps the agent's transcripts under a name derived from the project path.
transcripts="$HOME/.claude/projects/$(printf '%s' "$work/proj" | sed 's/[^A-Za-z0-9]/-/g')"

pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null; done
  wait 2>/dev/null
  rm -rf "$work" "$transcripts"
}
trap cleanup EXIT

# The agent needs Claude credentials. The live server has them in its environment.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  live=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).pid)' \
    "${T3CODE_HOME:-$HOME/.t3}/userdata/server-runtime.json" 2>/dev/null)
  CLAUDE_CODE_OAUTH_TOKEN=$(tr '\0' '\n' <"/proc/$live/environ" 2>/dev/null | sed -n 's/^CLAUDE_CODE_OAUTH_TOKEN=//p')
fi
[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || { echo "no CLAUDE_CODE_OAUTH_TOKEN"; echo FAIL; exit 1; }
export CLAUDE_CODE_OAUTH_TOKEN

free_port() { node -e 's=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
kc_port=$(free_port) site_port=$(free_port) t3_port=$(free_port)
password="Dummy-Pw-$RANDOM$RANDOM"
echo kc-test-token >"$work/kc-token"

cat >"$work/bin/fixtures.mjs" <<'EOF'
import http from "node:http";
const [kcPort, sitePort, password] = process.argv.slice(2);
const log = (line) => console.log(line);
// Every page reports typing and clicks back, so the checks see what reached the page.
const beacon = `<script>
addEventListener("input", () => navigator.sendBeacon("/event", "typed " + location.host), { once: true });
addEventListener("click", (e) => e.target.id === "target" && navigator.sendBeacon("/event", "clicked dpr=" + devicePixelRatio));
</script>`;
const page = (body) => `<!doctype html><html><head><title>Test login</title></head><body>${body}${beacon}</body></html>`;
const fields = `<label>Username <input name="username" autocomplete="username"></label>
<label>Password <input type="password" name="password" autocomplete="current-password"></label>
<button type="submit">Sign in</button>`;
const pages = {
  "/": page(`<h1>Sign in</h1><form method="post" action="/">${fields}</form>`),
  "/spa": page(`<h1>Sign in</h1><form id="f">${fields}</form><p id="s"></p>
<script>f.addEventListener("submit", (e) => { e.preventDefault(); s.textContent = "Signed in"; });</script>`),
  "/click": page(`<button id="target" style="position:absolute;left:420px;top:260px;width:160px;height:60px">Target</button>`),
};
http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (req.url === "/event") return log(`site: ${body}`), res.end();
    res.setHeader("content-type", "text/html");
    if (req.method === "POST") {
      const form = new URLSearchParams(body);
      const ok = form.get("username") === "demo" && form.get("password") === password;
      log(`site: login ${ok ? "ok" : "wrong"}`);
      return res.end(page(ok ? "<h1>Welcome demo</h1>" : "<h1>Wrong login</h1>"));
    }
    res.end(pages[new URL(req.url, "http://x").pathname] ?? page("<h1>Not found</h1>"));
  });
}).listen(Number(sitePort), "127.0.0.1");
http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const host = new URL(JSON.parse(body || "{}").url ?? "http://x").host;
    log(`keychain: ${host}`);
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== "Bearer kc-test-token") return (res.statusCode = 401), res.end("{}");
    if (host !== `127.0.0.1:${sitePort}`) return (res.statusCode = 403), res.end("{}");
    res.end(JSON.stringify({ username: "demo", password }));
  });
}).listen(Number(kcPort), "127.0.0.1");
EOF
node "$work/bin/fixtures.mjs" "$kc_port" "$site_port" "$password" >"$work/fixtures.log" 2>&1 &
pids+=($!)

server=""
start_server() { # extra env assignments as arguments
  env -u T3CODE_SERVER_BROWSER_SCALE -u T3CODE_SERVER_BROWSER_GPU \
    T3CODE_HOME="$work/home" T3CODE_SERVER_BROWSER_SANDBOX=0 \
    T3_KEYCHAIN_URL="http://127.0.0.1:$kc_port" T3_KEYCHAIN_TOKEN_FILE="$work/kc-token" "$@" \
    "$t3" serve --port "$t3_port" --host 127.0.0.1 --no-browser --base-dir "$work/home" "$work/proj" \
    >>"$work/serve.log" 2>&1 &
  server=$!
  pids+=("$server")
  for _ in $(seq 60); do
    curl -sf -o /dev/null "http://127.0.0.1:$t3_port/" && return 0
    sleep 1
  done
  echo "t3 serve did not come up"; tail -20 "$work/serve.log"; return 1
}
stop_server() { kill "$server"; wait "$server" 2>/dev/null || true; }
run_agent() { # message file
  (cd "$work/proj" && "$t3" thread start --base-dir "$work/home" --provider claudeAgent \
    --model "$model" --wait . - <"$1") >>"$work/agent.log" 2>&1
}

site="http://127.0.0.1:$site_port"
rules="This is an automated test of the T3 preview tools. Use only preview_* tools: no shell, no files. \
If a tool is refused, note it and go on with the next step. Use one tab throughout."
read -r -d '' render_eval <<'EOF'
(() => { const gl = document.createElement("canvas").getContext("webgl"); const ext = gl && gl.getExtension("WEBGL_debug_renderer_info"); return "dpr=" + devicePixelRatio + " gl=" + (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "none"); })()
EOF
click_steps="preview_navigate to $site/click, preview_snapshot, then preview_act action click with x and y \
set to the center of the Target button's box from the snapshot (do not use a locator). \
Then preview_evaluate: $render_eval"

cat >"$work/msg-default.txt" <<EOF
$rules
1. preview_open $site/ then preview_fill_credential (kind login).
2. preview_snapshot, preview_status, preview_wait_for text "Welcome", preview_evaluate "document.body.innerText".
3. preview_navigate to http://localhost:$site_port/ then preview_fill_credential.
4. preview_navigate to $site/spa, preview_fill_credential, preview_snapshot, preview_evaluate "1", preview_wait_for text "Signed in".
5. preview_navigate to $site/spa, preview_evaluate "document.title", preview_fill_credential.
6. $click_steps
EOF
cat >"$work/msg-scale.txt" <<EOF
$rules
1. preview_open $site/click
2. $click_steps
EOF

ok=1
start_server && "$t3" project add --base-dir "$work/home" "$work/proj" >>"$work/agent.log" 2>&1 &&
  run_agent "$work/msg-default.txt" && stop_server &&
  start_server T3CODE_SERVER_BROWSER_SCALE=1 && run_agent "$work/msg-scale.txt" && stop_server ||
  { echo "the test run itself failed"; ok=0; }

all=$(cat "$transcripts"/*.jsonl 2>/dev/null)
check() { # description, command
  if eval "$2"; then echo "pass  $1"; else echo "FAIL  $1"; ok=0; fi
}
has() { grep -qF -- "$1" <<<"$all"; }
site_log() { grep -qF -- "site: $1" "$work/fixtures.log"; }

check "the agent's transcripts were found" '[ -n "$(ls "$transcripts"/*.jsonl 2>/dev/null)" ]'
echo "--- preview_fill_credential"
check "a fill logs into the test page" 'site_log "login ok"'
check "a fill on another site is refused" 'has "The saved login is not for this site, so nothing was filled."'
check "nothing is typed on another site" '! site_log "typed localhost:"'
check "evaluate is off after a fill" 'has "preview_evaluate is off on this page after a saved-login fill attempt."'
check "text waits are off after a fill" 'has "Waiting for text is off on this page after a saved-login fill attempt."'
check "no fill after evaluate on the page" 'has "preview_evaluate ran on this page, so a saved login is not filled into it."'
check "the password is in no tool output or server data" \
  'grep -rqF -- "$password" "$transcripts" "$work/home" "$work/serve.log" "$work/agent.log"; [ $? = 1 ]'
echo "--- render scale and GPU"
check "unset: devicePixelRatio 2, SwiftShader" 'grep -qE "dpr=2 gl=[^\"]*SwiftShader" <<<"$all"'
check "unset: a click at snapshot coordinates hits" 'site_log "clicked dpr=2"'
check "scale 1: devicePixelRatio 1" 'has "dpr=1 gl="'
check "scale 1: a click at snapshot coordinates hits" 'site_log "clicked dpr=1"'

# The token count of the agent turns, for the report.
node -e '
const seen = new Map();
for (const line of require("fs").readFileSync(0, "utf8").split("\n")) {
  try { const m = JSON.parse(line).message; if (m?.id && m.usage) seen.set(m.id, m.usage); } catch {}
}
const sum = (k) => [...seen.values()].reduce((n, u) => n + (u[k] ?? 0), 0);
console.log(`agent usage (${process.argv[1]}): ${sum("input_tokens")} input, ${sum("output_tokens")} output, ` +
  `${sum("cache_read_input_tokens")} cache read, ${sum("cache_creation_input_tokens")} cache write`);
' "$model" <<<"$all"

if [ "$ok" = 1 ]; then echo PASS; else
  echo "--- agent"; tail -40 "$work/agent.log"; echo "--- site"; cat "$work/fixtures.log"; echo FAIL; exit 1
fi
