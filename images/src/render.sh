#!/bin/bash
# Renders the icon (and README images) from the files here. Needs WeasyPrint and poppler.
# Usage: images/src/render.sh  (from the repository root)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
python="${PYTHON:-python3}"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
"$python" - "$here/icon.svg" "$tmp/icon.pdf" <<'PY'
import sys, weasyprint
svg, out = sys.argv[1:]
html = f'<style>@page {{ size: 256px 256px; margin: 0 }} body {{ margin: 0 }}</style><img src="file://{svg}" style="width:256px;height:256px;display:block">'
weasyprint.HTML(string=html).write_pdf(out)
PY
pdftocairo -png -transp -singlefile -scale-to 256 "$tmp/icon.pdf" "$here/../icon"
echo "wrote images/icon.png"
