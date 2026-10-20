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

export interface DownloadOptions {
  /** Where the zip and its .sha256 are: the latest release, or a test server. */
  base?: string;
  onProgress?: (received: number, total: number | undefined) => void;
  /** What it's doing after the download, which takes a while too: unpacking, then checking it runs. */
  onStep?: (step: string) => void;
  cancellation?: Cancellation;
  log?: (line: string) => void;
}

/** GETs URL, following redirects (GitHub sends release downloads elsewhere). */
function get(url: string, cancellation?: Cancellation, redirects = 5): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const request = client.get(url, { headers: { "User-Agent": "code2pdf-vscode" } }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location && redirects > 0) {
        response.resume();
        resolve(get(new URL(response.headers.location, url).toString(), cancellation, redirects - 1));
      } else if (status === 200) {
        resolve(response);
      } else {
        response.resume();
        reject(new Error(`the download failed: ${url} answered ${status}`));
      }
    });
    request.on("error", (error) => reject(error instanceof Cancelled ? error : new Error(`the download failed: ${error.message}`)));
    cancellation?.onCancellationRequested(() => request.destroy(new Cancelled()));
  });
}

async function text(url: string, cancellation?: Cancellation): Promise<string> {
  const response = await get(url, cancellation);
  let body = "";
  response.setEncoding("utf8");
  for await (const chunk of response) {
    body += chunk;
  }
  return body;
}

/** Saves URL to FILE and returns its SHA-256. */
async function save(url: string, file: string, options: DownloadOptions): Promise<string> {
  const response = await get(url, options.cancellation);
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
    throw new Error(`the download stopped after ${received} of ${total} bytes`);
  }
  return hash.digest("hex");
}

function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: 120_000, windowsHide: true }, (error, stdout, stderr) =>
      error ? reject(new Error(`${path.basename(command)} ${args[0] ?? ""} failed: ${(stderr || error.message).trim()}`)) : resolve(stdout));
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
 * version it reports. Throws Cancelled, or an Error that says what went wrong.
 */
export async function installWindowsBuild(dir: string, options: DownloadOptions = {}): Promise<string> {
  const base = options.base ?? process.env.CODE2PDF_DOWNLOAD_BASE ?? RELEASE;
  const log = options.log ?? (() => {});
  const tag = randomBytes(4).toString("hex");
  const zip = `${dir}.download-${tag}.zip`;
  const unpacked = `${dir}.new-${tag}`;
  const old = `${dir}.old-${tag}`;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  removeLeftovers(dir);
  try {
    if (options.cancellation?.isCancellationRequested) {
      throw new Cancelled();
    }
    const expected = (await text(`${base}${ZIP}.sha256`, options.cancellation)).trim().split(/\s+/)[0].toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      throw new Error(`${ZIP}.sha256 doesn't hold a SHA-256`);
    }
    log(`Downloading ${base}${ZIP}`);
    const actual = await save(`${base}${ZIP}`, zip, options);
    if (actual !== expected) {
      throw new Error(`the download is damaged: its SHA-256 is ${actual}, not ${expected}`);
    }
    log(`SHA-256 ${actual}: as published. Unpacking into ${unpacked}`);
    options.onStep?.("Unpacking…");
    fs.mkdirSync(unpacked);
    await run(tar(), ["-xf", zip, "-C", unpacked]);
    const exe = path.join(unpacked, "code2pdf", "code2pdf.exe");
    if (!fs.existsSync(exe)) {
      throw new Error(`${ZIP} has no code2pdf\\code2pdf.exe`);
    }
    options.onStep?.("Checking that it runs…");
    const version = (await run(exe, ["--version"])).split("\n")[0].trim();
    if (!version.startsWith("code2pdf ")) {
      throw new Error(`the downloaded code2pdf.exe doesn't run: ${version}`);
    }
    log(`It runs: ${version}`);
    if (fs.existsSync(dir)) {
      fs.renameSync(dir, old);
    }
    try {
      fs.renameSync(path.join(unpacked, "code2pdf"), dir);
    } catch (error) {
      if (fs.existsSync(old)) {
        fs.renameSync(old, dir);
      }
      throw error;
    }
    log(`Installed in ${dir}`);
    return version;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOSPC") {
      throw new Error(`there isn't enough free space on ${path.parse(dir).root} (it needs about 200 MB while installing)`, { cause: error });
    }
    if (code === "EBUSY" || code === "EPERM") {
      throw new Error(`${dir} is in use: close any code2pdf that is running, then try again`, { cause: error });
    }
    throw error;
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
