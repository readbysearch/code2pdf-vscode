// Manual check: does VS Code's terminal on this machine run the extension's install
// command? code2pdf is made to look missing; the real terminal runs the real brew command.
import { strict as assert } from "node:assert";
import * as vscode from "vscode";

interface Execution { commandLine: { value: string }; read(): AsyncIterable<string> }
interface ShellEvents {
  onDidStartTerminalShellExecution?: vscode.Event<{ execution: Execution }>;
  onDidEndTerminalShellExecution?: vscode.Event<{ execution: Execution; exitCode: number | undefined }>;
}

describe("terminal on macOS (manual)", () => {
  it("runs the install command", async function () {
    this.timeout(5 * 60_000);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cliModule = require("../../cli") as { find: (s: string) => Promise<unknown>; NotInstalled: new (l: string[], f: boolean) => Error };
    const realFind = cliModule.find;
    let ended: number | undefined | null = null;
    cliModule.find = () => (ended === null ? Promise.reject(new cliModule.NotInstalled(["code2pdf"], false)) : realFind(""));
    const events = vscode.window as unknown as ShellEvents;
    const subs: vscode.Disposable[] = [];
    console.log(`shell integration events: ${Boolean(events.onDidStartTerminalShellExecution)}`);
    subs.push(events.onDidStartTerminalShellExecution!(async ({ execution }) => {
      console.log(`[terminal] $ ${execution.commandLine.value}`);
      // eslint-disable-next-line no-control-regex
      for await (const d of execution.read()) { process.stdout.write(d.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "")); }
    }));
    subs.push(events.onDidEndTerminalShellExecution!(({ execution, exitCode }) => {
      console.log(`[terminal] exit ${exitCode}: ${execution.commandLine.value}`);
      ended = exitCode;
    }));
    const window = vscode.window as unknown as Record<string, unknown>;
    const orig = { w: window.showWarningMessage, i: window.showInformationMessage };
    window.showWarningMessage = (m: string, ...b: string[]) => { console.log(`[warning] ${m}`); return Promise.resolve(b[0]); };
    window.showInformationMessage = (m: string) => { console.log(`[info] ${m}`); return Promise.resolve(undefined); };
    await vscode.workspace.getConfiguration("code2pdf").update("executable", "", vscode.ConfigurationTarget.Global);
    try {
      await vscode.commands.executeCommand("code2pdf.printFile", vscode.Uri.file(`${(vscode.workspace.workspaceFolders ?? [])[0].uri.fsPath}/src/util.py`));
      const start = Date.now();
      while (ended === null && Date.now() - start < 4 * 60_000) {
        await new Promise((r) => setTimeout(r, 1000));
        if ((Date.now() - start) % 15000 < 1000) {
          console.log(`… ${Math.round((Date.now() - start) / 1000)} s: ${vscode.window.terminals.map((t) => `${t.name} exit=${t.exitStatus?.code} si=${Boolean((t as unknown as { shellIntegration?: unknown }).shellIntegration)}`).join(", ")}`);
        }
      }
      console.log(`ended: ${ended}`);
      assert.notEqual(ended, null, "the command ran to the end");
    } finally {
      subs.forEach((s) => s.dispose());
      cliModule.find = realFind;
      window.showWarningMessage = orig.w; window.showInformationMessage = orig.i;
      await vscode.workspace.getConfiguration("code2pdf").update("executable", undefined, vscode.ConfigurationTarget.Global);
    }
  });
});
