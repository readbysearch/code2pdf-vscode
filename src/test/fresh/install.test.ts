// A user's first print on a machine without code2pdf, for real: the extension offers to install
// it, the install command runs in VS Code's terminal (on Windows: the download), and Print Now
// prints once it's ready. Only the two clicks are simulated. Run on a machine (or container) without code2pdf:
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

interface TerminalWatch {
  /** The command that failed, or what went wrong reading the terminal. */
  failed: () => string | undefined;
  /** Whether a command started; undefined without shell integration events (can't tell). */
  started: () => boolean | undefined;
  dispose: () => void;
}

/** Terminal output without colours, cursor moves and the shell integration's own marks. */
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

/**
 * Logs every command run in a terminal, its output and exit code, and answers y to a [y/n]
 * question as the user would (Homebrew 7 asks before installing; apt asks to continue).
 */
function watchTerminals(): TerminalWatch {
  const events = vscode.window as unknown as ShellEvents;
  const subscriptions: vscode.Disposable[] = [];
  let failure: string | undefined;
  let started = false;
  let disposed = false;
  if (events.onDidStartTerminalShellExecution) {
    subscriptions.push(events.onDidStartTerminalShellExecution(async ({ terminal, execution }) => {
      started = true;
      console.log(`[terminal] $ ${execution.commandLine.value}`);
      // The question is looked for in the last chunks together, cleaned as a whole: a chunk can
      // end inside an escape sequence. Homebrew cuts its lines to the terminal's width (about 60
      // columns in CI), so the question's start is matched, not only its [y/n].
      let tail = "";
      try {
        for await (const data of execution.read()) {
          if (disposed) {
            break;
          }
          process.stdout.write(plain(data));
          tail = (tail + data).slice(-600);
          if (/(\[(y\/n|Y\/n|y\/N)\]|Do you want to (proceed|continue))[^\n]*\s*$/.test(plain(tail))) {
            console.log("\n[terminal] (the test types y, as the user would)");
            terminal.sendText("y");
            tail = "";
          }
        }
      } catch (error) {
        failure = `reading the terminal failed: ${error instanceof Error ? error.message : String(error)}`;
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
    started: () => (events.onDidStartTerminalShellExecution ? started : undefined),
    dispose: () => {
      disposed = true;
      subscriptions.forEach((d) => d.dispose());
    },
  };
}

function onPath(command: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "sh", process.platform === "win32" ? [command] : ["-c", `command -v ${command}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Homebrew's own account of the install: whether the tap has a bottle (code2pdf pre-built) for
 * this machine, exactly or an older macOS's that Homebrew uses instead, and whether it poured one,
 * from the install's receipt.
 */
function homebrewPour(): { tag: string; bottled: boolean; exact: boolean; poured: boolean; builtOn: string } {
  const brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew", "/home/linuxbrew/.linuxbrew/bin/brew"].find((b) => fs.existsSync(b)) ?? "brew";
  const ruby = 'f = Formula["readbysearch/tap/code2pdf"]; t = Utils::Bottles.tag; '
    + "puts({ tag: t.to_s, bottled: f.bottled?, exact: f.bottle_specification.tag?(t, no_older_versions: true) }.to_json)";
  const bottle = JSON.parse(execFileSync(brew, ["ruby", "-rjson", "-e", ruby], { encoding: "utf8" }));
  const prefix = execFileSync(brew, ["--prefix", "readbysearch/tap/code2pdf"], { encoding: "utf8" }).trim();
  const receipt = JSON.parse(fs.readFileSync(path.join(prefix, "INSTALL_RECEIPT.json"), "utf8"));
  return { ...bottle, poured: receipt.poured_from_bottle === true, builtOn: receipt.built_on?.os_version ?? "?" };
}

describe("first print without code2pdf (fresh machine)", () => {
  it("offers the install, runs it in the terminal, then prints", async function () {
    this.timeout(12 * 60_000);
    const windowsBuild = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "code2pdf", "code2pdf.exe");
    assert.ok(!onPath("code2pdf") && !fs.existsSync("/opt/homebrew/bin/code2pdf") && !(process.platform === "win32" && fs.existsSync(windowsBuild)),
      "this machine must not have code2pdf yet");
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
    let clicked: string | undefined;
    try {
      const first = await vscode.commands.executeCommand<string>("code2pdf.printFile", vscode.Uri.file(path.join(project, "src/util.py")));
      assert.equal(first, undefined, "nothing printed before code2pdf is installed");
      assert.match(warnings[0]?.message ?? "", /isn't installed/);
      const want = process.env.CODE2PDF_TEST_CLICK;
      assert.ok(!want || warnings[0].buttons.some((b) => b.startsWith(want)), `no "${want}" button: ${warnings[0].buttons.join(", ")}`);
      clicked = want ? warnings[0].buttons.find((b) => b.startsWith(want)) : warnings[0].buttons[0];
      console.log(`Clicked "${clicked}"; waiting for code2pdf to be installed…`);
      const started = Date.now();
      let lastReport = started;
      // A good install takes 1-3 minutes (Homebrew on a CI runner: ~2)
      while (!fs.existsSync(pdf) && !terminals.failed() && Date.now() - started < 10 * 60_000) {
        await new Promise((r) => setTimeout(r, 2000));
        assert.ok(process.platform === "win32" || terminals.started() !== false || Date.now() - started < 2 * 60_000,
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

    if (clicked === "Install with Homebrew") {
      // The tap has bottles: Homebrew building code2pdf here (2-3 minutes) means this platform
      // lost its bottle, which nothing else would notice
      const pour = homebrewPour();
      console.log(`Homebrew: this machine is ${pour.tag}; the tap's bottle for it is ${pour.exact ? "there" : pour.bottled ? "an older macOS's" : "missing"}; `
        + `poured from a bottle: ${pour.poured}${pour.poured ? `, built on ${pour.builtOn}` : ""}`);
      if (pour.bottled) {
        assert.ok(pour.poured, `Homebrew built code2pdf from source though the tap has a bottle for ${pour.tag}`);
      }
      // CI runs on GitHub's newest macOS: the tap must bottle for it, or Homebrew quietly pours an older one
      if (process.env.GITHUB_ACTIONS) {
        assert.ok(pour.exact, `the tap has no ${pour.tag} bottle${pour.poured ? ` (Homebrew poured one built on ${pour.builtOn})` : ""}: add that macOS to the tap's CI`);
      }
    }
  });
});
