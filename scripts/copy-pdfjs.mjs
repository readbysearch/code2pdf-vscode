// Copies what the PDF tab needs from pdfjs-dist into out/pdfjs (part of `npm run compile`).
// The legacy build, so it also runs in the oldest VS Code the extension supports (1.90).
import * as fs from "node:fs";
import * as path from "node:path";

const from = path.join("node_modules", "pdfjs-dist");
const to = path.join("out", "pdfjs");
const files = {
  "legacy/build/pdf.min.mjs": "pdf.min.mjs",
  "legacy/build/pdf.worker.min.mjs": "pdf.worker.min.mjs",
  "legacy/web/pdf_viewer.mjs": "pdf_viewer.mjs",
  "legacy/web/pdf_viewer.css": "pdf_viewer.css",
  LICENSE: "LICENSE",
};
/** Images the viewer's CSS uses for what the tab shows: the spinner while a page is drawn. */
const images = ["loading-icon.gif"];
fs.rmSync(to, { recursive: true, force: true });
fs.mkdirSync(to, { recursive: true });
for (const [source, target] of Object.entries(files)) {
  let text = fs.readFileSync(path.join(from, source), "utf8");
  // No source maps in the package: drop the comment that makes the webview ask for one
  text = text.replace(/\n\/\/# sourceMappingURL=\S+\s*$/, "\n");
  fs.writeFileSync(path.join(to, target), text);
}
fs.mkdirSync(path.join(to, "images"));
for (const image of images) {
  fs.copyFileSync(path.join(from, "legacy", "web", "images", image), path.join(to, "images", image));
}
