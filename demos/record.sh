#!/bin/bash
# Records the README's demo GIFs into images/ (needs Docker; a few minutes). Usage, from the
# repository: npx vsce package && demos/record.sh [hero|folder|choose|selection|changes ...]
set -euo pipefail
cd "$(dirname "$0")/.."
VSIX="$(ls -t code2pdf-*.vsix | head -1)"
OUT="$(mktemp -d)"
git archive --format=tar --prefix=code2pdf-vscode/ HEAD > "$OUT/repo.tar"   # what the hero clip prints
docker build -q -t code2pdf-demos demos >/dev/null
docker rm -f code2pdf-demos >/dev/null 2>&1 || true
docker run -d --name code2pdf-demos --shm-size=2g -v "$PWD/demos:/demos:ro" -v "$PWD/$VSIX:/ext.vsix:ro" \
  -v "$OUT:/out" code2pdf-demos sleep infinity >/dev/null
trap 'docker rm -f code2pdf-demos >/dev/null' EXIT
docker exec code2pdf-demos bash /demos/desktop.sh
docker exec -e DEMO_SHOTS="${DEMO_SHOTS:-}" code2pdf-demos python3 /demos/record.py "$@"
cp "$OUT"/demo-*.gif images/
if [ -n "${DEMO_SHOTS:-}" ]; then cp "$OUT"/*.png "${DEMO_SHOTS}/"; fi   # DEMO_SHOTS=folder: screenshots too
ls -la images/demo-*.gif
