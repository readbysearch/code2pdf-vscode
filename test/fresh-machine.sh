#!/bin/bash
# Make this (fresh, throwaway) Ubuntu look like a desktop without code2pdf: wget and python3,
# no curl, no git. Then run the first-print test as a normal user, in a real VS Code under Xvfb:
# the extension offers the install, the command runs in VS Code's terminal, Print Now prints.
# Run as root in a container, from the repository:
#   docker run --rm -v "$PWD:/src:ro" ubuntu:24.04 bash /src/test/fresh-machine.sh
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
libs=""
for p in libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0 libasound2; do  # 24.04 renamed these to …t64
  if apt-cache show "${p}t64" >/dev/null 2>&1; then libs="$libs ${p}t64"; else libs="$libs $p"; fi
done
# What a desktop has (not curl or git), the libraries VS Code needs, and pdftotext for the test
apt-get install -y -qq --no-install-recommends sudo wget python3 ca-certificates xz-utils xvfb xauth dbus-x11 \
  libnss3 libgbm1 libxss1 libsecret-1-0 libxkbfile1 libdrm2 libxshmfence1 libpango-1.0-0 libpangoft2-1.0-0 \
  fonts-dejavu-core poppler-utils $libs >/dev/null
# Node, only to run the test harness
arch=$(dpkg --print-architecture); [ "$arch" = amd64 ] && arch=x64
wget -q "https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-$arch.tar.xz" -O /tmp/node.tar.xz
tar -xJf /tmp/node.tar.xz -C /opt && ln -sf /opt/node-v22.20.0-linux-$arch/bin/* /usr/local/bin/
# The user. apt's "Do you want to continue?" is answered yes, standing in for typing it
id tester >/dev/null 2>&1 || useradd -m -s /bin/bash tester
echo "tester ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/tester
echo 'APT::Get::Assume-Yes "true";' > /etc/apt/apt.conf.d/90yes
rm -rf /home/tester/ext && mkdir -p /home/tester/ext
tar -C "$SRC" --exclude=./node_modules --exclude=./out --exclude=./.vscode-test --exclude='./*.vsix' -cf - . | tar -C /home/tester/ext -xf -
chown -R tester:tester /home/tester/ext
echo "== $(. /etc/os-release; echo "$PRETTY_NAME"), $(uname -m)"
for c in code2pdf curl git wget python3; do printf "  %-8s %s\n" "$c" "$(command -v "$c" || echo missing)"; done
su - tester -c 'set -o pipefail; cd ~/ext && npm ci --no-audit --no-fund --loglevel=error >/dev/null && npx tsc -p . &&
  CODE2PDF_TEST_FILES="out/test/fresh/*.test.js" CODE2PDF_TEST_NO_SANDBOX=1 xvfb-run -a npx vscode-test 2>&1 |
  grep -E "^\[(warning|info|terminal)\]|^…|Clicked|PDF after|passing|failing|Error|^\s+[0-9]+\) |✔|✗"'
echo "== code2pdf now: $(su - tester -c 'command -v code2pdf || ls ~/.local/bin/code2pdf' 2>/dev/null || echo missing)"
