// The integration tests run in a real VS Code, opened on a small git project made here.
import { defineConfig } from "@vscode/test-cli";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "code2pdf-vscode-it-"));
const project = path.join(root, "shop");
const pdfs = path.join(root, "pdfs");

function write(file, text) {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}
function git(...args) {
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: project });
}

const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";
write("README.md", "# Shop\n\nA tiny shop for tests.\n");
write("src/app.py", lines(30, (i) => (i === 1 ? "def greet(name):" : i === 2 ? "    return 'hello ' + name" : `value_${i} = ${i}  # app line ${i}`)));
write("src/util.py", "def helper():\n    return 'util helper'\n");
write("tests/test_app.py", "def test_greet():\n    assert 'tested greeting'\n");
write("data.json", '{"json_marker": true}\n');
write(".vscode/settings.json", JSON.stringify({ "code2pdf.outputFolder": pdfs, "code2pdf.openWith": "none" }, null, 2));
let hasGit = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  hasGit = false;  // a fresh Ubuntu desktop has no git: the fresh-machine test doesn't need it
}
if (hasGit) {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project });
  git("add", ".");
  git("commit", "-qm", "first");
  write("src/app.py", fs.readFileSync(path.join(project, "src/app.py"), "utf8").replace("value_20 = 20", "value_20 = 'changed in commit two'"));
  git("commit", "-qam", "Change value 20");
}
write("src/util.py", "def helper():\n    return 'util helper, edited but not committed'\n");

// A fresh user-data folder each run, so user settings a test changes (or a killed run left
// behind) can't reach the next run. Short path: macOS limits the socket path inside to 103 bytes.
const userData = path.resolve(".vscode-test", "ud");
fs.rmSync(userData, { recursive: true, force: true });

export default defineConfig({
  files: process.env.CODE2PDF_TEST_FILES || "out/test/integration/**/*.test.js",
  version: process.env.VSCODE_TEST_VERSION || "stable",
  workspaceFolder: project,
  launchArgs: ["--disable-extensions", "--disable-workspace-trust", "--user-data-dir", userData,
    // Containers usually can't give Chromium its sandbox
    ...(process.env.CODE2PDF_TEST_NO_SANDBOX ? ["--no-sandbox", "--disable-gpu"] : [])],
  env: { CODE2PDF_TEST_PDFS: pdfs },
  mocha: { ui: "bdd", timeout: 120000 },
});
