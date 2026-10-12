import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
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
async function messages(body: () => Promise<unknown>): Promise<string[]> {
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

  it("registers its commands, and version 1's", async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of ["code2pdf.print", "code2pdf.chooseFiles", "code2pdf.printFile", "code2pdf.printSelection",
      "code2pdf.printWorkspace", "code2pdf.printChanges", "extension.printFileToPdf", "extension.printAll"]) {
      assert.ok(all.includes(id), id);
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
      await config.update("outputFolder", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  it("says what to do outside a git repository", async () => {
    const shown = await messages(async () => {
      assert.equal(await vscode.commands.executeCommand<string>("code2pdf.printChanges", { folder: path.dirname(project()) }), undefined);
    });
    assert.ok(shown.some((m) => m.includes("isn't in a git repository")), shown.join(" | "));
  });
});
