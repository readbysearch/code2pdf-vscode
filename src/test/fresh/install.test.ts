// A user's first print on a machine without code2pdf, for real: the extension offers to install
// it, the install command runs in VS Code's terminal, and Print Now prints once it's ready.
// Only the two clicks are simulated. Run on a machine (or container) without code2pdf:
//   CODE2PDF_TEST_FILES='out/test/fresh/*.test.js' npx vscode-test
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

type Window = Record<string, unknown>;

function onPath(command: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("first print without code2pdf (fresh machine)", () => {
  it("offers the install, runs it in the terminal, then prints", async function () {
    this.timeout(30 * 60_000);
    assert.ok(!onPath("code2pdf") && !fs.existsSync("/opt/homebrew/bin/code2pdf"), "this machine must not have code2pdf yet");
    await vscode.extensions.getExtension("readbysearch.code2pdf")?.activate();
    const project = (vscode.workspace.workspaceFolders ?? [])[0].uri.fsPath;
    const pdf = path.join(process.env.CODE2PDF_TEST_PDFS ?? "", "util.pdf");

    const window = vscode.window as unknown as Window;
    const original = { warning: window.showWarningMessage, info: window.showInformationMessage };
    const warnings: { message: string; buttons: string[] }[] = [];
    const infos: string[] = [];
    window.showWarningMessage = (message: string, ...buttons: string[]) => {
      warnings.push({ message, buttons });
      console.log(`[warning] ${message} [${buttons.join(" | ")}]`);
      return Promise.resolve(buttons[0]);  // click the install button
    };
    window.showInformationMessage = (message: string, ...buttons: string[]) => {
      infos.push(message);
      console.log(`[info] ${message} [${buttons.join(" | ")}]`);
      return Promise.resolve(buttons.includes("Print Now") ? "Print Now" : undefined);  // click Print Now
    };
    try {
      const first = await vscode.commands.executeCommand<string>("code2pdf.printFile", vscode.Uri.file(path.join(project, "src/util.py")));
      assert.equal(first, undefined, "nothing printed before code2pdf is installed");
      assert.match(warnings[0]?.message ?? "", /isn't installed/);
      console.log(`Clicked "${warnings[0].buttons[0]}"; waiting for the terminal to install code2pdf…`);
      const started = Date.now();
      while (!fs.existsSync(pdf) && Date.now() - started < 28 * 60_000) {
        await new Promise((r) => setTimeout(r, 2000));
      }
      console.log(`PDF after ${Math.round((Date.now() - started) / 1000)} s: ${fs.existsSync(pdf)}`);
    } finally {
      window.showWarningMessage = original.warning;
      window.showInformationMessage = original.info;
    }
    assert.ok(infos.some((m) => /^code2pdf \S+ is installed\.$/.test(m)), `said it's ready: ${infos.join(" | ")}`);
    assert.ok(fs.existsSync(pdf), "Print Now printed the file");
    const text = execFileSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf8" });
    assert.match(text, /util helper/);
  });
});
