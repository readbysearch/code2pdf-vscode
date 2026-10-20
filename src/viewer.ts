// The PDF tab: a custom editor whose webview runs pdf.js (out/pdfjs, copied from pdfjs-dist by
// scripts/copy-pdfjs.mjs). VS Code can't show a PDF by itself. The extension reads the file and
// sends its bytes, which works over Remote SSH and in WSL too, and sends them again when the
// file changes, such as when it's printed again.

import { randomBytes } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";

export const VIEW_TYPE = "code2pdf.pdf";

/** Pages in each PDF once its tab has drawn the first one, by path. Tests wait for it. */
export const rendered = new Map<string, number>();
/** What went wrong in a PDF's tab, by path, for tests to say. */
export const failures = new Map<string, string>();

class PdfDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}
  dispose(): void {}
}

/** The tab's page, for one PDF: the webview with its controls, and what to say in it. */
export function html(webview: vscode.Webview, pdfjs: vscode.Uri, media: vscode.Uri, remote: boolean): string {
  const nonce = randomBytes(16).toString("base64");
  const src = (base: vscode.Uri, file: string) => webview.asWebviewUri(vscode.Uri.joinPath(base, file)).toString();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} blob: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} blob: data:`,
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    // pdf.js's worker runs from a blob: a worker can't start from the webview's resource origin
    "worker-src blob:",
    `connect-src ${webview.cspSource}`,
  ].join("; ");
  const config = { pdfjs: src(pdfjs, "pdf.min.mjs"), worker: src(pdfjs, "pdf.worker.min.mjs"), viewer: src(pdfjs, "pdf_viewer.mjs") };
  const reveal = process.platform === "darwin" ? "Reveal in Finder" : "Show in Folder";
  const fileButtons = remote
    ? `<button id="copyPath" title="Copy the PDF's path on the remote machine">Copy Path</button>`
    : `<button id="external" title="Open the PDF in your computer's PDF viewer, to print it on paper">Open in Default App</button>
    <button id="reveal">${reveal}</button>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${src(pdfjs, "pdf_viewer.css")}">
<link rel="stylesheet" href="${src(media, "viewer.css")}">
</head>
<body>
<div id="toolbar">
  <button id="previous" title="Previous Page" aria-label="Previous page">&#x2039;</button>
  <input id="page" type="number" min="1" value="1" aria-label="Page"><span id="count"></span>
  <button id="next" title="Next Page" aria-label="Next page">&#x203A;</button>
  <span class="separator"></span>
  <button id="zoomOut" title="Zoom Out" aria-label="Zoom out">&#x2212;</button>
  <select id="scale" aria-label="Zoom">
    <option value="page-width">Page Width</option>
    <option value="page-fit">Whole Page</option>
    <option value="0.5">50%</option>
    <option value="0.75">75%</option>
    <option value="1">100%</option>
    <option value="1.25">125%</option>
    <option value="1.5">150%</option>
    <option value="2">200%</option>
    <option value="custom" hidden></option>
  </select>
  <button id="zoomIn" title="Zoom In" aria-label="Zoom in">+</button>
  <span class="spacer"></span>
  ${fileButtons}
</div>
<div id="viewerContainer" tabindex="0"><div id="viewer" class="pdfViewer"></div></div>
<div id="message" role="alert" hidden></div>
<script nonce="${nonce}">
  // Before viewer.js, so even its failing to load is reported
  globalThis.vscode = acquireVsCodeApi();
  const report = (message) => globalThis.vscode.postMessage({ type: "failed", message: String(message) });
  addEventListener("error", (event) => report(event.message || \`couldn't load \${event.target?.src ?? event.target?.href ?? "a file"}\`), true);
  addEventListener("unhandledrejection", (event) => report(event.reason?.message ?? event.reason));
</script>
<script nonce="${nonce}" id="config" type="application/json">${JSON.stringify(config).replace(/</g, "\\u003c")}</script>
<script nonce="${nonce}" type="module" src="${src(media, "viewer.js")}"></script>
</body>
</html>`;
}

export class PdfViewer implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
  /** The tabs showing each PDF, and the file's modification time each last got. */
  private readonly tabs = new Map<string, Map<vscode.WebviewPanel, number>>();

  constructor(private readonly extensionUri: vscode.Uri, private readonly log: (line: string) => void) {}

  openCustomDocument(uri: vscode.Uri): PdfDocument {
    return new PdfDocument(uri);
  }

  resolveCustomEditor(document: PdfDocument, panel: vscode.WebviewPanel): void {
    const uri = document.uri;
    const pdfjs = vscode.Uri.joinPath(this.extensionUri, "out", "pdfjs");
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    panel.webview.options = { enableScripts: true, localResourceRoots: [pdfjs, media] };
    panel.webview.html = html(panel.webview, pdfjs, media, Boolean(vscode.env.remoteName));
    const key = uri.toString();
    const tabs = this.tabs.get(key) ?? new Map<vscode.WebviewPanel, number>();
    this.tabs.set(key, tabs);
    tabs.set(panel, -1);

    // Printed again from a terminal, say: show the new PDF
    const folder = vscode.Uri.file(path.dirname(uri.fsPath));
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, path.basename(uri.fsPath)));
    let timer: NodeJS.Timeout | undefined;
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void this.send(panel, uri, false), 300);
    };
    const subscriptions = [watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed)];

    subscriptions.push(panel.webview.onDidReceiveMessage((message: { type: string; pages?: number; message?: string }) => {
      if (message.type === "ready") {
        void this.send(panel, uri, true);
      } else if (message.type === "rendered") {
        rendered.set(uri.fsPath, message.pages ?? 0);
      } else if (message.type === "failed") {
        failures.set(uri.fsPath, message.message ?? "");
        this.log(`The PDF tab couldn't show ${uri.fsPath}: ${message.message ?? ""}`);
      } else if (message.type === "external") {
        void vscode.env.openExternal(uri);
      } else if (message.type === "reveal") {
        void vscode.commands.executeCommand("revealFileInOS", uri);
      } else if (message.type === "copyPath") {
        void vscode.env.clipboard.writeText(uri.fsPath);
      }
    }));
    panel.onDidDispose(() => {
      clearTimeout(timer);
      subscriptions.forEach((s) => s.dispose());
      tabs.delete(panel);
      if (!tabs.size) {
        this.tabs.delete(key);
      }
    });
  }

  /** Shows the PDF in a tab: the one it's in already (with the new file), or a new one. */
  async open(uri: vscode.Uri): Promise<void> {
    for (const panel of this.tabs.get(uri.toString())?.keys() ?? []) {
      await this.send(panel, uri, false);
    }
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE, { preview: false });
  }

  /** Sends the file to the tab, unless it has this version already (and FORCE is false). */
  private async send(panel: vscode.WebviewPanel, uri: vscode.Uri, force: boolean): Promise<void> {
    const tabs = this.tabs.get(uri.toString());
    try {
      const { mtime } = await vscode.workspace.fs.stat(uri);
      if (!force && tabs?.get(panel) === mtime) {
        return;
      }
      tabs?.set(panel, mtime);
      // A plain Uint8Array, not the Node Buffer readFile gives: postMessage sends that as JSON
      const bytes = new Uint8Array(await vscode.workspace.fs.readFile(uri));
      await panel.webview.postMessage({ type: "load", bytes });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await panel.webview.postMessage({ type: "error", message: `${path.basename(uri.fsPath)} can't be read: ${message}` });
    }
  }
}
