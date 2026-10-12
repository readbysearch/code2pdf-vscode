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

/** Shell integration (VS Code 1.93+, not in this extension's 1.90 types): what ran in the terminal. */
interface Execution {
  commandLine: { value: string };
  read(): AsyncIterable<string>;
}
interface ShellEvents {
  onDidStartTerminalShellExecution?: vscode.Event<{ terminal: vscode.Terminal; execution: Execution }>;
  onDidEndTerminalShellExecution?: vscode.Event<{ execution: Execution; exitCode: number | undefined }>;
}

/**
 * Logs every command run in a terminal, its output and exit code, and answers y to a [y/n]
 * question as the user would (Homebrew 7 asks before installing; apt asks to continue).
 * failed() says if a command failed.
 */
function watchTerminals(): { failed: () => string | undefined; started: () => boolean | undefined; dispose: () => void } {
  const events = vscode.window as unknown as ShellEvents;
  const subscriptions: vscode.Disposable[] = [];
  let failure: string | undefined;
  let started = false;
  if (events.onDidStartTerminalShellExecution) {
    subscriptions.push(events.onDidStartTerminalShellExecution(async ({ terminal, execution }) => {
      started = true;
      console.log(`[terminal] $ ${execution.commandLine.value}`);
      let tail = "";
      for await (const data of execution.read()) {
        // eslint-disable-next-line no-control-regex
        const text = data.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "");
        process.stdout.write(text);
        tail = (tail + text).slice(-300);
        if (/\[(y\/n|Y\/n|y\/N)\]\s*$/.test(tail)) {
          console.log("\n[terminal] (the test types y, as the user would)");
          terminal.sendText("y");
          tail = "";
        }
      }
    }));
  } else {
    console.log("[terminal] no shell integration events in this VS Code");
  }
  if (events.onDidEndTerminalShellExecution) {
    subscriptions.push(events.onDidEndTerminalShellExecution(({ execution, exitCode }) => {
      console.log(`[terminal] exit ${exitCode}: ${execution.commandLine.value}`);
      if (exitCode !== undefined && exitCode !== 0) {
        failure = `"${execution.commandLine.value}" exited with ${exitCode}`;
      }
    }));
  }
  return {
    failed: () => failure,
    /** Whether a command started; undefined without shell integration events (can't tell). */
    started: () => (events.onDidStartTerminalShellExecution ? started : undefined),
    dispose: () => subscriptions.forEach((d) => d.dispose()),
  };
}

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
    this.timeout(12 * 60_000);
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
      // Click the install button: CODE2PDF_TEST_CLICK picks one by name, else the first
      const want = process.env.CODE2PDF_TEST_CLICK;
      return Promise.resolve(want ? buttons.find((b) => b.startsWith(want)) : buttons[0]);
    };
    window.showInformationMessage = (message: string, ...buttons: string[]) => {
      infos.push(message);
      console.log(`[info] ${message} [${buttons.join(" | ")}]`);
      return Promise.resolve(buttons.includes("Print Now") ? "Print Now" : undefined);  // click Print Now
    };
    const terminals = watchTerminals();
    try {
      const first = await vscode.commands.executeCommand<string>("code2pdf.printFile", vscode.Uri.file(path.join(project, "src/util.py")));
      assert.equal(first, undefined, "nothing printed before code2pdf is installed");
      assert.match(warnings[0]?.message ?? "", /isn't installed/);
      const want = process.env.CODE2PDF_TEST_CLICK;
      assert.ok(!want || warnings[0].buttons.some((b) => b.startsWith(want)), `no "${want}" button: ${warnings[0].buttons.join(", ")}`);
      console.log(`Clicked "${want ? warnings[0].buttons.find((b) => b.startsWith(want)) : warnings[0].buttons[0]}"; waiting for the terminal to install code2pdf…`);
      const started = Date.now();
      let lastReport = started;
      // A good install takes 1-3 minutes (Homebrew on a CI runner: ~2)
      while (!fs.existsSync(pdf) && !terminals.failed() && Date.now() - started < 10 * 60_000) {
        await new Promise((r) => setTimeout(r, 2000));
        assert.ok(terminals.started() !== false || Date.now() - started < 2 * 60_000,
          "after 2 minutes, nothing has run in the terminal");
        if (Date.now() - lastReport > 60_000) {
          lastReport = Date.now();
          const t = vscode.window.terminals.map((x) => `${x.name} (exit ${x.exitStatus?.code ?? "-"}, shell integration ${"shellIntegration" in x && x.shellIntegration ? "on" : "off"})`);
          console.log(`… ${Math.round((Date.now() - started) / 1000)} s; terminals: ${t.join(", ") || "none"}`);
        }
      }
      assert.equal(terminals.failed(), undefined, "the install command failed");
      console.log(`PDF after ${Math.round((Date.now() - started) / 1000)} s: ${fs.existsSync(pdf)}`);
    } finally {
      terminals.dispose();
      window.showWarningMessage = original.warning;
      window.showInformationMessage = original.info;
    }
    assert.ok(infos.some((m) => /^code2pdf \S+ is installed\.$/.test(m)), `said it's ready: ${infos.join(" | ")}`);
    assert.ok(fs.existsSync(pdf), "Print Now printed the file");
    const text = execFileSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf8" });
    assert.match(text, /util helper/);
  });
});
