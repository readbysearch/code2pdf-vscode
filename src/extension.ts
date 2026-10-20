import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import * as args from "./args";
import * as cli from "./cli";
import * as download from "./download";
import * as git from "./git";
import { INSTALL_GUIDE, type InstallCommand, installCommands, parseOsRelease, updateCommand } from "./install";
import { type OutputReader, withElapsed } from "./progress";
import * as save from "./save";
import * as specs from "./specs";
import * as telemetry from "./telemetry";
import * as upgrade from "./upgrade";
import * as viewer from "./viewer";

let log: vscode.OutputChannel;
let state: vscode.Memento;
let found: cli.Code2pdf | undefined;
/** Bumped when `found` is forgotten, so a lookup that started earlier can't set it. */
let generation = 0;
/** The lookup running now, which a print waits for rather than starting code2pdf a second time. */
let looking: { generation: number; result: Promise<cli.Code2pdf> } | undefined;
/** The last print command run, to offer it again once code2pdf is installed. */
let lastPrint: { id: string; args: unknown[] } | undefined;
/** Checks every few seconds whether an install started from here has finished. */
let installWatch: NodeJS.Timeout | undefined;
/** The install started from a message: its button, and when. */
let installing: { command: string; started: number } | undefined;
/** Windows: from an Install click until the downloaded code2pdf is found. One download at a time. */
let downloading = false;
const STILL_DOWNLOADING = "code2pdf is still being installed. You'll get a message here when it's ready.";
/** Anonymous usage events (see telemetry.ts); undefined without a connection string. */
let usage: vscode.TelemetryLogger | undefined;
/** For telling version 1 users what changed (see upgrade.ts). */
let activatedAt = 0;
let firstActivation = false;
let commandsRun = 0;
let fromVersion1 = false;
const NOTE_SHOWN = "version1NoteShown";
/** The PDF tab (viewer.ts). */
let pdfTab: viewer.PdfViewer;
/** Each PDF printed here, and what it was printed from: printing that again replaces it. */
const MADE = "pdfsMade";
/** Set once the first PDF saved without asking has said where it went. */
const SAVE_NOTE_SHOWN = "saveNoteShown";

/** What a print command prints, for the usage events. */
type PrintKind = "file" | "selection" | "folder" | "files" | "chosen" | "changes";

/** Where the install or update message came from. */
type OfferedFrom = "print" | "installCommand";

/** A print, ready to run. */
interface Job {
  kind: PrintKind;
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
  activatedAt = Date.now();
  firstActivation = !state.get<boolean>("activated");
  void state.update("activated", true);
  startTelemetry(context);
  // Each returns the PDF's path, or undefined if nothing was printed
  const register = (id: string, handler: (...a: never[]) => Promise<string | undefined>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, (...a: unknown[]) => {
      lastPrint = { id, args: a };
      noteVersion1User();
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
  context.subscriptions.push(vscode.commands.registerCommand("code2pdf.chooseOutputFolder", () => guard(chooseOutputFolder)));
  pdfTab = new viewer.PdfViewer(context.extensionUri, (line) => log.appendLine(line));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(viewer.VIEW_TYPE, pdfTab, {
    webviewOptions: { enableFindWidget: true },
    supportsMultipleEditorsPerDocument: true,
  }));
  context.subscriptions.push(
    log,
    { dispose: stopInstallWatch },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("code2pdf.executable")) {
        forgetFound();
        void checkInstalled();
      }
    }),
  );
  // For the Get Started walkthrough: its first step is done once code2pdf is installed
  void checkInstalled().then((status) => record("activated", {
    ...status,
    homebrew: hasBrew(),
    distro: process.platform === "linux" ? distro() : undefined,
    firstActivation,
  }));
}

export function deactivate() {}

/** Usage events go through VS Code's logger, which sends nothing when telemetry is off. */
function startTelemetry(context: vscode.ExtensionContext): void {
  const target = telemetry.parseConnectionString(telemetry.CONNECTION_STRING);
  // Only from an installed extension: debugging it (F5) would mix our own use into the data
  if (!target || context.extensionMode !== vscode.ExtensionMode.Production) {
    return;
  }
  const version = String(context.extension.packageJSON.version);
  const common: Record<(typeof telemetry.COMMON)[number], string> = {
    extension: version,
    vscode: vscode.version,
    app: vscode.env.appName,
    platform: process.platform,
    arch: process.arch,
    remote: vscode.env.remoteName ?? "none",
  };
  usage = vscode.env.createTelemetryLogger(telemetry.sender(target, telemetry.tags(version)), {
    ignoreBuiltInCommonProperties: true,
    ignoreUnhandledErrors: true,
    additionalCommonProperties: common,
  });
  context.subscriptions.push(usage);
}

/** Sends an event if VS Code's telemetry is on (the logger checks) and code2pdf.telemetry is too. */
function record<E extends telemetry.EventName>(event: E, data: telemetry.EventData<E>): void {
  // Read each time, so turning it off stops the next event. It can only turn events off: it's
  // application-scoped, so a workspace's settings can't turn it back on.
  if (vscode.workspace.getConfiguration("code2pdf").get<boolean>("telemetry", true)) {
    usage?.logUsage(event, data);
  }
}

/** At the start of each print command: does this look like someone updated from version 1? */
function noteVersion1User(): void {
  const legacy = settings().print.legacy;
  const version1Settings = Object.values(legacy).some((v) => (Array.isArray(v) ? v.length > 0 : Boolean(v?.trim())));
  fromVersion1 = fromVersion1 || upgrade.cameFromVersion1({
    noteShown: Boolean(state.get<boolean>(NOTE_SHOWN)),
    version1Settings,
    firstActivation,
    firstCommand: commandsRun++ === 0,
    msSinceActivation: Date.now() - activatedAt,
  });
}

/** Once, after a version 1 user's first print: what changed. */
function showVersion1Note(): void {
  if (!fromVersion1) {
    return;
  }
  fromVersion1 = false;
  void state.update(NOTE_SHOWN, true);
  void show("info", upgrade.NOTE, "What's New", "Settings").then((choice) => {
    if (choice === "What's New") {
      void vscode.env.openExternal(vscode.Uri.parse(upgrade.WHATS_NEW));
    } else if (choice === "Settings") {
      void vscode.commands.executeCommand("workbench.action.openSettings", "code2pdf");
    }
  });
}

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
    askWhereToSave: config.get<boolean>("askWhereToSave", false),
    openWith: config.get<"viewer" | "editor" | "none">("openWith", "editor"),
    executable: config.get<string>("executable", ""),
  };
}

// Finding code2pdf

async function code2pdf(from: OfferedFrom = "print"): Promise<cli.Code2pdf | undefined> {
  if (found) {
    return found;
  }
  try {
    const result = await lookUpShown();
    log.appendLine(`Using ${result.command}: code2pdf ${result.version} (${result.installKind})`);
    return result;
  } catch (error) {
    if (error instanceof cli.NotInstalled) {
      await offerInstall(error, from);
      return undefined;
    }
    if (error instanceof cli.TooOld) {
      await offerUpdate(error.found, from);
      return undefined;
    }
    throw error;
  }
}

/**
 * Finds code2pdf for the current setting and remembers it, unless it was forgotten while it
 * looked: an older, slower lookup finishing last mustn't bring back the old code2pdf. A lookup
 * already running (the one activation starts) is shared: code2pdf.exe can take seconds to start.
 */
function lookUp(): Promise<cli.Code2pdf> {
  const started = generation;
  if (looking?.generation !== started) {
    const result = cli.find(settings().executable).then((ready) => {
      if (started === generation) {
        found = ready;
      }
      return ready;
    });
    looking = { generation: started, result };
    const done = () => {
      if (looking?.result === result) {
        looking = undefined;
      }
    };
    result.then(done, done);
  }
  return looking.result;
}

/** lookUp(), with a notification if it takes more than a moment, so a print never seems to do nothing. */
async function lookUpShown(): Promise<cli.Code2pdf> {
  const result = lookUp();
  const settled = result.then(() => true, () => true);
  if (!(await Promise.race([settled, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))]))) {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Checking code2pdf…" }, () => settled);
  }
  return result;
}

/** Forgets the code2pdf found, so the next print looks again. */
function forgetFound(): void {
  generation++;
  found = undefined;
}

/** Sets the code2pdf.installed context (for the walkthrough), without any message. */
async function checkInstalled(): Promise<telemetry.EventData<"activated">> {
  let status: telemetry.EventData<"activated">;
  try {
    const ready = await lookUp();
    status = { cli: "found", cliVersion: ready.version, installKind: ready.installKind };
  } catch (error) {
    status = error instanceof cli.TooOld
      ? { cli: "tooOld", cliVersion: error.found.version, installKind: error.found.installKind }
      : { cli: error instanceof cli.NotInstalled ? (error.fromSetting ? "notAtSetting" : "missing") : "error" };
  }
  await vscode.commands.executeCommand("setContext", "code2pdf.installed", status.cli === "found");
  return status;
}

function osRelease() {
  try {
    return parseOsRelease(fs.readFileSync("/etc/os-release", "utf8"));
  } catch {
    return undefined;
  }
}

/** Such as "ubuntu 24.04". */
function distro(): string | undefined {
  const release = osRelease();
  return release ? `${release.id} ${release.versionId}` : undefined;
}

/** The install (or update) command for this machine, and what to say about it. */
function howToInstall(old?: cli.Code2pdf): { installs: InstallCommand[]; message: string } {
  if (old) {
    const update = updateCommand(old, os.homedir(), cli.windowsInstallDir());
    return {
      installs: update ? [update] : [],
      message: `This extension needs code2pdf ${cli.MIN_VERSION.join(".")} or later, and ${old.command} is ${old.version}.` +
        (update?.download ? ` ${update.label} ${update.how}.` : update ? ` It updates ${update.how}, in a terminal.` : ""),
    };
  }
  const installs = installCommands(process.platform, hasBrew(), osRelease());
  const intro = fromVersion1 ? upgrade.INSTALL_INTRO : "This extension prints with the code2pdf command-line tool, which isn't installed.";
  if (installs[0]?.download) {
    return { installs, message: `${intro} ${installs[0].label} ${installs[0].how}.` };
  }
  if (installs.length) {
    return { installs, message: `${intro} It installs ${installs.map((i) => i.how).join(" or ")}, in a terminal.` };
  }
  if (process.platform === "darwin") {
    return { installs, message: `${intro} It installs with Homebrew, which isn't installed either: install Homebrew from brew.sh, then run "code2pdf: Install the Command-Line Tool".` };
  }
  return { installs, message: intro };
}

function hasBrew(): boolean {
  for (const brew of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew", "/home/linuxbrew/.linuxbrew/bin/brew"]) {
    if (fs.existsSync(brew)) {
      return true;
    }
  }
  return (process.env.PATH ?? "").split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, "brew")));
}

async function offerInstall(error: cli.NotInstalled, from: OfferedFrom): Promise<void> {
  log.appendLine(`code2pdf not found; looked for: ${error.looked.join(", ")}`);
  if (error.fromSetting) {
    const choice = await vscode.window.showErrorMessage(
      `code2pdf isn't at ${error.looked[0]}, where the code2pdf.executable setting says it is.`, "Open Settings");
    record("installOffered", { reason: "notAtSetting", from, offered: "Open Settings", choice: choice ?? "dismissed" });
    if (choice) {
      void vscode.commands.executeCommand("workbench.action.openSettings", "code2pdf.executable");
    }
    return;
  }
  await offer(howToInstall(), "missing", from);
}

async function offerUpdate(old: cli.Code2pdf, from: OfferedFrom): Promise<void> {
  await offer(howToInstall(old), "tooOld", from);
}

async function offer({ installs, message }: ReturnType<typeof howToInstall>, reason: "missing" | "tooOld", from: OfferedFrom): Promise<void> {
  if (downloading) {
    // A print during the download: Print Now comes when it's done
    void show("info", STILL_DOWNLOADING);
    return;
  }
  const homebrew = !installs.length && process.platform === "darwin";
  const buttons = [...installs.map((i) => i.label), ...(homebrew ? ["Open brew.sh"] : []), "Installation Guide"];
  const choice = await vscode.window.showWarningMessage(message, ...buttons);
  record("installOffered", { reason, from, offered: buttons.join(", "), choice: choice ?? "dismissed" });
  const install = installs.find((i) => i.label === choice);
  if (install?.download) {
    await downloadWindowsBuild(install.label);
  } else if (install) {
    installing = { command: install.label, started: Date.now() };
    runInTerminal(install.label.startsWith("Update") ? "Update code2pdf" : "Install code2pdf", install.command ?? "", install.asks);
  } else if (choice === "Open brew.sh") {
    void vscode.env.openExternal(vscode.Uri.parse("https://brew.sh"));
  } else if (choice === "Installation Guide") {
    void vscode.env.openExternal(vscode.Uri.parse(INSTALL_GUIDE));
  }
}

/** The Install command (and the walkthrough's button): install, update, or say it's ready. */
async function installOrCheck(): Promise<undefined> {
  try {
    const ready = await lookUp();
    await vscode.commands.executeCommand("setContext", "code2pdf.installed", true);
    void show("info", `code2pdf ${ready.version} is installed (${ready.installKind}). Right-click a folder or file and choose Print to PDF.`);
  } catch (error) {
    if (error instanceof cli.NotInstalled) {
      await offerInstall(error, "installCommand");
    } else if (error instanceof cli.TooOld) {
      await offerUpdate(error.found, "installCommand");
    } else {
      throw error;
    }
  }
  return undefined;
}

/**
 * Windows: downloads the Windows build (download.ts), with a cancellable progress message. Only
 * once: another message's Install button, clicked meanwhile or later, doesn't download it again.
 */
async function downloadWindowsBuild(label: string): Promise<void> {
  if (downloading) {
    void show("info", STILL_DOWNLOADING);
    return;
  }
  if (found) {
    // Installed since this message was shown, from another one
    await ready(found);
    return;
  }
  const dir = cli.windowsInstallDir();
  log.appendLine(`\n${label}: the Windows build, into ${dir}`);
  const mb = (bytes: number) => (bytes / 1e6).toFixed(0);
  downloading = true;
  installing = { command: label, started: Date.now() };
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${label}`, cancellable: true },
      (progress, token) => {
        let shown = 0;
        return download.installWindowsBuild(dir, {
          cancellation: token,
          log: (line) => log.appendLine(line),
          onProgress: (received, total) => {
            const done = total ? (received / total) * 100 : 0;
            progress.report({ message: total ? `${mb(received)} of ${mb(total)} MB` : `${mb(received)} MB`, increment: done - shown });
            shown = done;
          },
          onStep: (step) => progress.report({ message: step }),
        });
      });
  } catch (error) {
    downloading = false;
    if (error instanceof download.Cancelled) {
      log.appendLine("Stopped; nothing was changed.");
      installFinished({ outcome: "cancelled" });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    log.appendLine(`Error: ${message}`);
    installFinished({ outcome: "failed" });
    const choice = await show("error", `code2pdf couldn't be installed: ${message}.`, "Show Output", "Installation Guide");
    if (choice === "Show Output") {
      log.show(true);
    } else if (choice === "Installation Guide") {
      void vscode.env.openExternal(vscode.Uri.parse(INSTALL_GUIDE));
    }
    return;
  }
  forgetFound();
  let installed: cli.Code2pdf;
  try {
    installed = await lookUp();
  } catch (error) {
    // Installed, but not found where it was put, or still too old: say so the usual way
    installFinished({ outcome: "failed" });
    throw error;
  } finally {
    downloading = false;
  }
  await ready(installed);
}

/** code2pdf is ready after an install: say so, and offer to run the print that needed it. */
async function ready(found: cli.Code2pdf): Promise<void> {
  installFinished({ outcome: "ready", cliVersion: found.version, installKind: found.installKind });
  log.appendLine(`code2pdf is ready: ${found.command}, ${found.version} (${found.installKind})`);
  await vscode.commands.executeCommand("setContext", "code2pdf.installed", true);
  const retry = lastPrint;
  const choice = await show("info", `code2pdf ${found.version} is installed.` + (retry ? "" : " Right-click a folder or file and choose Print to PDF."),
    ...(retry ? ["Print Now"] : []));
  if (choice === "Print Now" && retry) {
    void vscode.commands.executeCommand(retry.id, ...retry.args);
  }
}

function runInTerminal(name: string, command: string, asks?: string): void {
  const terminal = vscode.window.createTerminal({ name });
  terminal.show();
  terminal.sendText(command);
  forgetFound();
  watchForInstall();
  void vscode.window.showInformationMessage(`${name} is running in the terminal. ${asks ? `${asks} ` : ""}You'll get a message here when it's ready.`);
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
      installFinished({ outcome: "gaveUp" });
      return;
    }
    checking = true;
    try {
      const installed = await lookUp();
      if (!installWatch) {
        return;
      }
      stopInstallWatch();
      await ready(installed);
    } catch {
      // Not there yet (or still too old): look again
    } finally {
      checking = false;
    }
  }, intervalMs);
}

/** Records how the install started from a message ended (once). */
function installFinished(data: telemetry.EventData<"installFinished">): void {
  if (installing) {
    record("installFinished", { ...data, command: installing.command, seconds: Math.round((Date.now() - installing.started) / 1000) });
    installing = undefined;
  }
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

/**
 * The folder PDFs go to without asking: the outputFolder setting, or code2pdf_generated_pdf in
 * WORKSPACE (save.ts). Not next to a file opened on its own, which may be in Downloads, say:
 * macOS may ask before VS Code writes there.
 */
async function saveFolder(workspace: string | undefined): Promise<string> {
  const folder = settings().outputFolder;
  if (!folder) {
    return save.pdfFolder(workspace && workspaceFolderOf(vscode.Uri.file(workspace)) ? workspace : undefined);
  }
  const absolute = specs.expandHome(folder, os.homedir());
  return path.isAbsolute(absolute) ? absolute : path.join(workspace ?? os.homedir(), absolute);
}

/** How the PDF's place is decided, for usage data. */
function saveTo(): "dialog" | "folderSetting" | "default" {
  const { askWhereToSave, outputFolder } = settings();
  return askWhereToSave ? "dialog" : outputFolder ? "folderSetting" : "default";
}

/**
 * Where to save NAME, printed from FROM: in saveFolder(), under a name that doesn't replace a file
 * code2pdf didn't make from FROM, or where a save dialog says if askWhereToSave is on.
 * Undefined if the dialog was cancelled.
 */
async function outputPath(name: string, workspace: string | undefined, kind: PrintKind, from: string): Promise<string | undefined> {
  const source = `${kind} ${from}`;
  const made = state.get<Record<string, string>>(MADE, {});
  let pdf: string;
  if (settings().askWhereToSave) {
    const last = state.get<string>("lastFolder");
    const start = last && isFolder(last) ? last : (await save.desktop()) ?? os.homedir();
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(start, name)),
      filters: { PDF: ["pdf"] },
      saveLabel: "Print",
      title: "Save the PDF",
    });
    if (!uri) {
      record("print", { kind, outcome: "saveCancelled", saveTo: "dialog" });
      return undefined;
    }
    await state.update("lastFolder", path.dirname(uri.fsPath));
    pdf = uri.fsPath.toLowerCase().endsWith(".pdf") ? uri.fsPath : `${uri.fsPath}.pdf`;
  } else {
    pdf = save.freePath(await saveFolder(workspace), name, source, made);
  }
  await state.update(MADE, save.remember(made, pdf, source));
  return pdf;
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
  const output = await outputPath(`${specs.fileNamePart(specs.stem(file.fsPath))}.pdf`, root, "file", file.fsPath);
  if (!output) {
    return undefined;
  }
  return execute({ kind: "file", title: `Printing ${rel}`, cwd: root, args: args.fileArgs(rel, output, settings(file).print), output });
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
  const output = await outputPath(specs.selectionPdfName(file.fsPath, ranges), root, "selection", file.fsPath);
  if (!output) {
    return undefined;
  }
  return execute({ kind: "selection", title: `Printing ${spec}`, cwd: root, args: args.fileArgs(spec, output, settings(file).print), output });
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
  const output = await outputPath(`${specs.fileNamePart(path.basename(folder.fsPath))}.pdf`, root, "folder", folder.fsPath);
  if (!output) {
    return undefined;
  }
  return execute({ kind: "folder", title: `Printing ${rel === "." ? path.basename(root) : rel}`, cwd: root, args: args.folderArgs(rel, output, settings(folder).print), output });
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
  const output = await outputPath(`${specs.fileNamePart(path.basename(root))}-selected.pdf`, root, "files", root);
  if (!output) {
    return undefined;
  }
  return execute({
    kind: "files",
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
  const output = await outputPath(`${specs.fileNamePart(path.basename(folder.fsPath))}.pdf`, root, "chosen", folder.fsPath);
  if (!output) {
    return undefined;
  }
  return execute({
    kind: "chosen",
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
  if (!(await git.repositoryRoot(folder).catch((error: unknown) => {
    if (error instanceof git.GitError) {
      throw new Stop(`Print Changes uses git, which isn't installed${process.platform === "win32" ? ": install Git for Windows from git-scm.com, then try again" : ""}.`, "warning");
    }
    throw error;
  }))) {
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
  const output = await outputPath(`${specs.fileNamePart(name)}.pdf`, folder, "changes", folder);
  if (!output) {
    return undefined;
  }
  return execute({ kind: "changes", title: "Printing changes", cwd: folder, args: args.changedArgs(rev, ".", output, settings(vscode.Uri.file(folder)).print), output });
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
    placeHolder: "Changed lines are marked in the margin",
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
  const begun = Date.now();
  const ended = (outcome: string, data: telemetry.EventData<"print"> = {}) => record("print", {
    kind: job.kind,
    outcome,
    saveTo: saveTo(),
    openWith: settings().openWith,
    seconds: Math.round((Date.now() - begun) / 100) / 10,
    ...data,
  });
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
        forgetFound();  // it was uninstalled or moved: look for it again next time
        const code = (error as NodeJS.ErrnoException).code;
        ended("failed", { error: code ?? "exception" });
        throw code === "ENOENT" ? new Stop(`code2pdf is no longer at ${command.command}. Print again to look for it.`, "error") : error;
      } finally {
        clearInterval(ticker);
      }
    });
  if (result.cancelled) {
    ended("cancelled");
    const removed = process.platform === "win32" ? cli.removeLeftovers(path.dirname(job.output), begun) : [];
    log.appendLine(`Stopped.${removed.length ? ` Removed what it left: ${removed.join(", ")}` : ""}`);
    vscode.window.setStatusBarMessage("code2pdf: stopped; nothing was written", 5000);
    return undefined;
  }
  if (result.code !== 0) {
    ended("failed", { exitCode: String(result.code) });
    if (result.code === 127 || result.code === 126) {
      forgetFound();
    }
    void showWithOutput("error", `code2pdf: ${result.reader.errorMessage() ?? `stopped with exit code ${result.code}`}`);
    return undefined;
  }
  if (!fs.existsSync(job.output)) {
    ended("noPdf");
    void showWithOutput("error", `code2pdf finished, but there's no PDF at ${job.output}.`);
    return undefined;
  }
  ended("printed", { pages: result.reader.pages ?? 0, warnings: result.reader.warnings.length });
  await finished(job.output, result.reader, saveTo());
  showVersion1Note();
  return job.output;
}

/**
 * Opens the PDF as the openWith setting says, and says what code2pdf warned about. The first PDF
 * saved without asking also says where it went, with a button to change that.
 */
async function finished(pdf: string, reader: OutputReader, savedBy: ReturnType<typeof saveTo>): Promise<void> {
  const name = path.basename(pdf);
  const pages = reader.pages ? `, ${reader.pages.toLocaleString("en-US")} page${reader.pages === 1 ? "" : "s"}` : "";
  const remarks = [...reader.warnings, ...reader.notes];
  const remark = remarks.length ? ` ${remarks[0]}${remarks.length > 1 ? ` (and ${remarks.length - 1} more in the output)` : ""}` : "";
  const level = reader.warnings.length ? "warning" : "info";
  const openWith = settings().openWith;
  const remote = vscode.env.remoteName;
  const uri = vscode.Uri.file(pdf);
  // Version 1 users hear where PDFs go in their own note (showVersion1Note)
  const firstSave = savedBy === "default" && !state.get<boolean>(SAVE_NOTE_SHOWN);
  if (firstSave) {
    void state.update(SAVE_NOTE_SHOWN, true);
  }
  const sayWhere = firstSave && !fromVersion1;

  if (openWith === "viewer" && !remote) {
    await vscode.env.openExternal(uri);
  } else if (openWith === "editor") {
    await pdfTab.open(uri);
  }
  const opened = (openWith === "viewer" && !remote) || openWith === "editor";
  if (opened && !remarks.length && !sayWhere) {
    vscode.window.setStatusBarMessage(`$(check) code2pdf: ${name}${pages}`, 8000);
    return;
  }
  const where = remote ? `${pdf} (on ${remote})` : pdf;
  const dir = path.dirname(pdf);
  const message = sayWhere
    ? `Saved ${name}${pages} in ${save.tilde(dir)}${save.ignored(dir) ? ", which git ignores" : ""}. PDFs go there unless you choose another place.${remark}`
    : opened ? `Saved ${name}${pages}.${remark}` : `Saved ${where}${pages}.${remark}`;
  const buttons = [
    ...(opened ? [] : remote ? ["Open in VS Code"] : ["Open"]),
    ...(remote ? ["Copy Path"] : [process.platform === "darwin" ? "Reveal in Finder" : "Show in Folder"]),
    ...(sayWhere ? ["Change…"] : []),
    ...(remarks.length ? ["Show Output"] : []),
  ];
  // Not awaited: the command is done, whether or not the message is ever clicked
  void show(level, message, ...buttons).then((choice) => {
    if (choice === "Open") {
      void vscode.env.openExternal(uri);
    } else if (choice === "Open in VS Code") {
      void pdfTab.open(uri);
    } else if (choice === "Copy Path") {
      void vscode.env.clipboard.writeText(pdf);
    } else if (choice === "Reveal in Finder" || choice === "Show in Folder") {
      void vscode.commands.executeCommand("revealFileInOS", uri);
    } else if (choice === "Change…") {
      void guard(chooseOutputFolder);
    } else if (choice === "Show Output") {
      log.show(true);
    }
  });
}

/** Sets a code2pdf setting where it's set now (this workspace, or else the user's settings). */
async function updateSetting(key: string, value: unknown): Promise<void> {
  const config = vscode.workspace.getConfiguration("code2pdf");
  const target = config.inspect(key)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await config.update(key, value, target);
}

/** The Choose Where PDFs Go command, and the Change… button after the first PDF. */
async function chooseOutputFolder(): Promise<undefined> {
  const { outputFolder, askWhereToSave } = settings();
  const home = os.homedir();
  const desktop = await save.desktop();
  const setTo = outputFolder && path.resolve(specs.expandHome(outputFolder, home));
  const now = askWhereToSave ? "ask"
    : !outputFolder ? "default"
    : outputFolder === "." ? "project"
    : desktop && setTo && save.samePath(setTo, desktop) ? "desktop" : "other";
  type Item = vscode.QuickPickItem & { choice: typeof now };
  const items: Item[] = [
    { choice: "default", label: `${save.FOLDER} in the workspace folder`, description: "git ignores it" },
    ...(desktop ? [{ choice: "desktop" as const, label: save.tilde(desktop), description: "the Desktop" }] : []),
    { choice: "project", label: "The workspace folder itself", description: "next to the code, as version 1 did" },
    { choice: "other", label: "Another folder…", description: now === "other" ? outputFolder : undefined },
    { choice: "ask", label: "Ask each time", description: "a save dialog for every PDF" },
  ];
  for (const item of items) {
    if (item.choice === now) {
      item.label = `$(check) ${item.label}`;
    }
  }
  const picked = await vscode.window.showQuickPick(items, { title: "Where should PDFs go?", placeHolder: "Choose where code2pdf saves each PDF" });
  if (!picked) {
    return undefined;
  }
  if (picked.choice === "ask") {
    await updateSetting("askWhereToSave", true);
    void show("info", "code2pdf will ask where to save each PDF.");
    return undefined;
  }
  let folder: string | undefined;  // undefined: the default, code2pdf_generated_pdf
  if (picked.choice === "project") {
    folder = ".";
  } else if (picked.choice === "desktop" && desktop) {
    folder = save.tilde(desktop);  // "~/Desktop" works on each Mac and Linux machine that Settings Sync shares it with
  } else if (picked.choice === "other") {
    const chosen = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Save PDFs Here", defaultUri: vscode.Uri.file(desktop ?? home),
    });
    if (!chosen?.[0]) {
      return undefined;
    }
    folder = chosen[0].fsPath;
  }
  await updateSetting("outputFolder", folder);
  await updateSetting("askWhereToSave", undefined);
  const where = folder === undefined ? `into ${save.FOLDER} in the workspace folder`
    : folder === "." ? "into the workspace folder" : `to ${save.tilde(specs.expandHome(folder, home))}`;
  // macOS asks before VS Code, or code2pdf, writes to the Desktop for the first time
  const mac = picked.choice === "desktop" && process.platform === "darwin" && !vscode.env.remoteName
    ? ` If macOS asks whether ${vscode.env.appName} may access files in your Desktop folder, choose Allow.` : "";
  void show("info", `PDFs will go ${where}, without asking.${mac}`);
  return undefined;
}
