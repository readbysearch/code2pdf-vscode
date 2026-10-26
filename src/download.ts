// Installing code2pdf on Windows: the Windows build attached to code2pdf's latest GitHub release,
// checked against its SHA-256, unpacked with Windows' own tar, and swapped in for the old one.
// No vscode imports.

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import type { Cancellation } from "./cli";

export const RELEASE = "https://github.com/readbysearch/code2pdf/releases/latest/download/";
export const ZIP = "code2pdf-windows-x64.zip";

/** The user cancelled; what was downloaded is gone and the old code2pdf is untouched. */
export class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

/** Where an install stopped: getting ready, the download, its SHA-256, unpacking, running it, or the swap. */
export type Step = "prepare" | "download" | "damaged" | "unpack" | "check" | "swap";

/**
 * The install failed at STEP. For the usage event, CODE is the system error code (ENOTFOUND,
 * EPERM…), the HTTP status ("HTTP 404") or "timeout", and EXITCODE is code2pdf.exe's exit code
 * when it didn't run: never the message, which has paths in it.
 */
export class InstallFailed extends Error {
  constructor(message: string, readonly step: Step, readonly code?: string, readonly exitCode?: number, options?: ErrorOptions) {
    super(message, options);
  }
}

/** The code and exit code that InstallFailed carries, from an error thrown along the way. */
function reasonOf(error: unknown): { code?: string; exitCode?: number } {
  const { code, killed } = (error ?? {}) as { code?: unknown; killed?: boolean };
  if (killed) {
    return { code: "timeout" };
  }
  if (typeof code === "number") {
    return { exitCode: code };
  }
  return typeof code === "string" && /^(?:[A-Z][A-Z0-9_]*|HTTP \d{3})$/.test(code) ? { code } : {};
}

/** An Error with MESSAGE that keeps CAUSE's code, for reasonOf. */
function withCode(message: string, cause: unknown, code = (cause as { code?: unknown } | undefined)?.code): Error {
  return Object.assign(new Error(message, { cause }), { code, killed: (cause as { killed?: boolean } | undefined)?.killed });
}

export interface DownloadOptions {
  /** Where the zip and its .sha256 are: the latest release, or a test server. */
  base?: string;
  onProgress?: (received: number, total: number | undefined) => void;
  /** What it's doing after the download, which takes a while too: unpacking, then checking it runs. */
  onStep?: (step: string) => void;
  cancellation?: Cancellation;
  log?: (line: string) => void;
  /** How long code2pdf.exe gets to answer --version; it's installed anyway if it doesn't. 5 minutes. */
  checkTimeout?: number;
  /** How long a download may go without data before it fails (ETIMEDOUT). 30 s. */
  stallTimeout?: number;
  /** The wait before a download is tried again, or a locked folder renamed again. 2 s and 1 s. */
  retryDelay?: number;
}

const CHECK_TIMEOUT = 300_000;
const STALL_TIMEOUT = 30_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const stalled = (ms: number) => withCode(`the download stalled: nothing arrived for ${Math.round(ms / 1000)} s`, undefined, "ETIMEDOUT");

/** GETs URL, following redirects (GitHub sends release downloads elsewhere). */
function get(url: string, options: DownloadOptions, redirects = 5): Promise<http.IncomingMessage> {
  const stall = options.stallTimeout ?? STALL_TIMEOUT;
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const request = client.get(url, { headers: { "User-Agent": "code2pdf-vscode" } }, (response) => {
      request.setTimeout(0);  // the body has its own watch (watchStall)
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location && redirects > 0) {
        response.resume();
        resolve(get(new URL(response.headers.location, url).toString(), options, redirects - 1));
      } else if (status === 200) {
        resolve(response);
      } else {
        response.resume();
        reject(withCode(`the download failed: ${url} answered ${status}`, undefined, `HTTP ${status}`));
      }
    });
    // Until the answer's headers arrive; a connection that goes silent would otherwise wait forever
    request.setTimeout(stall, () => request.destroy(stalled(stall)));
    request.on("error", (error) => reject(error instanceof Cancelled ? error : withCode(`the download failed: ${error.message}`, error)));
    options.cancellation?.onCancellationRequested(() => request.destroy(new Cancelled()));
  });
}

/** Fails RESPONSE with ETIMEDOUT when no data arrives for a while. */
function watchStall(response: http.IncomingMessage, options: DownloadOptions): void {
  const stall = options.stallTimeout ?? STALL_TIMEOUT;
  let timer = setTimeout(() => response.destroy(stalled(stall)), stall);
  response.on("data", () => {
    clearTimeout(timer);
    timer = setTimeout(() => response.destroy(stalled(stall)), stall);
  });
  response.on("close", () => clearTimeout(timer));
}

async function text(url: string, options: DownloadOptions): Promise<string> {
  const response = await get(url, options);
  watchStall(response, options);
  let body = "";
  response.setEncoding("utf8");
  for await (const chunk of response) {
    body += chunk;
  }
  return body;
}

/** Saves URL to FILE and returns its SHA-256. */
async function save(url: string, file: string, options: DownloadOptions): Promise<string> {
  const response = await get(url, options);
  watchStall(response, options);
  const total = Number(response.headers["content-length"]) || undefined;
  const hash = createHash("sha256");
  const out = fs.createWriteStream(file);
  let received = 0;
  await new Promise<void>((resolve, reject) => {
    options.cancellation?.onCancellationRequested(() => response.destroy(new Cancelled()));
    response.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      received += chunk.length;
      options.onProgress?.(received, total);
    });
    response.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    response.pipe(out);
  });
  if (total !== undefined && received !== total) {
    throw withCode(`the download stopped after ${received} of ${total} bytes`, undefined, "ECONNRESET");
  }
  return hash.digest("hex");
}

/**
 * WHAT, and once more if the network let it down: a connection that dropped or stalled, not a
 * server's answer (HTTP 404) or a cancel. The usage data saw a download end in ECONNRESET and
 * work on the next try.
 */
async function retrying<T>(what: () => Promise<T>, options: DownloadOptions, log: (line: string) => void): Promise<T> {
  try {
    return await what();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (error instanceof Cancelled || (typeof code === "string" && code.startsWith("HTTP "))) {
      throw error;
    }
    log(`${error instanceof Error ? error.message : String(error)}; trying once more`);
    await sleep(options.retryDelay ?? 2000);
    if (options.cancellation?.isCancellationRequested) {
      throw new Cancelled();
    }
    return await what();
  }
}

/**
 * Renames FROM to TO, trying again for some seconds when Windows says the folder is locked
 * (EPERM, EBUSY, EACCES): antivirus often still has what was just unpacked open. The usage data
 * saw a first install fail at the swap with EPERM and work five minutes later.
 */
async function rename(from: string, to: string, options: DownloadOptions, log: (line: string) => void): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (attempt >= 10 || !["EPERM", "EBUSY", "EACCES"].includes(code)) {
        throw error;
      }
      if (attempt === 1) {
        log(`${code} renaming ${path.basename(from)}: trying again for a few seconds`);
      }
      await sleep(options.retryDelay ?? 1000);
    }
  }
}

function run(command: string, args: readonly string[], timeout = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout, windowsHide: true }, (error, stdout, stderr) =>
      error ? reject(withCode(`${path.basename(command)} ${args[0] ?? ""} failed: ${(stderr || error.message).trim()}`, error)) : resolve(stdout));
  });
}

/** Windows' own tar (Windows 10 1803 and later) unpacks zips; so does macOS's, for the tests. */
function tar(): string {
  return process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
}

/** Removes what an earlier install left next to DIR, if it was stopped halfway. */
function removeLeftovers(dir: string): void {
  const parent = path.dirname(dir);
  const base = path.basename(dir);
  let names: string[];
  try {
    names = fs.readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(`${base}.download-`) || name.startsWith(`${base}.new-`) || name.startsWith(`${base}.old-`)) {
      try {
        fs.rmSync(path.join(parent, name), { recursive: true, force: true });
      } catch {
        // Still in use (an old code2pdf running): next time
      }
    }
  }
}

/**
 * Installs the Windows build into DIR (code2pdf.exe goes to DIR/code2pdf.exe): downloads it,
 * checks its SHA-256 and that it runs, then puts it in place of what was there. Returns the
 * version it reports, or undefined when it didn't answer within checkTimeout: it's installed
 * all the same, since the SHA-256 says the files are right, and security software can hold a
 * new program's first start for minutes (the usage data saw a check time out twice on one PC).
 * Throws Cancelled, or an InstallFailed that says what went wrong and where.
 */
export async function installWindowsBuild(dir: string, options: DownloadOptions = {}): Promise<string | undefined> {
  const base = options.base ?? process.env.CODE2PDF_DOWNLOAD_BASE ?? RELEASE;
  const log = options.log ?? (() => {});
  const tag = randomBytes(4).toString("hex");
  const zip = `${dir}.download-${tag}.zip`;
  const unpacked = `${dir}.new-${tag}`;
  const old = `${dir}.old-${tag}`;
  let step: Step = "prepare";
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    removeLeftovers(dir);
    if (options.cancellation?.isCancellationRequested) {
      throw new Cancelled();
    }
    step = "download";
    const sums = await retrying(() => text(`${base}${ZIP}.sha256`, options), options, log);
    step = "damaged";
    const expected = sums.trim().split(/\s+/)[0].toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      throw new Error(`${ZIP}.sha256 doesn't hold a SHA-256`);
    }
    log(`Downloading ${base}${ZIP}`);
    step = "download";
    const actual = await retrying(() => save(`${base}${ZIP}`, zip, options), options, log);
    step = "damaged";
    if (actual !== expected) {
      throw new Error(`the download is damaged: its SHA-256 is ${actual}, not ${expected}`);
    }
    log(`SHA-256 ${actual}: as published. Unpacking into ${unpacked}`);
    step = "unpack";
    options.onStep?.("Unpacking…");
    fs.mkdirSync(unpacked);
    await run(tar(), ["-xf", zip, "-C", unpacked]);
    const exe = path.join(unpacked, "code2pdf", "code2pdf.exe");
    if (!fs.existsSync(exe)) {
      throw new Error(`${ZIP} has no code2pdf\\code2pdf.exe`);
    }
    step = "check";
    options.onStep?.("Checking that it runs…");
    const checkTimeout = options.checkTimeout ?? CHECK_TIMEOUT;
    const slow = setTimeout(() => options.onStep?.("Checking that it runs… (a new program's first start can take minutes when security software inspects it)"), 20_000);
    let version: string | undefined;
    try {
      version = (await run(exe, ["--version"], checkTimeout)).split("\n")[0].trim();
    } catch (error) {
      if (!(error as { killed?: boolean }).killed) {
        throw error;
      }
      log(`code2pdf.exe didn't answer --version within ${Math.round(checkTimeout / 60_000)} minutes. Installing it anyway: the SHA-256 says the files are right, and security software can hold a new program's first start.`);
    } finally {
      clearTimeout(slow);
    }
    if (version !== undefined && !version.startsWith("code2pdf ")) {
      throw new Error(`the downloaded code2pdf.exe doesn't run: ${version}`);
    }
    if (version !== undefined) {
      log(`It runs: ${version}`);
    }
    step = "swap";
    if (fs.existsSync(dir)) {
      await rename(dir, old, options, log);
    }
    try {
      await rename(path.join(unpacked, "code2pdf"), dir, options, log);
    } catch (error) {
      if (fs.existsSync(old)) {
        await rename(old, dir, options, log);
      }
      throw error;
    }
    log(`Installed in ${dir}`);
    return version;
  } catch (error) {
    if (error instanceof Cancelled) {
      throw error;
    }
    const { code, exitCode } = reasonOf(error);
    const message = code === "ENOSPC"
      ? `there isn't enough free space on ${path.parse(dir).root} (it needs about 200 MB while installing)`
      : (code === "EBUSY" || code === "EPERM") && step === "swap"
        ? `${dir} is in use: close any code2pdf that is running, then try again`
        // Windows gave an error Node has no name for (UNKNOWN): "contains a virus or potentially
        // unwanted software", or a policy that blocks programs; both seen in the usage data
        : (code === "UNKNOWN" || code === "EACCES") && step === "check"
          ? `Windows didn't let code2pdf.exe run (${code}): antivirus or a security policy blocked it. It's code2pdf's published build, checked against its SHA-256; if you can allow it, try again`
          : error instanceof Error ? error.message : String(error);
    throw new InstallFailed(message, step, code, exitCode, { cause: error });
  } finally {
    for (const leftover of [zip, unpacked, old]) {
      try {
        fs.rmSync(leftover, { recursive: true, force: true });
      } catch {
        // In use: removed next time (removeLeftovers)
      }
    }
  }
}
