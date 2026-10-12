#!/bin/bash
# Inside the container: a 1280x800 virtual screen, and VS Code with this extension and a PDF viewer,
# with settings that keep the screen clean (PDFs open in a VS Code tab). record.py starts VS Code.
set -euo pipefail
export DISPLAY=:99
export XCURSOR_THEME=DMZ-White XCURSOR_SIZE=24
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
sleep 1
matchbox-window-manager -use_titlebar no >/tmp/wm.log 2>&1 &
mkdir -p ~/.config/Code/User ~/printouts
cat > ~/.config/Code/User/settings.json <<'JSON'
{
  "workbench.colorTheme": "Default Light Modern",
  "window.zoomLevel": 1,
  "editor.fontFamily": "DejaVu Sans Mono",
  "editor.fontSize": 13,
  "editor.minimap.enabled": false,
  "breadcrumbs.enabled": false,
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
  "workbench.welcomePage.walkthroughs.openOnInstall": false,
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "workbench.layoutControl.enabled": false,
  "workbench.editor.enablePreview": false,
  "window.commandCenter": false,
  "window.restoreWindows": "none",
  "chat.disableAIFeatures": true,
  "chat.commandCenter.enabled": false,
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "extensions.autoUpdate": false,
  "extensions.autoCheckUpdates": false,
  "extensions.ignoreRecommendations": true,
  "security.workspace.trust.enabled": false,
  "git.openRepositoryInParentFolders": "never",
  "scm.defaultViewMode": "list",
  "files.simpleDialog.enable": true,
  "code2pdf.outputFolder": "/home/demo/printouts",
  "code2pdf.openWith": "editor"
}
JSON
code --install-extension /ext.vsix --force >/tmp/install.log 2>&1
code --install-extension tomoki1207.pdf --force >>/tmp/install.log 2>&1
