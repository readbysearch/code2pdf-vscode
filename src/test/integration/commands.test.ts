import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const project = () => (vscode.workspace.workspaceFolders ?? [])[0].uri.fsPath;
const uri = (rel: string) => vscode.Uri.file(path.join(project(), rel));

/** The PDF's text, page by page as pdftotext reads it. */
function text(pdf: string): string {
  return execFileSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf8" });
}

function printed(pdf: string | undefined): string {
  assert.ok(pdf, "the command returned a PDF path");
  assert.ok(fs.existsSync(pdf), `${pdf} exists`);
  assert.ok(path.dirname(pdf).startsWith(process.env.CODE2PDF_TEST_PDFS ?? "?"), "saved in the outputFolder setting");
  return text(pdf);
}

type Window = Record<string, unknown>;

/** Replaces vscode.window.NAME while BODY runs. */
async function stubbed<T>(name: string, stub: (...a: never[]) => unknown, body: () => Thenable<T>): Promise<T> {
  const window = vscode.window as unknown as Window;
  const original = window[name];
  window[name] = stub;
  try {
    return await body();
  } finally {
    window[name] = original;
  }
}

/** Messages shown while BODY runs. */
async function messages(body: () => Thenable<unknown>): Promise<string[]> {
  const shown: string[] = [];
  const record = (m: string) => {
    shown.push(m);
    return Promise.resolve(undefined);
  };
  await stubbed("showErrorMessage", record, () => stubbed("showWarningMessage", record, () => stubbed("showInformationMessage", record, body)));
  return shown;
}

describe("code2pdf", () => {
  before(async () => {
    await vscode.extensions.getExtension("readbysearch.code2pdf")?.activate();
  });

  beforeEach(() => {
    assert.ok(vscode.workspace.getConfiguration("code2pdf").get<string>("outputFolder"),
      "the fixture's outputFolder is set, so no test opens a real save dialog");
  });

  it("code2pdf.telemetry: once you turn it off, a workspace can't turn it back on", async () => {
    const config = () => vscode.workspace.getConfiguration("code2pdf");
    assert.equal(config().get<boolean>("telemetry"), true, "on unless you turn it off");
    await config().update("telemetry", false, vscode.ConfigurationTarget.Global);
    try {
      await assert.rejects(Promise.resolve(config().update("telemetry", true, vscode.ConfigurationTarget.Workspace)));
      assert.equal(config().get<boolean>("telemetry"), false);
    } finally {
      await config().update("telemetry", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it("registers its commands, and version 1's", async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of ["code2pdf.print", "code2pdf.chooseFiles", "code2pdf.printFile", "code2pdf.printSelection",
      "code2pdf.printWorkspace", "code2pdf.printChanges", "extension.printFileToPdf", "extension.printAll"]) {
      assert.ok(all.includes(id), id);
    }
  });

  // First of the prints: like a real update from version 1, the first print comes right after
  // activation (one of the two signs; the version 1 setting is the other)
  it("tells a version 1 user what changed: in the install message, then once after printing", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cliModule = require("../../cli") as { find: (setting: string) => Promise<unknown>; NotInstalled: new (l: string[], f: boolean) => Error };
    const realFind = cliModule.find;
    const config = vscode.workspace.getConfiguration("code2pdf");
    await config.update("whitelisted_file_names", ["README.md"], vscode.ConfigurationTarget.Workspace);  // a version 1 setting
    try {
      cliModule.find = () => Promise.reject(new cliModule.NotInstalled(["code2pdf"], false));
      await config.update("executable", "", vscode.ConfigurationTarget.Global);  // forget the code2pdf found earlier
      const before = await messages(() => vscode.commands.executeCommand("code2pdf.printFile", uri("src/util.py")));
      assert.ok(before.some((m) => m.startsWith("Version 2 of this extension prints with the code2pdf command-line tool instead of Vim and Ghostscript")),
        before.join(" | "));
      assert.ok(!before.some((m) => m.startsWith("code2pdf 2.0:")), "no note before anything is printed");

      cliModule.find = realFind;  // now it's installed
      await config.update("executable", undefined, vscode.ConfigurationTarget.Global);
      const first = await messages(() => vscode.commands.executeCommand("code2pdf.printFile", uri("src/util.py")));
      assert.equal(first.filter((m) => m.startsWith("code2pdf 2.0: you now choose where each PDF goes")).length, 1, first.join(" | "));
      const second = await messages(() => vscode.commands.executeCommand("code2pdf.printFile", uri("src/util.py")));
      assert.ok(!second.some((m) => m.startsWith("code2pdf 2.0:")), "only once");
    } finally {
      cliModule.find = realFind;
      await config.update("executable", undefined, vscode.ConfigurationTarget.Global);
      await config.update("whitelisted_file_names", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  it("prints a file", async () => {
    const pdf = await vscode.commands.executeCommand<string>("code2pdf.printFile", uri("src/app.py"));
    assert.equal(path.basename(pdf), "app.pdf");
    const t = printed(pdf);
    assert.match(t, /def greet\(name\):/);
    assert.match(t, /^src\/\s+app\.py$/m, "labelled with its folder in the project");
  });

  it("prints the selected lines, with their own line numbers", async () => {
    const editor = await vscode.window.showTextDocument(uri("src/app.py"));
    editor.selections = [new vscode.Selection(9, 0, 12, 0), new vscode.Selection(24, 3, 24, 8)];
    const pdf = await vscode.commands.executeCommand<string>("code2pdf.printSelection");
    assert.equal(path.basename(pdf), "app-lines-10-25.pdf");
    const t = printed(pdf);
    assert.match(t, /^\s*10\s+value_10 = 10/m);
    assert.match(t, /^\s*12\s+value_12 = 12/m);
    assert.match(t, /^\s*25\s+value_25 = 25/m);
    assert.doesNotMatch(t, /value_13 = 13/, "line 13 wasn't selected (the selection ends at its start)");
    assert.doesNotMatch(t, /def greet/);
  });

  it("prints the workspace folder with code2pdf's selection", async () => {
    const t = printed(await vscode.commands.executeCommand<string>("code2pdf.printWorkspace"));
    for (const file of ["README.md", "src/app.py", "src/util.py", "tests/test_app.py"]) {
      assert.ok(t.includes(file), file);
    }
    assert.doesNotMatch(t, /json_marker/, "JSON isn't in the default selection");
    assert.doesNotMatch(t, /code2pdf\.outputFolder/, "hidden folders are skipped");
  });

  it("uses the include and exclude settings", async () => {
    const config = vscode.workspace.getConfiguration("code2pdf");
    await config.update("include", ["*.json"], vscode.ConfigurationTarget.Workspace);
    await config.update("exclude", ["tests"], vscode.ConfigurationTarget.Workspace);
    try {
      const t = printed(await vscode.commands.executeCommand<string>("code2pdf.print", vscode.Uri.file(project())));
      assert.match(t, /json_marker/);
      assert.doesNotMatch(t, /tested greeting/);
    } finally {
      await config.update("include", undefined, vscode.ConfigurationTarget.Workspace);
      await config.update("exclude", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  it("prints several selected files and folders as one PDF", async () => {
    const pdf = await vscode.commands.executeCommand<string>("code2pdf.print", uri("README.md"), [uri("tests"), uri("README.md"), uri("src/util.py")]);
    assert.equal(path.basename(pdf), "shop-selected.pdf");
    const t = printed(pdf);
    assert.match(t, /A tiny shop for tests/);
    assert.match(t, /util helper/);
    assert.match(t, /tested greeting/);
    assert.doesNotMatch(t, /def greet/);
    assert.ok(t.indexOf("A tiny shop") < t.indexOf("util helper") && t.indexOf("util helper") < t.indexOf("tested greeting"),
      "sorted by path");
  });

  it("prints the files left checked in the list", async () => {
    let offered: string[] = [];
    const pdf = await stubbed("showQuickPick", (items: readonly vscode.QuickPickItem[]) => {
      offered = items.map((i) => i.label);
      return Promise.resolve(items.filter((i) => i.label !== "app.py"));
    }, () => vscode.commands.executeCommand<string>("code2pdf.chooseFiles", uri("src")));
    assert.deepEqual(offered, ["app.py", "util.py"], "paths relative to the folder");
    const t = printed(pdf);
    assert.match(t, /util helper/);
    assert.doesNotMatch(t, /def greet/);
  });

  it("prints the last commit's changes, compared with the files as they are now", async () => {
    const pdf = await vscode.commands.executeCommand<string>("code2pdf.printChanges", { folder: project(), rev: "HEAD~1" });
    const t = printed(pdf);
    assert.match(t, /^\s*20\s+value_20 = 'changed in commit two'/m);
    assert.match(t, /util helper, edited but not committed/, "compared with the files as they are now");
    assert.doesNotMatch(t, /value_5 = 5/, "only the changed part of a long file");
  });

  it("offers the changes to print, and prints the one picked", async () => {
    let labels: string[] = [];
    const pdf = await stubbed("showQuickPick", (items: readonly vscode.QuickPickItem[]) => {
      labels = items.filter((i) => i.kind !== vscode.QuickPickItemKind.Separator).map((i) => i.label);
      return Promise.resolve(items.find((i) => i.label === "Uncommitted changes"));
    }, () => vscode.commands.executeCommand<string>("code2pdf.printChanges"));
    assert.deepEqual(labels.slice(0, 3), ["Uncommitted changes", "The last commit", "Change value 20"]);
    assert.equal(path.basename(pdf), "shop-uncommitted.pdf");
    const t = printed(pdf);
    assert.match(t, /edited but not committed/);
    assert.doesNotMatch(t, /changed in commit two/);
  });

  it("version 1's command still prints the open file", async () => {
    await vscode.window.showTextDocument(uri("src/util.py"));
    assert.match(printed(await vscode.commands.executeCommand<string>("extension.printFileToPdf")), /util helper/);
  });

  it("shows code2pdf's error instead of failing silently", async () => {
    const config = vscode.workspace.getConfiguration("code2pdf");
    await config.update("theme", "no-such-theme", vscode.ConfigurationTarget.Workspace);
    try {
      let pdf: string | undefined = "not run";
      const shown = await messages(async () => {
        pdf = await vscode.commands.executeCommand<string>("code2pdf.printFile", uri("src/util.py"));
      });
      assert.equal(pdf, undefined);
      assert.ok(shown.some((m) => m.includes("unknown theme 'no-such-theme'")), shown.join(" | "));
    } finally {
      await config.update("theme", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  it("says so when code2pdf isn't where the setting points", async () => {
    const config = vscode.workspace.getConfiguration("code2pdf");
    const outputFolder = config.inspect<string>("outputFolder")?.workspaceValue;
    await config.update("executable", "/nonexistent/code2pdf", vscode.ConfigurationTarget.Global);
    await config.update("outputFolder", "", vscode.ConfigurationTarget.Workspace);
    try {
      let asked = false;
      const shown = await messages(() => stubbed("showSaveDialog", () => {
        asked = true;
        return Promise.resolve(undefined);
      }, async () => {
        assert.equal(await vscode.commands.executeCommand<string>("code2pdf.printFile", uri("src/util.py")), undefined);
      }));
      assert.ok(shown.some((m) => m.includes("isn't at /nonexistent/code2pdf")), shown.join(" | "));
      assert.ok(!asked, "doesn't ask where to save a PDF it can't make");
    } finally {
      await config.update("executable", undefined, vscode.ConfigurationTarget.Global);
      await config.update("outputFolder", outputFolder, vscode.ConfigurationTarget.Workspace);
    }
  });

  // The fake code2pdf in these two is a shell script, which Windows can't run
  const posixIt = process.platform === "win32" ? it.skip : it;

  posixIt("keeps the elapsed time moving while code2pdf is quiet", async () => {
    const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "code2pdf-fake-")), "code2pdf");
    fs.writeFileSync(fake, [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "code2pdf 3.12 (commit x, 2026-10-11)"; echo "  installed: Homebrew, /x"; exit 0; fi',
      'out=""; prev=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done',
      'echo "Converting to a PDF file for src/util.py"',
      'mkdir -p "$(dirname "$out")"',
      "sleep 2.5",
      "printf '%%PDF-1.7\\n' > \"$out\"",
      'echo "PDF created at $out"',
    ].join("\n"), { mode: 0o755 });
    const config = vscode.workspace.getConfiguration("code2pdf");
    await config.update("executable", fake, vscode.ConfigurationTarget.Global);
    const reports: string[] = [];
    try {
      const pdf = await stubbed("withProgress", (_options: unknown, task: (p: unknown, t: unknown) => Thenable<unknown>) =>
        task({ report: (r: { message?: string }) => reports.push(r.message ?? "") },
          { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
      () => vscode.commands.executeCommand<string>("code2pdf.printFile", uri("src/util.py")));
      assert.ok(pdf && fs.existsSync(pdf));
    } finally {
      await config.update("executable", undefined, vscode.ConfigurationTarget.Global);
    }
    assert.ok(reports.includes("src/util.py (0:00)"), reports.join(" | "));
    assert.ok(reports.some((r) => /^src\/util\.py \(0:0[12]\)$/.test(r)), `ticks while quiet: ${reports.join(" | ")}`);
  });

  it("offers to install code2pdf when it's missing, then to print once it's installed", async () => {
    // The extension's own cli module (same file, so the same module): it finds no code2pdf
    // until the "install" is done
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cliModule = require("../../cli") as { find: (setting: string) => Promise<unknown>; NotInstalled: new (l: string[], f: boolean) => Error };
    const realFind = cliModule.find;
    let installed = false;
    cliModule.find = (setting: string) => (installed ? realFind(setting) : Promise.reject(new cliModule.NotInstalled(["code2pdf"], false)));
    // On Windows, Install downloads the Windows build: here it only records where it would go
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const downloadModule = require("../../download") as { installWindowsBuild: (dir: string) => Promise<string> };
    const realDownload = downloadModule.installWindowsBuild;
    const downloadedTo: string[] = [];
    downloadModule.installWindowsBuild = async (dir: string) => {
      downloadedTo.push(dir);
      installed = true;
      return "code2pdf 3.13";
    };
    const config = vscode.workspace.getConfiguration("code2pdf");
    await config.update("executable", "", vscode.ConfigurationTarget.Global);  // forget the code2pdf found earlier
    const pdf = path.join(process.env.CODE2PDF_TEST_PDFS ?? "", "util.pdf");
    fs.rmSync(pdf, { force: true });
    const sent: string[] = [];
    const warnings: string[] = [];
    const infos: string[] = [];
    try {
      await stubbed("createTerminal", () => ({ show() {}, sendText: (t: string) => sent.push(t), dispose() {} }), () =>
        stubbed("showWarningMessage", (m: string, ...buttons: string[]) => {
          warnings.push(m);
          return Promise.resolve(buttons[0]);  // the install button
        }, () => stubbed("showInformationMessage", (m: string, ...buttons: string[]) => {
          infos.push(m);
          return Promise.resolve(buttons.includes("Print Now") ? "Print Now" : undefined);
        }, async () => {
          assert.equal(await vscode.commands.executeCommand("code2pdf.printFile", uri("src/util.py")), undefined);
          assert.match(warnings[0] ?? "", /code2pdf command-line tool, which isn't installed/);
          if (process.platform === "win32") {
            assert.match(downloadedTo[0] ?? "", /\\Programs\\code2pdf$/, "Install downloads the Windows build, with no terminal");
            assert.equal(sent.length, 0);
          } else {
            assert.match(sent[0] ?? "", /^brew install readbysearch\/tap\/code2pdf$|code2pdf_all\.deb'$|bash -s -- --user'$/);
            assert.ok(!fs.existsSync(pdf));
            installed = true;  // the terminal finished
          }
          for (let i = 0; i < 100 && !fs.existsSync(pdf); i++) {
            await new Promise((r) => setTimeout(r, 200));
          }
        })));
    } finally {
      cliModule.find = realFind;
      downloadModule.installWindowsBuild = realDownload;
      await config.update("executable", undefined, vscode.ConfigurationTarget.Global);
    }
    assert.ok(infos.some((m) => /^code2pdf \S+ is installed\.$/.test(m)), infos.join(" | "));
    assert.ok(fs.existsSync(pdf), "Print Now printed the file that was asked for");
  });

  it("the install command says when code2pdf is already installed", async () => {
    const shown = await messages(() => vscode.commands.executeCommand("code2pdf.install"));
    assert.ok(shown.some((m) => /^code2pdf \S+ is installed \(/.test(m)), shown.join(" | "));
  });

  it("the old \"Print All\" command is found by its words", () => {
    const commands = vscode.extensions.getExtension("readbysearch.code2pdf")?.packageJSON.contributes.commands as { command: string; title: string }[];
    assert.match(commands.find((c) => c.command === "code2pdf.printWorkspace")?.title ?? "", /^Print All /);
  });

  posixIt("a lookup that finishes late doesn't bring back the old code2pdf", async () => {
    // Changing code2pdf.executable twice starts two lookups; the first (here made slow) ends last
    const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "code2pdf-fake-")), "code2pdf");
    fs.writeFileSync(fake, [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "code2pdf 3.12 (commit x, 2026-10-11)"; echo "  installed: Homebrew, /x"; exit 0; fi',
      'out=""; prev=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done',
      'echo "Converting to a PDF file for FAKE-CODE2PDF"',
      'mkdir -p "$(dirname "$out")"; printf "%%PDF-1.7\\n" > "$out"',
    ].join("\n"), { mode: 0o755 });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cliModule = require("../../cli") as { find: (setting: string) => Promise<unknown> };
    const realFind = cliModule.find;
    cliModule.find = async (setting: string) => {
      if (!setting) {
        await new Promise((r) => setTimeout(r, 1500));  // the lookup for the old setting is slow
      }
      return realFind(setting);
    };
    const config = vscode.workspace.getConfiguration("code2pdf");
    const reports: string[] = [];
    try {
      await config.update("executable", "", vscode.ConfigurationTarget.Global);
      await config.update("executable", fake, vscode.ConfigurationTarget.Global);
      await new Promise((r) => setTimeout(r, 2500));  // both lookups are done, the old one last
      await stubbed("withProgress", (_options: unknown, task: (p: unknown, t: unknown) => Thenable<unknown>) =>
        task({ report: (r: { message?: string }) => reports.push(r.message ?? "") },
          { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
      () => vscode.commands.executeCommand<string>("code2pdf.printFile", uri("src/util.py")));
    } finally {
      cliModule.find = realFind;
      await config.update("executable", undefined, vscode.ConfigurationTarget.Global);
    }
    assert.ok(reports.some((r) => r.startsWith("FAKE-CODE2PDF")), `printed with the code2pdf the setting names now: ${reports.join(" | ")}`);
  });

  it("says what to do outside a git repository", async () => {
    const shown = await messages(async () => {
      assert.equal(await vscode.commands.executeCommand<string>("code2pdf.printChanges", { folder: path.dirname(project()) }), undefined);
    });
    assert.ok(shown.some((m) => m.includes("isn't in a git repository")), shown.join(" | "));
  });
});
