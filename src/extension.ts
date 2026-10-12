import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import * as args from "./args";
import * as cli from "./cli";
import * as git from "./git";
import { INSTALL_GUIDE, installCommand, parseOsRelease, updateCommand } from "./install";
import { type OutputReader, withElapsed } from "./progress";
import * as specs from "./specs";

let log: vscode.OutputChannel;
let state: vscode.Memento;
let found: cli.Code2pdf | undefined;
/** The last print command run, to offer it again once code2pdf is installed. */
let lastPrint: { id: string; args: unknown[] } | undefined;
/** Checks every few seconds whether an install started from here has finished. */
let installWatch: NodeJS.Timeout | undefined;

/** A print, ready to run. */
interface Job {
  /** Shown while it runs, such as "Printing src/app.py". */
  title: string;
  cwd: string;
  args: string[];
  /** For `--files-from -`. */
  input?: string;
  output: string;
}

/** Thrown to stop a command with a message for the user (none when they cancelled). */
class Stop extends Error {
  constructor(message: string, readonly level: "info" | "warning" | "error" = "info") {
    super(message);
  }
}

export function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel("code2pdf");
  state = context.globalState;
  // Each returns the PDF's path, or undefined if nothing was printed
  const register = (id: string, handler: (...a: never[]) => Promise<string | undefined>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, (...a: unknown[]) => {
      lastPrint = { id, args: a };
      return guard(() => handler(...(a as never[])));
    }));
  register("code2pdf.print", printResources);
  register("code2pdf.chooseFiles", chooseFiles);
  register("code2pdf.printFile", printFile);
  register("code2pdf.printSelection", printSelection);
  register("code2pdf.printWorkspace", printWorkspace);
  register("code2pdf.printChanges", printChanges);
  // Version 1's commands, for keybindings that use them
  register("extension.printFileToPdf", () => printFile());
  register("extension.printAll", () => printWorkspace());
  context.subscriptions.push(vscode.commands.registerCommand("code2pdf.install", () => guard(installOrCheck)));
  context.subscriptions.push(
    log,
    { dispose: stopInstallWatch },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("code2pdf.executable")) {
        found = undefined;
        void checkInstalled();
      }
    }),
  );
  // For the Get Started walkthrough: its first step is done once code2pdf is installed
  void checkInstalled();
}

export function deactivate() {}

/** Runs a command and reports every failure, so nothing fails silently. Returns the PDF's path. */
async function guard(command: () => Promise<string | undefined>): Promise<string | undefined> {
  try {
    return await command();
  } catch (error) {
    if (error instanceof Stop) {
      if (error.message) {
        void showWithOutput(error.level, error.message, false);
      }
      return undefined;
    }
    const message = error instanceof Error ? error.message : String(error);
    log.appendLine(`Error: ${error instanceof Error && error.stack ? error.stack : message}`);
    void showWithOutput("error", `code2pdf: ${message}`);
    return undefined;
  }
}

/** Shows a message without waiting for it to be dismissed. */
function show(level: "error" | "warning" | "info", message: string, ...buttons: string[]): Thenable<string | undefined> {
  if (level === "error") {
    return vscode.window.showErrorMessage(message, ...buttons);
  }
  return level === "warning" ? vscode.window.showWarningMessage(message, ...buttons) : vscode.window.showInformationMessage(message, ...buttons);
}

async function showWithOutput(level: "error" | "warning" | "info", message: string, withButton = true): Promise<void> {
  if ((await show(level, message, ...(withButton ? ["Show Output"] : []))) === "Show Output") {
    log.show(true);
  }
}

// Settings

function settings(scope?: vscode.Uri) {
  const config = vscode.workspace.getConfiguration("code2pdf", scope);
  const set = <T>(key: string): T | undefined => {
    const seen = config.inspect<T>(key);
    return seen?.workspaceFolderValue ?? seen?.workspaceValue ?? seen?.globalValue;
  };
  const print: args.PrintSettings = {
    theme: config.get<string>("theme", "paper"),
    include: config.get<string[]>("include", []),
    exclude: config.get<string[]>("exclude", []),
    legacy: {
      blacklistedFolders: set<string[]>("blacklisted_folders"),
      blacklistedFolderPattern: set<string>("blacklisted_folder_pattern"),
      whitelistedFileExtensions: set<string[]>("whitelisted_file_extensions"),
      whitelistedFileNames: set<string[]>("whitelisted_file_names"),
    },
  };
  return {
    print,
    outputFolder: config.get<string>("outputFolder", "").trim(),
    openWith: config.get<"viewer" | "editor" | "none">("openWith", "viewer"),
    executable: config.get<string>("executable", ""),
  };
}

// Finding code2pdf

async function code2pdf(): Promise<cli.Code2pdf | undefined> {
  if (found) {
    return found;
  }
  if (process.platform === "win32") {
    const choice = await vscode.window.showWarningMessage(
      "code2pdf runs on macOS and Linux. On Windows, open your folder in WSL (the WSL extension), install code2pdf there, and print from that window.",
      "About WSL");
    if (choice) {
      void vscode.env.openExternal(vscode.Uri.parse("https://code.visualstudio.com/docs/remote/wsl"));
    }
    return undefined;
  }
  const executable = settings().executable;
  try {
    found = await cli.find(executable);
    log.appendLine(`Using ${found.command}: code2pdf ${found.version} (${found.installKind})`);
    return found;
  } catch (error) {
    if (error instanceof cli.NotInstalled) {
      await offerInstall(error);
      return undefined;
    }
    if (error instanceof cli.TooOld) {
      await offerUpdate(error.found);
      return undefined;
    }
    throw error;
  }
}

/** Sets the code2pdf.installed context (for the walkthrough), without any message. */
async function checkInstalled(): Promise<boolean> {
  let installed: boolean;
  try {
    found = await cli.find(settings().executable);
    installed = true;
  } catch {
    installed = false;
  }
  await vscode.commands.executeCommand("setContext", "code2pdf.installed", installed);
  return installed;
}

/** The install (or update) command for this machine, and what to say about it. */
function howToInstall(old?: cli.Code2pdf): { install?: { label: string; command: string }; message: string } {
  if (old) {
    const update = updateCommand(old, os.homedir());
    return {
      install: update,
      message: `This extension needs code2pdf ${cli.MIN_VERSION.join(".")} or later, and ${old.command} is ${old.version}.` +
        (update ? ` It can be updated with: ${update.command}` : ""),
    };
  }
  let release;
  try {
    release = parseOsRelease(fs.readFileSync("/etc/os-release", "utf8"));
  } catch {
    release = undefined;
  }
  const install = installCommand(process.platform, hasBrew(), release);
  if (install) {
    return { install, message: `This extension prints with the code2pdf command-line tool, which isn't installed. It installs with: ${install.command}` };
  }
  if (process.platform === "darwin") {
    return { message: "This extension prints with the code2pdf command-line tool, which isn't installed. It installs with Homebrew, which isn't installed either: install Homebrew from brew.sh, then run \"code2pdf: Install the Command-Line Tool\"." };
  }
  return { message: "This extension prints with the code2pdf command-line tool, which isn't installed." };
}

function hasBrew(): boolean {
  for (const brew of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew", "/home/linuxbrew/.linuxbrew/bin/brew"]) {
    if (fs.existsSync(brew)) {
      return true;
    }
  }
  return (process.env.PATH ?? "").split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, "brew")));
}

async function offerInstall(error: cli.NotInstalled): Promise<void> {
  log.appendLine(`code2pdf not found; looked for: ${error.looked.join(", ")}`);
  if (error.fromSetting) {
    const choice = await vscode.window.showErrorMessage(
      `code2pdf isn't at ${error.looked[0]}, where the code2pdf.executable setting says it is.`, "Open Settings");
    if (choice) {
      void vscode.commands.executeCommand("workbench.action.openSettings", "code2pdf.executable");
    }
    return;
  }
  await offer(howToInstall());
}

async function offerUpdate(old: cli.Code2pdf): Promise<void> {
  await offer(howToInstall(old));
}

async function offer({ install, message }: ReturnType<typeof howToInstall>): Promise<void> {
  const homebrew = !install && process.platform === "darwin";
  const buttons = [...(install ? [install.label] : homebrew ? ["Open brew.sh"] : []), "Installation Guide"];
  const choice = await vscode.window.showWarningMessage(message, ...buttons);
  if (install && choice === install.label) {
    runInTerminal(install.label.startsWith("Update") ? "Update code2pdf" : "Install code2pdf", install.command);
  } else if (choice === "Open brew.sh") {
    void vscode.env.openExternal(vscode.Uri.parse("https://brew.sh"));
  } else if (choice === "Installation Guide") {
    void vscode.env.openExternal(vscode.Uri.parse(INSTALL_GUIDE));
  }
}

/** The Install command (and the walkthrough's button): install, update, or say it's ready. */
async function installOrCheck(): Promise<undefined> {
  if (process.platform === "win32") {
    await code2pdf();  // explains WSL
    return undefined;
  }
  try {
    const ready = await cli.find(settings().executable);
    found = ready;
    await vscode.commands.executeCommand("setContext", "code2pdf.installed", true);
    void show("info", `code2pdf ${ready.version} is installed (${ready.installKind}). Right-click a folder or file and choose Print to PDF.`);
  } catch (error) {
    if (error instanceof cli.NotInstalled) {
      await offerInstall(error);
    } else if (error instanceof cli.TooOld) {
      await offerUpdate(error.found);
    } else {
      throw error;
    }
  }
  return undefined;
}

function runInTerminal(name: string, command: string): void {
  const terminal = vscode.window.createTerminal({ name });
  terminal.show();
  terminal.sendText(command);
  found = undefined;
  watchForInstall();
  void vscode.window.showInformationMessage(`${name} is running in the terminal. You'll get a message here when it's ready.`);
}

function stopInstallWatch(): void {
  clearInterval(installWatch);
  installWatch = undefined;
}

/** Checks every few seconds (for half an hour) whether code2pdf is ready, then offers to print. */
function watchForInstall(intervalMs = 3000): void {
  stopInstallWatch();
  const started = Date.now();
  let checking = false;
  installWatch = setInterval(async () => {
    if (checking) {
      return;
    }
    if (Date.now() - started > 30 * 60_000) {
      stopInstallWatch();
      return;
    }
    checking = true;
    try {
      const ready = await cli.find(settings().executable);
      if (!installWatch) {
        return;
      }
      stopInstallWatch();
      found = ready;
      log.appendLine(`code2pdf is ready: ${ready.command}, ${ready.version} (${ready.installKind})`);
      await vscode.commands.executeCommand("setContext", "code2pdf.installed", true);
      const retry = lastPrint;
      const choice = await show("info", `code2pdf ${ready.version} is installed.` + (retry ? "" : " Right-click a folder or file and choose Print to PDF."),
        ...(retry ? ["Print Now"] : []));
      if (choice === "Print Now" && retry) {
        void vscode.commands.executeCommand(retry.id, ...retry.args);
      }
    } catch {
      // Not there yet (or still too old): look again
    } finally {
      checking = false;
    }
  }, intervalMs);
}

// Where things are

function workspaceFolderOf(uri: vscode.Uri): string | undefined {
  return vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
}

function isFolder(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function onDisk(uri: vscode.Uri | undefined): vscode.Uri {
  if (!uri) {
    throw new Stop("Open a file to print first.");
  }
  if (uri.scheme === "untitled") {
    throw new Stop("Save the file first: code2pdf prints files on disk.");
  }
  if (uri.scheme !== "file") {
    throw new Stop(`code2pdf prints files on disk, and this one is a ${uri.scheme} file.`);
  }
  return uri;
}

async function pickWorkspaceFolder(placeHolder: string): Promise<vscode.Uri> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    throw new Stop("Open a folder first.");
  }
  if (folders.length === 1) {
    return folders[0].uri;
  }
  const folder = await vscode.window.showWorkspaceFolderPick({ placeHolder });
  if (!folder) {
    throw new Stop("");
  }
  return folder.uri;
}

/** Where to save NAME: the outputFolder setting, or a save dialog. Undefined if cancelled. */
async function outputPath(name: string, workspace: string | undefined): Promise<string | undefined> {
  const home = os.homedir();
  const folder = settings().outputFolder;
  if (folder) {
    const absolute = specs.expandHome(folder, home);
    return path.join(path.isAbsolute(absolute) ? absolute : path.join(workspace ?? home, absolute), name);
  }
  const last = state.get<string>("lastFolder");
  const start = last && isFolder(last) ? last : [path.join(home, "Desktop"), path.join(home, "Documents")].find(isFolder) ?? home;
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(start, name)),
    filters: { PDF: ["pdf"] },
    saveLabel: "Print",
    title: "Save the PDF",
  });
  if (!uri) {
    return undefined;
  }
  await state.update("lastFolder", path.dirname(uri.fsPath));
  return uri.fsPath.toLowerCase().endsWith(".pdf") ? uri.fsPath : `${uri.fsPath}.pdf`;
}

/** Saves DOCUMENT if the user wants to; throws Stop if they cancel. */
async function savedOrStop(uri: vscode.Uri, linesMustMatch: boolean): Promise<void> {
  const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (!document?.isDirty) {
    return;
  }
  const name = path.basename(uri.fsPath);
  const buttons = linesMustMatch ? ["Save and Print"] : ["Save and Print", "Print Saved Version"];
  const choice = await vscode.window.showWarningMessage(
    linesMustMatch ? `${name} has unsaved changes. Save it first, so the line numbers match.` : `${name} has unsaved changes.`,
    { modal: true }, ...buttons);
  if (choice === "Save and Print") {
    if (!(await document.save())) {
      throw new Stop(`${name} couldn't be saved.`, "error");
    }
  } else if (choice !== "Print Saved Version") {
    throw new Stop("");
  }
}

// Commands

/** Explorer: the clicked item, or all selected items. */
async function printResources(clicked?: vscode.Uri, selected?: vscode.Uri[]): Promise<string | undefined> {
  const uris = selected?.length ? selected : clicked ? [clicked] : [];
  if (!uris.length) {
    return printFile();
  }
  if (uris.length === 1) {
    const uri = onDisk(uris[0]);
    return isFolder(uri.fsPath) ? printFolder(uri) : printFile(uri);
  }
  return printMany(uris.map(onDisk));
}

async function printFile(uri?: vscode.Uri): Promise<string | undefined> {
  const file = onDisk(uri ?? vscode.window.activeTextEditor?.document.uri);
  if (isFolder(file.fsPath)) {
    return printFolder(file);
  }
  if (!(await code2pdf())) {
    return undefined;
  }
  await savedOrStop(file, false);
  const root = workspaceFolderOf(file) ?? path.dirname(file.fsPath);
  const rel = specs.relativePath(root, file.fsPath);
  const output = await outputPath(`${specs.fileNamePart(specs.stem(file.fsPath))}.pdf`, root);
  if (!output) {
    return undefined;
  }
  return execute({ title: `Printing ${rel}`, cwd: root, args: args.fileArgs(rel, output, settings(file).print), output });
}

async function printSelection(): Promise<string | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    throw new Stop("Open a file and select the lines to print first.");
  }
  const file = onDisk(editor.document.uri);
  const ranges = specs.selectionRanges(editor.selections.map((s) => ({
    startLine: s.start.line, endLine: s.end.line, endCharacter: s.end.character, isEmpty: s.isEmpty,
  })));
  if (!ranges.length) {
    throw new Stop("Select the lines to print first.");
  }
  if (!(await code2pdf())) {
    return undefined;
  }
  await savedOrStop(file, true);
  const root = workspaceFolderOf(file) ?? path.dirname(file.fsPath);
  const rel = specs.relativePath(root, file.fsPath);
  const spec = specs.rangeSpec(rel, ranges);
  const output = await outputPath(specs.selectionPdfName(file.fsPath, ranges), root);
  if (!output) {
    return undefined;
  }
  return execute({ title: `Printing ${spec}`, cwd: root, args: args.fileArgs(spec, output, settings(file).print), output });
}

async function printWorkspace(): Promise<string | undefined> {
  return printFolder(await pickWorkspaceFolder("Print which folder?"));
}

async function printFolder(folder: vscode.Uri): Promise<string | undefined> {
  if (!(await code2pdf())) {
    return undefined;
  }
  const root = workspaceFolderOf(folder) ?? folder.fsPath;
  const rel = specs.relativePath(root, folder.fsPath);
  const output = await outputPath(`${specs.fileNamePart(path.basename(folder.fsPath))}.pdf`, root);
  if (!output) {
    return undefined;
  }
  return execute({ title: `Printing ${rel === "." ? path.basename(root) : rel}`, cwd: root, args: args.folderArgs(rel, output, settings(folder).print), output });
}

/** The files code2pdf would print from FOLDER (relative to it), with the include and exclude settings. */
async function listFiles(command: string, cwd: string, folder: string, scope: vscode.Uri): Promise<string[]> {
  const listArgs = args.listArgs(folder, settings(scope).print);
  log.appendLine(`\n$ ${args.shellQuote([command, ...listArgs])}    (in ${cwd})`);
  const result = await cli.run(command, { cwd, args: listArgs, quietStdout: true, onOutput: undefined });
  for (const line of [...result.reader.warnings.map((w) => `Warning: ${w}`), ...result.reader.errors.map((e) => `Error: ${e}`)]) {
    log.appendLine(line);
  }
  if (result.code !== 0) {
    throw new Error(result.reader.errorMessage() ?? `code2pdf --list-files exited with code ${result.code}`);
  }
  return result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Several selected files and folders: each folder's usual files, then printed as one list. */
async function printMany(uris: vscode.Uri[]): Promise<string | undefined> {
  const command = await code2pdf();
  if (!command) {
    return undefined;
  }
  const paths = uris.map((u) => u.fsPath);
  const folders = new Set(uris.map((u) => workspaceFolderOf(u)));
  const root = folders.size === 1 && [...folders][0] ? ([...folders][0] as string) : specs.commonFolder(paths, isFolder);
  const items = paths.map((p) => ({ path: p, rel: specs.relativePath(root, p) })).sort((a, b) => specs.treeOrder(a.rel, b.rel));
  const list: string[] = [];
  for (const item of items) {
    if (isFolder(item.path)) {
      const inside = await listFiles(command.command, root, item.rel, vscode.Uri.file(item.path));
      list.push(...inside.map((f) => (item.rel === "." ? f : `${item.rel}/${f}`)));
    } else {
      list.push(item.rel);
    }
  }
  const files = specs.unique(list);
  if (!files.length) {
    throw new Stop("There's nothing to print in the selected folders: code2pdf's selection found no source files.");
  }
  const output = await outputPath(`${specs.fileNamePart(path.basename(root))}-selected.pdf`, root);
  if (!output) {
    return undefined;
  }
  return execute({
    title: `Printing ${files.length} file${files.length === 1 ? "" : "s"}`,
    cwd: root,
    args: args.filesFromArgs(".", output, settings(uris[0]).print),
    input: files.join("\n") + "\n",
    output,
  });
}

/** A folder's files in a list to uncheck, then the checked ones printed. */
async function chooseFiles(uri?: vscode.Uri): Promise<string | undefined> {
  const folder = uri ? onDisk(uri) : await pickWorkspaceFolder("Choose files from which folder?");
  if (!isFolder(folder.fsPath)) {
    return printFile(folder);
  }
  const command = await code2pdf();
  if (!command) {
    return undefined;
  }
  const root = workspaceFolderOf(folder) ?? folder.fsPath;
  const rel = specs.relativePath(root, folder.fsPath);
  const files = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "code2pdf: listing files" },
    () => listFiles(command.command, root, rel, folder));
  if (!files.length) {
    throw new Stop(`code2pdf's selection found no source files in ${rel === "." ? path.basename(root) : rel}.`);
  }
  const picked = await vscode.window.showQuickPick(
    files.map((f) => ({ label: f, picked: true })),
    { canPickMany: true, title: `Print from ${rel === "." ? path.basename(root) : rel}`, placeHolder: "Uncheck the files to leave out, then press Enter", matchOnDescription: true });
  if (!picked?.length) {
    return undefined;
  }
  const output = await outputPath(`${specs.fileNamePart(path.basename(folder.fsPath))}.pdf`, root);
  if (!output) {
    return undefined;
  }
  return execute({
    title: `Printing ${picked.length} file${picked.length === 1 ? "" : "s"}`,
    cwd: root,
    args: args.filesFromArgs(rel, output, settings(folder).print),
    input: picked.map((p) => p.label).join("\n") + "\n",
    output,
  });
}

/** What printChanges accepts: a Source Control repository (from its menu), a folder, or options. */
type ChangesTarget = { rootUri?: vscode.Uri } | vscode.Uri | { folder?: string; rev?: string } | undefined;

async function printChanges(target?: ChangesTarget): Promise<string | undefined> {
  let folder: string;
  let rev: string | undefined;
  if (target instanceof vscode.Uri) {
    folder = onDisk(target).fsPath;
  } else if (target && "rootUri" in target && target.rootUri) {
    folder = target.rootUri.fsPath;
  } else if (target && "folder" in target && target.folder) {
    folder = target.folder;
    rev = "rev" in target ? target.rev : undefined;
  } else {
    folder = (await pickWorkspaceFolder("Print changes in which folder?")).fsPath;
  }
  if (!(await git.repositoryRoot(folder))) {
    throw new Stop(`${path.basename(folder)} isn't in a git repository, so there are no changes to print.`, "warning");
  }
  if (!(await code2pdf())) {
    return undefined;
  }
  let name: string;
  if (rev) {
    name = `${path.basename(folder)}-since-${rev}`;
  } else {
    const picked = await pickChanges(folder);
    if (!picked) {
      return undefined;
    }
    ({ rev, name } = picked);
  }
  const output = await outputPath(`${specs.fileNamePart(name)}.pdf`, folder);
  if (!output) {
    return undefined;
  }
  return execute({ title: "Printing changes", cwd: folder, args: args.changedArgs(rev, ".", output, settings(vscode.Uri.file(folder)).print), output });
}

async function pickChanges(folder: string): Promise<{ rev: string; name: string } | undefined> {
  const choices = await git.changeChoices(folder);
  if (!choices.main.length && !choices.commits.length) {
    throw new Stop("This repository has no commits yet, so there are no changes to compare with.");
  }
  type Item = vscode.QuickPickItem & { choice?: git.ChangeChoice; enter?: boolean };
  const items: Item[] = [
    ...choices.main.map((c) => ({ label: c.label, description: c.description, detail: c.detail, choice: c })),
    { label: "From a commit to now", kind: vscode.QuickPickItemKind.Separator },
    ...choices.commits.map((c) => ({ label: c.label, description: c.description, choice: c })),
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    { label: "$(edit) Since a commit, tag or branch you name…", enter: true },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: "Print which changes?",
    placeHolder: "Changed lines are marked in the margin. A commit below means it and everything after it.",
    matchOnDescription: true,
  });
  if (!picked) {
    return undefined;
  }
  if (picked.choice) {
    return { rev: picked.choice.rev, name: picked.choice.name };
  }
  const rev = await vscode.window.showInputBox({
    title: "Print the changes made since…",
    prompt: "A commit, tag or branch. Its own changes are left out; what came after it is printed.",
    placeHolder: "v1.2.0, main, HEAD~3, a1b2c3d",
    validateInput: async (value) => (!value.trim() || (await git.isCommit(folder, value.trim())) ? undefined : `git doesn't know ${value.trim()}`),
  });
  if (!rev?.trim()) {
    return undefined;
  }
  return { rev: rev.trim(), name: `${path.basename(folder)}-since-${rev.trim()}` };
}

// Running a print

async function execute(job: Job): Promise<string | undefined> {
  const command = await code2pdf();
  if (!command) {
    return undefined;
  }
  log.appendLine(`\n$ ${args.shellQuote([command.command, ...job.args])}${job.input ? " < list" : ""}    (in ${job.cwd})`);
  if (job.input) {
    const lines = job.input.trimEnd().split("\n");
    log.appendLine(lines.slice(0, 50).map((l) => `    ${l}`).join("\n") + (lines.length > 50 ? `\n    … ${lines.length - 50} more` : ""));
  }
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: job.title, cancellable: true },
    async (progress, token) => {
      // code2pdf can go quiet for a minute (laying out a long file, writing the PDF), so the
      // elapsed time ticks every second and the notification never looks frozen
      const started = Date.now();
      let done = 0;
      let message: string | undefined;
      const report = (increment = 0) =>
        progress.report({ message: withElapsed(message, (Date.now() - started) / 1000), increment });
      const ticker = setInterval(report, 1000);
      try {
        return await cli.run(command.command, {
          cwd: job.cwd,
          args: job.args,
          input: job.input,
          cancellation: token,
          onOutput: (text) => log.append(text),
          onProgress: (update) => {
            const increment = update.fraction === undefined ? 0 : Math.max(0, update.fraction * 100 - done);
            done += increment;
            message = update.message ?? message;
            report(increment);
          },
        });
      } catch (error) {
        found = undefined;  // it was uninstalled or moved: look for it again next time
        const code = (error as NodeJS.ErrnoException).code;
        throw code === "ENOENT" ? new Stop(`code2pdf is no longer at ${command.command}. Print again to look for it.`, "error") : error;
      } finally {
        clearInterval(ticker);
      }
    });
  if (result.cancelled) {
    log.appendLine("Stopped.");
    vscode.window.setStatusBarMessage("code2pdf: stopped; nothing was written", 5000);
    return undefined;
  }
  if (result.code !== 0) {
    if (result.code === 127 || result.code === 126) {
      found = undefined;
    }
    void showWithOutput("error", `code2pdf: ${result.reader.errorMessage() ?? `stopped with exit code ${result.code}`}`);
    return undefined;
  }
  if (!fs.existsSync(job.output)) {
    void showWithOutput("error", `code2pdf finished, but there's no PDF at ${job.output}.`);
    return undefined;
  }
  await finished(job.output, result.reader);
  return job.output;
}

/** Opens the PDF as the openWith setting says, and says what code2pdf warned about. */
async function finished(pdf: string, reader: OutputReader): Promise<void> {
  const name = path.basename(pdf);
  const pages = reader.pages ? `, ${reader.pages.toLocaleString("en-US")} page${reader.pages === 1 ? "" : "s"}` : "";
  const remarks = [...reader.warnings, ...reader.notes];
  const remark = remarks.length ? ` ${remarks[0]}${remarks.length > 1 ? ` (and ${remarks.length - 1} more in the output)` : ""}` : "";
  const level = reader.warnings.length ? "warning" : "info";
  const openWith = settings().openWith;
  const remote = vscode.env.remoteName;
  const uri = vscode.Uri.file(pdf);

  if (openWith === "viewer" && !remote) {
    await vscode.env.openExternal(uri);
  } else if (openWith === "editor") {
    await vscode.commands.executeCommand("vscode.open", uri);
  }
  const opened = (openWith === "viewer" && !remote) || openWith === "editor";
  if (opened && !remarks.length) {
    vscode.window.setStatusBarMessage(`$(check) code2pdf: ${name}${pages}`, 8000);
    return;
  }
  const where = remote ? `${pdf} (on ${remote})` : pdf;
  const message = opened ? `Saved ${name}${pages}.${remark}` : `Saved ${where}${pages}.${remark}`;
  const buttons = [
    ...(opened ? [] : remote ? ["Open in VS Code"] : ["Open"]),
    ...(remote ? ["Copy Path"] : [process.platform === "darwin" ? "Reveal in Finder" : "Show in Folder"]),
    ...(remarks.length ? ["Show Output"] : []),
  ];
  // Not awaited: the command is done, whether or not the message is ever clicked
  void show(level, message, ...buttons).then((choice) => {
    if (choice === "Open") {
      void vscode.env.openExternal(uri);
    } else if (choice === "Open in VS Code") {
      void vscode.commands.executeCommand("vscode.open", uri);
    } else if (choice === "Copy Path") {
      void vscode.env.clipboard.writeText(pdf);
    } else if (choice === "Reveal in Finder" || choice === "Show in Folder") {
      void vscode.commands.executeCommand("revealFileInOS", uri);
    } else if (choice === "Show Output") {
      log.show(true);
    }
  });
}
