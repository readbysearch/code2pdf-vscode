import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { test } from "node:test";
import * as download from "../../download";
import { POSIX_ONLY, script, tempDir } from "./helpers";

/** What a bad network does: drops the connection the first time NAME is asked for, or sends NAME's headers and then nothing. */
interface Faults {
  dropOnce?: string;
  stall?: string;
}

/** Serves FILES (name → content) the way GitHub does: each through a redirect. */
async function server(files: Record<string, Buffer | string>, faults: Faults = {}): Promise<{ base: string; close: () => void; hits: string[] }> {
  const hits: string[] = [];
  let dropped = false;
  const s = http.createServer((req, res) => {
    const name = (req.url ?? "").replace(/^\/(latest|cdn)\//, "");
    hits.push(req.url ?? "");
    if (req.url?.startsWith("/latest/")) {
      res.writeHead(302, { location: `/cdn/${name}` }).end();
    } else if (name === faults.dropOnce && !dropped) {
      dropped = true;
      req.socket.destroy();
    } else if (name === faults.stall) {
      res.writeHead(200, { "content-length": 1000 });
    } else if (name in files) {
      const body = Buffer.from(files[name]);
      res.writeHead(200, { "content-length": body.length }).end(body);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(s.address() as AddressInfo).port}/latest/`, close: () => s.close(), hits };
}

/** Where the install failed, and why, as the usage event gets it. */
function failedAt(step: download.Step, code?: string, exitCode?: number) {
  return (e: unknown) => {
    assert.ok(e instanceof download.InstallFailed, String(e));
    assert.deepEqual({ step: e.step, code: e.code, exitCode: e.exitCode }, { step, code, exitCode });
    return true;
  };
}

/** A zip like the Windows build's: code2pdf/code2pdf.exe, here a script that answers --version (or BODY). */
function zipOf(version: string, body = `echo "code2pdf ${version} (commit abc, 2026-10-20)"; echo "  installed: Windows build, x"`): Buffer {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, "code2pdf", "_internal"), { recursive: true });
  script(path.join(dir, "code2pdf"), "code2pdf.exe", body);
  execFileSync("tar", ["-a", "-cf", path.join(dir, "build.zip"), "-C", dir, "code2pdf"]);
  return fs.readFileSync(path.join(dir, "build.zip"));
}

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
// Windows' tar and macOS's (bsdtar) unpack zips; GNU tar (Linux) doesn't
const bsdtar = (() => {
  try {
    return execFileSync("tar", ["--version"], { encoding: "utf8" }).includes("bsdtar");
  } catch {
    return false;
  }
})();

test("installs the build, checked against its SHA-256, in place of the old one", { skip: POSIX_ONLY || (!bsdtar && "needs bsdtar") }, async () => {
  const zip = zipOf("3.13");
  const s = await server({ [download.ZIP]: zip, [`${download.ZIP}.sha256`]: `${sha(zip)}  ${download.ZIP}\n` });
  try {
    const dir = path.join(tempDir(), "Programs", "code2pdf");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "old-file"), "from 3.12");
    const seen: number[] = [];
    const steps: string[] = [];
    const version = await download.installWindowsBuild(dir, {
      base: s.base,
      onProgress: (received) => seen.push(received),
      onStep: (step) => steps.push(step),
    });
    assert.equal(version, "code2pdf 3.13 (commit abc, 2026-10-20)");
    assert.ok(fs.existsSync(path.join(dir, "code2pdf.exe")));
    assert.ok(!fs.existsSync(path.join(dir, "old-file")), "the old build is gone");
    assert.deepEqual(fs.readdirSync(path.dirname(dir)), ["code2pdf"], "nothing left next to it");
    assert.equal(seen[seen.length - 1], zip.length);
    assert.deepEqual(steps, ["Unpacking…", "Checking that it runs…"], "says what it does after the download");
    assert.ok(s.hits.includes(`/cdn/${download.ZIP}`), "followed the redirect");
  } finally {
    s.close();
  }
});

test("a damaged download changes nothing", async () => {
  const zip = Buffer.from("not the published zip");
  const s = await server({ [download.ZIP]: zip, [`${download.ZIP}.sha256`]: `${"0".repeat(64)}  ${download.ZIP}` });
  try {
    const dir = path.join(tempDir(), "code2pdf");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "code2pdf.exe"), "the old one");
    const result = download.installWindowsBuild(dir, { base: s.base });
    await assert.rejects(result, /damaged: its SHA-256 is [0-9a-f]{64}, not 0{64}/);
    await assert.rejects(result, failedAt("damaged"));
    assert.equal(fs.readFileSync(path.join(dir, "code2pdf.exe"), "utf8"), "the old one");
    assert.deepEqual(fs.readdirSync(path.dirname(dir)), ["code2pdf"]);
  } finally {
    s.close();
  }
});

test("no release with the Windows build: says what answered", async () => {
  const s = await server({});
  try {
    const result = download.installWindowsBuild(path.join(tempDir(), "code2pdf"), { base: s.base });
    await assert.rejects(result, /the download failed: .*code2pdf-windows-x64\.zip\.sha256 answered 404/);
    await assert.rejects(result, failedAt("download", "HTTP 404"));
  } finally {
    s.close();
  }
});

test("no connection: the step and the system's error code, for the usage event", async () => {
  const s = await server({});
  s.close();  // nothing listens on its port now
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(download.installWindowsBuild(path.join(tempDir(), "code2pdf"), { base: s.base }), failedAt("download", "ECONNREFUSED"));
});

test("a zip without code2pdf.exe, or one that doesn't run, fails at its own step", { skip: POSIX_ONLY || (!bsdtar && "needs bsdtar") }, async () => {
  const empty = tempDir();
  fs.writeFileSync(path.join(empty, "README.txt"), "no program here");
  execFileSync("tar", ["-a", "-cf", path.join(empty, "build.zip"), "-C", empty, "README.txt"]);
  const broken = zipOf("3.13", "echo 'missing DLL' >&2; exit 3");
  for (const [zip, check] of [[fs.readFileSync(path.join(empty, "build.zip")), failedAt("unpack")], [broken, failedAt("check", undefined, 3)]] as const) {
    const s = await server({ [download.ZIP]: zip, [`${download.ZIP}.sha256`]: sha(zip) });
    try {
      const dir = path.join(tempDir(), "code2pdf");
      await assert.rejects(download.installWindowsBuild(dir, { base: s.base }), check);
      assert.deepEqual(fs.readdirSync(path.dirname(dir)), [], "nothing left");
    } finally {
      s.close();
    }
  }
});

test("a connection that drops is tried once more", async () => {
  // The sum arrives on the second try, and is wrong: so the retry happened and the usual check followed
  const zip = zipOf("3.13");
  const s = await server({ [download.ZIP]: zip, [`${download.ZIP}.sha256`]: `${"0".repeat(64)}  ${download.ZIP}` }, { dropOnce: `${download.ZIP}.sha256` });
  try {
    const log: string[] = [];
    await assert.rejects(download.installWindowsBuild(path.join(tempDir(), "code2pdf"), { base: s.base, retryDelay: 10, log: (l) => log.push(l) }), failedAt("damaged"));
    assert.equal(s.hits.filter((h) => h === `/cdn/${download.ZIP}.sha256`).length, 2, "asked twice");
    assert.ok(log.some((l) => /ECONNRESET|socket hang up|trying once more/.test(l)), log.join("\n"));
  } finally {
    s.close();
  }
});

test("a download that stalls fails with ETIMEDOUT, after one more try", async () => {
  const zip = zipOf("3.13");
  const s = await server({ [download.ZIP]: zip, [`${download.ZIP}.sha256`]: sha(zip) }, { stall: download.ZIP });
  try {
    const dir = path.join(tempDir(), "code2pdf");
    await assert.rejects(download.installWindowsBuild(dir, { base: s.base, stallTimeout: 200, retryDelay: 10 }), failedAt("download", "ETIMEDOUT"));
    assert.equal(s.hits.filter((h) => h === `/cdn/${download.ZIP}`).length, 2, "tried twice");
    assert.deepEqual(fs.readdirSync(path.dirname(dir)), [], "nothing left");
  } finally {
    s.close();
  }
});

test("a code2pdf.exe that doesn't answer in time is installed anyway", { skip: POSIX_ONLY || (!bsdtar && "needs bsdtar") }, async () => {
  const zip = zipOf("3.13", "sleep 3");
  const s = await server({ [download.ZIP]: zip, [`${download.ZIP}.sha256`]: sha(zip) });
  try {
    const dir = path.join(tempDir(), "code2pdf");
    const log: string[] = [];
    const version = await download.installWindowsBuild(dir, { base: s.base, checkTimeout: 300, log: (l) => log.push(l) });
    assert.equal(version, undefined, "no version to report");
    assert.ok(fs.existsSync(path.join(dir, "code2pdf.exe")), "installed all the same");
    assert.ok(log.some((l) => /didn't answer --version/.test(l)), log.join("\n"));
  } finally {
    s.close();
  }
});

test("the swap waits while the folder is locked", { skip: POSIX_ONLY || (!bsdtar && "needs bsdtar") || (process.getuid?.() === 0 && "root ignores permissions") }, async () => {
  const zip = zipOf("3.13");
  const s = await server({ [download.ZIP]: zip, [`${download.ZIP}.sha256`]: sha(zip) });
  try {
    const parent = path.join(tempDir(), "Programs");
    fs.mkdirSync(parent);
    const dir = path.join(parent, "code2pdf");
    const log: string[] = [];
    const version = await download.installWindowsBuild(dir, {
      base: s.base,
      retryDelay: 50,
      log: (l) => log.push(l),
      onStep: (step) => {
        if (step.startsWith("Checking")) {
          // Nothing can be renamed inside a read-only folder (EACCES): like antivirus holding it, briefly
          fs.chmodSync(parent, 0o555);
          setTimeout(() => fs.chmodSync(parent, 0o755), 300);
        }
      },
    });
    assert.equal(version, "code2pdf 3.13 (commit abc, 2026-10-20)");
    assert.ok(fs.existsSync(path.join(dir, "code2pdf.exe")));
    assert.ok(log.some((l) => /EACCES renaming code2pdf: trying again/.test(l)), log.join("\n"));
  } finally {
    s.close();
  }
});

test("cancelling stops the download and leaves nothing", async () => {
  const big = Buffer.alloc(50_000_000);
  const s = await server({ [download.ZIP]: big, [`${download.ZIP}.sha256`]: sha(big) });
  try {
    const dir = path.join(tempDir(), "code2pdf");
    const listeners: (() => void)[] = [];
    const cancellation = { isCancellationRequested: false, onCancellationRequested: (l: () => void) => listeners.push(l) };
    const result = download.installWindowsBuild(dir, {
      base: s.base,
      cancellation,
      onProgress: (received) => {
        if (received > 1_000_000 && !cancellation.isCancellationRequested) {
          cancellation.isCancellationRequested = true;
          listeners.forEach((l) => l());
        }
      },
    });
    await assert.rejects(result, (e: unknown) => e instanceof download.Cancelled);
    assert.deepEqual(fs.readdirSync(path.dirname(dir)), [], "the partial zip is removed");
  } finally {
    s.close();
  }
});
