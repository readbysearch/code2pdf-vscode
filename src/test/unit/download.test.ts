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

/** Serves FILES (name → content) the way GitHub does: each through a redirect. */
async function server(files: Record<string, Buffer | string>): Promise<{ base: string; close: () => void; hits: string[] }> {
  const hits: string[] = [];
  const s = http.createServer((req, res) => {
    const name = (req.url ?? "").replace(/^\/(latest|cdn)\//, "");
    hits.push(req.url ?? "");
    if (req.url?.startsWith("/latest/")) {
      res.writeHead(302, { location: `/cdn/${name}` }).end();
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

/** A zip like the Windows build's: code2pdf/code2pdf.exe, here a script that answers --version. */
function zipOf(version: string): Buffer {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, "code2pdf", "_internal"), { recursive: true });
  script(path.join(dir, "code2pdf"), "code2pdf.exe", `echo "code2pdf ${version} (commit abc, 2026-10-20)"; echo "  installed: Windows build, x"`);
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
    await assert.rejects(download.installWindowsBuild(dir, { base: s.base }), /damaged: its SHA-256 is [0-9a-f]{64}, not 0{64}/);
    assert.equal(fs.readFileSync(path.join(dir, "code2pdf.exe"), "utf8"), "the old one");
    assert.deepEqual(fs.readdirSync(path.dirname(dir)), ["code2pdf"]);
  } finally {
    s.close();
  }
});

test("no release with the Windows build: says what answered", async () => {
  const s = await server({});
  try {
    await assert.rejects(download.installWindowsBuild(path.join(tempDir(), "code2pdf"), { base: s.base }),
      /the download failed: .*code2pdf-windows-x64\.zip\.sha256 answered 404/);
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
