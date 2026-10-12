// Finding the code2pdf command, checking its version, and running it. No vscode imports.

import { execFile, spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { OutputReader, ProgressUpdate } from "./progress";
import { expandHome } from "./specs";

/** The oldest code2pdf with everything this extension uses (`--changed` came in 3.12). */
export const MIN_VERSION: readonly [number, number] = [3, 12];

export interface Code2pdf {
  /** The command to run: a path, or "code2pdf" when it was found on PATH. */
  command: string;
  version: string;
  /** "Homebrew", "Debian package", "install.sh", "git checkout", … as `code2pdf --version` says. */
  installKind: string;
  installDir: string;
}

/** No code2pdf where we looked. */
export class NotInstalled extends Error {
  constructor(readonly looked: readonly string[], readonly fromSetting: boolean) {
    super(fromSetting ? `code2pdf isn't at ${looked[0]}` : "code2pdf isn't installed");
  }
}

/** A code2pdf older than MIN_VERSION. */
export class TooOld extends Error {
  constructor(readonly found: Code2pdf) {
    super(`code2pdf ${found.version} is older than ${MIN_VERSION.join(".")}`);
  }
}

/** Version and install details from `code2pdf --version` output. */
export function parseVersion(output: string): Omit<Code2pdf, "command"> | undefined {
  const first = output.match(/^code2pdf (\S+)/m);
  if (!first) {
    return undefined;
  }
  const version = first[1].startsWith("(") ? "unknown" : first[1];
  const installed = output.match(/^\s*installed: ([^,\n]+)(?:, (.+))?$/m);
  return {
    version,
    installKind: installed?.[1].trim() ?? "unknown",
    installDir: installed?.[2]?.trim() ?? "",
  };
}

/**
 * Whether VERSION ("3.12", "3.12.1", "3.12+3") is MIN or later. Versions that aren't numbers
 * ("unreleased", "unknown") come from git checkouts, which are taken to be new enough.
 */
export function isNewEnough(version: string, min: readonly [number, number] = MIN_VERSION): boolean {
  const m = version.match(/^(\d+)\.(\d+)/);
  if (!m) {
    return !/^\d/.test(version);
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > min[0] || (major === min[0] && minor >= min[1]);
}

/**
 * Where to look for code2pdf: the setting if there is one; otherwise PATH, then the folders the
 * installers use, for when VS Code was started without the login shell's PATH.
 */
export function candidates(setting: string, home = os.homedir(), platform = process.platform): string[] {
  if (setting.trim()) {
    return [expandHome(setting.trim(), home)];
  }
  if (platform === "win32") {
    return ["code2pdf"];
  }
  return [
    "code2pdf",
    "/opt/homebrew/bin/code2pdf",
    "/usr/local/bin/code2pdf",
    "/home/linuxbrew/.linuxbrew/bin/code2pdf",
    path.join(home, ".local", "bin", "code2pdf"),
    "/usr/bin/code2pdf",
  ];
}

/** `COMMAND --version` output, or undefined if COMMAND can't be run. */
function versionOutput(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, ["--version"], { timeout: 60_000 }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT" || code === "EACCES" || code === "ENOTDIR") {
        resolve(undefined);
      } else {
        resolve(`${stdout}\n${stderr}`);
      }
    });
  });
}

/** Finds code2pdf, or throws NotInstalled or TooOld. */
export async function find(setting: string): Promise<Code2pdf> {
  const looked = candidates(setting);
  for (const command of looked) {
    const output = await versionOutput(command);
    if (output === undefined) {
      continue;
    }
    const parsed = parseVersion(output);
    // Before 3.7 there was no --version, so a code2pdf that runs but doesn't say is old
    const found: Code2pdf = { command, ...(parsed ?? { version: "older than 3.7", installKind: "unknown", installDir: "" }) };
    if (!parsed || !isNewEnough(parsed.version)) {
      throw new TooOld(found);
    }
    return found;
  }
  throw new NotInstalled(looked, Boolean(setting.trim()));
}

/** Like vscode.CancellationToken, without depending on vscode. */
export interface Cancellation {
  isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): unknown;
}

export interface RunOptions {
  cwd: string;
  args: readonly string[];
  /** Written to code2pdf's stdin (the list for `--files-from -`). */
  input?: string;
  onProgress?: (update: ProgressUpdate) => void;
  /** Everything code2pdf writes, for the output log. */
  onOutput?: (text: string) => void;
  cancellation?: Cancellation;
  /** Stdout is data (a file list), not messages. */
  quietStdout?: boolean;
  /** How long to wait after Ctrl-C before killing it. */
  graceMs?: number;
}

export interface RunResult {
  code: number | null;
  cancelled: boolean;
  stdout: string;
  reader: OutputReader;
}

/**
 * Runs code2pdf. Cancelling sends Ctrl-C (SIGINT) to its whole process group, as a terminal
 * would, so code2pdf stops cleanly and removes its temporary files; it is killed if it hasn't
 * stopped after a few seconds.
 */
export function run(command: string, options: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const reader = new OutputReader(options.onProgress);
    const ownGroup = process.platform !== "win32";
    const child = spawn(command, [...options.args], {
      cwd: options.cwd,
      detached: ownGroup,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let cancelled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const signal = (name: NodeJS.Signals) => {
      try {
        if (ownGroup && child.pid) {
          process.kill(-child.pid, name);
        } else {
          child.kill(name);
        }
      } catch {
        // It has already exited
      }
    };
    options.cancellation?.onCancellationRequested(() => {
      if (cancelled || child.exitCode !== null) {
        return;
      }
      cancelled = true;
      signal("SIGINT");
      killTimer = setTimeout(() => signal("SIGKILL"), options.graceMs ?? 5000);
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      stdout += text;
      if (!options.quietStdout) {
        reader.feed(text, "stdout");
      }
      options.onOutput?.(text);
    });
    child.stderr.on("data", (text: string) => {
      reader.feed(text);
      options.onOutput?.(text);
    });
    child.stdin.on("error", () => {
      // code2pdf exited before reading all of stdin; its exit code says why
    });
    child.on("error", (error) => {
      clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      reader.end();
      resolve({ code, cancelled, stdout, reader });
    });

    child.stdin.end(options.input ?? "");
  });
}
