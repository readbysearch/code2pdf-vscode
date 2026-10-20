// Where a PDF goes when nobody is asked: a folder in the project that git ignores, and a name
// there that doesn't replace a file code2pdf didn't make. Also the Desktop, found the way each
// system keeps it, for those who choose it. No vscode imports.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Windows keeps the Desktop's real place (moved by OneDrive, say) under this key. */
const SHELL_FOLDERS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders";

/** The Desktop value in `reg query` output, with %VARIABLES% filled in from ENV. */
export function parseRegistry(output: string, env: NodeJS.ProcessEnv): string | undefined {
  const match = /^\s*Desktop\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(output);
  if (!match) {
    return undefined;
  }
  const value = match[1].replace(/%([^%]+)%/g, (all, name: string) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? (env[key] ?? all) : all;
  });
  return value.includes("%") ? undefined : value;
}

/** XDG_DESKTOP_DIR in ~/.config/user-dirs.dirs, which is "~/桌面" on a Chinese desktop, say. */
export function parseUserDirs(text: string, home: string): string | undefined {
  const match = /^\s*XDG_DESKTOP_DIR\s*=\s*"([^"]*)"/m.exec(text);
  if (!match) {
    return undefined;
  }
  const dir = match[1].replace(/^\$HOME(?=\/|$)/, home);
  // "$HOME/" alone means no Desktop folder
  return path.isAbsolute(dir) && path.resolve(dir) !== path.resolve(home) ? path.normalize(dir) : undefined;
}

function registryDesktop(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("reg", ["query", SHELL_FOLDERS, "/v", "Desktop"], { timeout: 10_000, windowsHide: true }, (error, stdout) =>
      resolve(error ? undefined : parseRegistry(stdout, env)));
  });
}

function isFolder(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** The folder in the project that PDFs go to when nobody chose one. */
export const FOLDER = "code2pdf_generated_pdf";

/** Put in FOLDER when it's made, so git never shows it or offers to commit it. */
export const GITIGNORE = "# Made by code2pdf for the PDFs it prints: git ignores this folder.\n*\n";

function writable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return isFolder(dir);
  } catch {
    return false;
  }
}

/**
 * FOLDER in PROJECT (the workspace folder printed from), made with a .gitignore if it's new; in
 * the home folder if there's no project, or it can't be written to. VS Code can already reach
 * the project, so on a Mac this never asks for access to the Desktop or Documents, and on a
 * remote or in a container the PDFs are where the code is.
 */
export function pdfFolder(project: string | undefined, home = os.homedir()): string {
  for (const dir of project ? [project, home] : [home]) {
    const folder = path.join(dir, FOLDER);
    try {
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, ".gitignore"), GITIGNORE);
    } catch {
      // There already, or this place can't be written to
    }
    if (writable(folder)) {
      return folder;
    }
  }
  return home;
}

/** Whether git ignores DIR because code2pdf's .gitignore is in it. */
export function ignored(dir: string): boolean {
  try {
    return fs.readFileSync(path.join(dir, ".gitignore"), "utf8") === GITIGNORE;
  } catch {
    return false;
  }
}

let cached: string | undefined;

/** The Desktop, or undefined if there's none (a server, or a container). */
export async function desktop(home = os.homedir(), env = process.env, platform = process.platform): Promise<string | undefined> {
  if (cached && isFolder(cached)) {
    return cached;
  }
  const desktops: (string | undefined)[] = [];
  if (platform === "win32") {
    desktops.push(await registryDesktop(env));
  } else if (platform === "linux") {
    try {
      desktops.push(parseUserDirs(fs.readFileSync(path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "user-dirs.dirs"), "utf8"), home));
    } catch {
      // No user-dirs.dirs: a server, or a desktop that doesn't use it
    }
  }
  desktops.push(path.join(home, "Desktop"));
  cached = desktops.find((dir) => dir !== undefined && isFolder(dir));
  return cached;
}

/** For tests: forget the Desktop found. */
export function forget(): void {
  cached = undefined;
}

/** File systems on macOS and Windows ignore case by default, so "Util.pdf" is "util.pdf". */
export function samePath(a: string, b: string, platform = process.platform): boolean {
  return platform === "darwin" || platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Where to save NAME in DIR: NAME itself if it's free, or if code2pdf made it from the same
 * SOURCE (printing again replaces it); otherwise "NAME (2).pdf", "(3)"… MADE maps each PDF made
 * here to its source, such as the workspace folder it came from.
 */
export function freePath(dir: string, name: string, source: string, made: Record<string, string>,
  exists: (file: string) => boolean = fs.existsSync, platform = process.platform): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    if (!exists(candidate)) {
      return candidate;
    }
    const from = Object.keys(made).find((file) => samePath(file, candidate, platform));
    if (from !== undefined && made[from] === source) {
      return candidate;
    }
  }
}

/** MADE with FILE (from SOURCE) added, keeping the latest LIMIT. */
export function remember(made: Record<string, string>, file: string, source: string, limit = 200, platform = process.platform): Record<string, string> {
  const kept = Object.entries(made).filter(([other]) => !samePath(other, file, platform));
  return Object.fromEntries([...kept, [file, source] as [string, string]].slice(-limit));
}

/** "~/Desktop" rather than the full path, for messages and settings; on Windows, which doesn't write "~", the full path. */
export function tilde(dir: string, home = os.homedir(), platform = process.platform): string {
  const relative = path.relative(home, dir);
  return platform !== "win32" && relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? `~/${relative}` : dir;
}
