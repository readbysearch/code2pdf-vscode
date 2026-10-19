#!/bin/bash
# The release check for usage data, against Azure. Unit tests check the sender, and VS Code sends
# nothing under test or while debugging, so this is the only check of what really arrives:
#   1. the Azure resources still do what PRIVACY.md says (in the EU, kept 90 days, IP addresses
#      not stored), and src/telemetry.ts sends to the real one;
#   2. Azure works out no location for the extension's events: one with its tags arrives without
#      a city or country, and the same one without ai.location.ip arrives with them (so the test
#      resource keeps your city for 90 days);
#   3. the packaged extension, installed in a separate VS Code with its own profile (yours isn't
#      touched) and printing one file, sends `activated` and `print` with the expected fields and
#      no path, and sends nothing when VS Code's telemetry or code2pdf.telemetry is off.
# Everything goes to code2pdf-vscode-test (the package is rebuilt to send there), never into the
# real numbers. Needs `az login` (see test/azure-setup.sh) and macOS, or Linux with a display.
# Opens VS Code three times, about 20 s each, then waits a few minutes for Azure.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
GROUP=code2pdf
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }
T="$(mktemp -d /tmp/c2p.XXXXXX)"   # short: VS Code's socket in the profile must fit in 103 characters
trap 'rm -rf "$T"' EXIT
START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
MARKER="check-$(date -u +%Y%m%d%H%M%S)"
VERSION="$(node -p 'require("./package.json").version')"
npm run --silent compile

# 1. The resources
app() { az monitor app-insights component show --app "$1" --resource-group "$GROUP" -o json 2>/dev/null; }
REAL="$(app code2pdf-vscode)" && TEST="$(app code2pdf-vscode-test)" || fail "no Azure resources: run az login, then test/azure-setup.sh"
[ "$(jq -r .location <<<"$REAL")" = swedencentral ] || fail "the resource isn't in Sweden Central, as PRIVACY.md says"
[ "$(jq -r '.disableIpMasking // false' <<<"$REAL")" = false ] || fail "IP masking is off, so Azure stores IP addresses"
[ "$(node -p 'require("./out/telemetry").CONNECTION_STRING')" = "$(jq -r .connectionString <<<"$REAL")" ] ||
  fail "src/telemetry.ts doesn't send to code2pdf-vscode"
WS="$(az monitor log-analytics workspace show --resource-group "$GROUP" --workspace-name code2pdf-logs -o json 2>/dev/null)"
[ "$(jq -r .retentionInDays <<<"$WS")" = 90 ] || fail "the workspace doesn't keep data 90 days"
jq -e '.workspaceCapping.dailyQuotaGb > 0 and .workspaceCapping.dailyQuotaGb <= 0.16' <<<"$WS" >/dev/null ||
  fail "no daily cap that keeps a month inside the free 5 GB"
total="$(az monitor log-analytics workspace table show --resource-group "$GROUP" --workspace-name code2pdf-logs \
  --name AppEvents --query totalRetentionInDays -o tsv 2>/dev/null)"
[ "$total" = 90 ] || fail "events are kept $total days in all, not 90"
ok "the Azure resources match PRIVACY.md, and src/telemetry.ts sends to code2pdf-vscode"

# 2. The location check's two events
CONNECTION_STRING="$(jq -r .connectionString <<<"$TEST")" node test/usage-data/location.js "$ROOT/out/telemetry.js" "$MARKER"

# 3. The package, sending to the test resource, and a helper extension that prints with it
npx --no-install vsce package --out "$T/real.vsix" >/dev/null
REAL_CS="$(jq -r .connectionString <<<"$REAL")" TEST_CS="$(jq -r .connectionString <<<"$TEST")" \
  python3 -I - "$T/real.vsix" "$T/code2pdf.vsix" <<'EOF'
import os, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as old, zipfile.ZipFile(sys.argv[2], "w", zipfile.ZIP_DEFLATED) as new:
    for item in old.infolist():
        data = old.read(item.filename)
        if item.filename == "extension/out/telemetry.js":
            text = data.decode()
            if text.count(os.environ["REAL_CS"]) != 1:
                sys.exit("the connection string isn't in the package's telemetry.js exactly once")
            data = text.replace(os.environ["REAL_CS"], os.environ["TEST_CS"]).encode()
        new.writestr(item, data)
EOF
mkdir "$T/driver" && cp test/usage-data/driver/* "$T/driver/" && printf '# code2pdf check\n' > "$T/driver/README.md"
(cd "$T/driver" && "$ROOT/node_modules/.bin/vsce" package --allow-missing-repository --skip-license --out "$T/driver.vsix" >/dev/null)
CODE="$(node -e 'require("@vscode/test-electron").downloadAndUnzipVSCode({ cachePath: ".vscode-test" }).then((p) => console.log(p))' | tail -1)"
CLI="$(node -p 'require("@vscode/test-electron").resolveCliPathFromVSCodeExecutablePath(process.argv[1])' "$CODE")"
for vsix in "$T/code2pdf.vsix" "$T/driver.vsix"; do
  "$CLI" --user-data-dir "$T/u" --extensions-dir "$T/x" --install-extension "$vsix" >/dev/null 2>&1
done
mkdir -p "$T/p" "$T/u/User"
printf 'def hello():\n    return "the usage data check"\n' > "$T/p/hello.py"

run() {  # run NAME SETTINGS: one VS Code session that prints hello.py; prints isTelemetryEnabled
  local name=$1 pid i
  jq -n --arg dir "$T" --arg name "$1" --argjson extra "$2" '{
    "code2pdf.outputFolder": "\($dir)/pdf-\($name)", "code2pdf.openWith": "none",
    "code2pdfCheck.file": "\($dir)/p/hello.py", "code2pdfCheck.result": "\($dir)/\($name).json",
    "security.workspace.trust.enabled": false, "extensions.autoUpdate": false,
    "extensions.autoCheckUpdates": false, "update.mode": "none", "workbench.startupEditor": "none",
    "workbench.welcomePage.walkthroughs.openOnInstall": false } + $extra' > "$T/u/User/settings.json"
  "$CODE" --user-data-dir "$T/u" --extensions-dir "$T/x" --new-window "$T/p" > "$T/$name.log" 2>&1 &
  pid=$!
  for i in $(seq 1 60); do [ -f "$T/$name.json" ] && break; sleep 2; done
  for i in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill "$pid" 2>/dev/null || true
  [ -f "$T/$name.json" ] || fail "$name: the print didn't finish. VS Code said: $(tail -5 "$T/$name.log")"
  jq -e --arg v "$VERSION" '.code2pdf == $v and (.pdf // "" | length > 0)' "$T/$name.json" >/dev/null ||
    fail "$name: $(cat "$T/$name.json")"
  jq -r .telemetryEnabled "$T/$name.json"
}
[ "$(run vscode-off '{"telemetry.telemetryLevel": "off"}')" = false ] || fail "VS Code's telemetry was on in the run with it off"
[ "$(run code2pdf-off '{"telemetry.telemetryLevel": "all", "code2pdf.telemetry": false}')" = true ] || fail "VS Code's telemetry was off"
[ "$(run on '{"telemetry.telemetryLevel": "all"}')" = true ] || fail "VS Code's telemetry was off"
ok "the package printed in VS Code $(jq -r .version "$(dirname "$CLI")/../package.json" 2>/dev/null || echo) three times: telemetry off, code2pdf.telemetry off, both on"

# What arrived
query() {
  az monitor app-insights query --app code2pdf-vscode-test --resource-group "$GROUP" --analytics-query "$1" -o json 2>/dev/null |
    jq -c '.tables[0].columns as $c | .tables[0].rows[] | [$c, .] | transpose | map({(.[0].name): .[1]}) | add'
}
Q="customEvents | where timestamp > datetime($START) | project name, session_Id, user_Id, client_IP, client_City, client_CountryOrRegion, application_Version, customDimensions, customMeasurements"
echo "waiting for Azure (usually 2 to 5 minutes)…"
for i in $(seq 1 30); do
  EVENTS="$(query "$Q")"
  jq -se --arg v "$VERSION" --arg m "$MARKER" \
    '(map(select(.application_Version == $v)) | length) >= 2 and (map(select(.session_Id | startswith($m))) | length) >= 2' \
    <<<"$EVENTS" >/dev/null && break
  sleep 30
done
sleep 60   # anything the runs with usage data off sent, earlier, would be here by now
EVENTS="$(query "$Q")"
problems="$(jq -rs --arg m "$MARKER" --arg v "$VERSION" --arg t "$T" --arg home "$HOME" '
  (map(select(.session_Id == "\($m)-tagged")) | first) as $tagged
  | (map(select(.session_Id == "\($m)-control")) | first) as $control
  | map(select(.application_Version == $v)) as $ext
  | (if $tagged == null then "the location check'"'"'s tagged event never arrived"
     elif ($tagged.client_City + $tagged.client_CountryOrRegion) != "" then
       "Azure worked out a location despite ai.location.ip: \($tagged.client_City), \($tagged.client_CountryOrRegion)"
     else empty end),
    (if $control == null then "the location check'"'"'s control event never arrived"
     elif $control.client_CountryOrRegion == "" then "the control event has no location either, so the location check proves nothing"
     else empty end),
    ($ext | map(.session_Id) | unique | length | select(. != 1) | "\(.) VS Code sessions sent events, not 1: a run with usage data off sent some"),
    ($ext | map(.name) | sort | select(. != ["activated", "print"]) | "the events were \(.), not activated and print"),
    ($ext[] | select(.user_Id != "" or .client_IP != "0.0.0.0" or (.client_City + .client_CountryOrRegion) != "")
       | "\(.name) has a user ID, an IP address or a location"),
    ($ext[] | .name as $event | .customDimensions | fromjson | to_entries[]
       | select(.value | tostring | contains("hello") or contains($t) or contains($home)) | "\($event).\(.key) holds a path or file name"),
    ($ext[] | select(.name == "print") | .customDimensions | fromjson | select(.outcome != "printed" or .kind != "file") | "print: \(.)"),
    ($ext[] | select(.name == "activated") | .customDimensions | fromjson | select(.extension != $v or .cli != "found") | "activated: \(.)")
' <<<"$EVENTS")"
[ -z "$problems" ] || fail "$problems"
ok "no location for the extension's events (the control event got one), and no user ID or path"
ok "one session sent activated and print; nothing came from the runs with usage data off"
echo "All usage-data checks passed."
