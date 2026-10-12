#!/bin/bash
# Records the README's demo GIFs into images/ (needs Docker; a few minutes). Usage, from the
# repository: npx vsce package && demos/record.sh [folder|choose|selection|changes ...]
set -euo pipefail
cd "$(dirname "$0")/.."
VSIX="$(ls -t code2pdf-*.vsix | head -1)"
OUT="$(mktemp -d)"
docker build -q -t code2pdf-demos demos >/dev/null
docker rm -f code2pdf-demos >/dev/null 2>&1 || true
docker run -d --name code2pdf-demos --shm-size=2g -v "$PWD/demos:/demos:ro" -v "$PWD/$VSIX:/ext.vsix:ro" \
  -v "$OUT:/out" code2pdf-demos sleep infinity >/dev/null
trap 'docker rm -f code2pdf-demos >/dev/null' EXIT
docker exec code2pdf-demos bash /demos/desktop.sh
docker exec code2pdf-demos python3 /demos/record.py "$@"
cp "$OUT"/demo-*.gif images/
ls -la images/demo-*.gif
