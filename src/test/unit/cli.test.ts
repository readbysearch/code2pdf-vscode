import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import * as cli from "../../cli";
import { script, tempDir } from "./helpers";

const BREW = `code2pdf 3.12 (commit 2e8b92f, 2026-10-11)
  installed: Homebrew, /opt/homebrew/Cellar/code2pdf/3.12
  python 3.14.8, weasyprint 70.0, pygments 2.21.0, pypdf 6.20.0
  CJK font: PingFang SC
`;

test("version output from each kind of install", () => {
  assert.deepEqual(cli.parseVersion(BREW), { version: "3.12", installKind: "Homebrew", installDir: "/opt/homebrew/Cellar/code2pdf/3.12" });
  assert.deepEqual(cli.parseVersion("code2pdf 3.11.1 (commit a, 2026-10-10)\n  installed: Debian package, /usr/share/code2pdf\n"),
    { version: "3.11.1", installKind: "Debian package", installDir: "/usr/share/code2pdf" });
  assert.deepEqual(cli.parseVersion("code2pdf 3.12+3 (commit b, 2026-10-12)\n  installed: install.sh (conda-forge environment), /home/u/.local/share/code2pdf\n"),
    { version: "3.12+3", installKind: "install.sh (conda-forge environment)", installDir: "/home/u/.local/share/code2pdf" });
  assert.equal(cli.parseVersion("code2pdf (version unknown: python3 not found), /usr/share/code2pdf")?.version, "unknown");
  assert.equal(cli.parseVersion("Usage: code2pdf [OPTIONS] -s FILE"), undefined);
});

test("3.12 or later is new enough; checkouts without a version count as new", () => {
  for (const v of ["3.12", "3.12.1", "3.12+3", "3.13", "4.0", "unreleased", "unknown"]) {
    assert.ok(cli.isNewEnough(v), v);
  }
  for (const v of ["3.11", "3.11.1", "3.9", "2.0", "3.1"]) {
    assert.ok(!cli.isNewEnough(v), v);
  }
});

test("where code2pdf is looked for", () => {
  assert.deepEqual(cli.candidates("~/bin/code2pdf", "/home/u", "linux"), ["/home/u/bin/code2pdf"]);
  const usual = cli.candidates("", "/home/u", "linux");
  assert.equal(usual[0], "code2pdf", "PATH first");
  assert.ok(usual.includes("/opt/homebrew/bin/code2pdf"));
  assert.ok(usual.includes(path.join("/home/u", ".local", "bin", "code2pdf")));
});

test("find: a working code2pdf, an old one, and none", async () => {
  const dir = tempDir();
  const good = script(dir, "good", `cat <<'EOF'\n${BREW}EOF`);
  assert.equal((await cli.find(good)).version, "3.12");

  const old = script(dir, "old", `echo "code2pdf 3.11 (commit x, 2026-10-10)"; echo "  installed: Homebrew, /x"`);
  await assert.rejects(cli.find(old), (e: unknown) => e instanceof cli.TooOld && e.found.version === "3.11");

  // Before 3.7, --version wasn't an option: the usage text comes back instead
  const ancient = script(dir, "ancient", `echo "Usage: code2pdf [OPTIONS] -s FILE"; exit 1`);
  await assert.rejects(cli.find(ancient), (e: unknown) => e instanceof cli.TooOld);

  await assert.rejects(cli.find(path.join(dir, "missing")), (e: unknown) => e instanceof cli.NotInstalled && e.fromSetting);
});

test("run: stdin in, stdout and progress out, exit code", async () => {
  const dir = tempDir();
  const fake = script(dir, "fake", [
    `echo "code2pdf: 2 files, 40 lines (~2 pages)" >&2`,
    `echo "  [2/3] Laying out page 1 of ~2 (50%), 0:00 elapsed" >&2`,
    `cat`,
    `echo "Done: 2 pages in 0:00 → out.pdf" >&2`,
    `exit 3`,
  ].join("\n"));
  const updates: (number | undefined)[] = [];
  const result = await cli.run(fake, { cwd: dir, args: [], input: "a.py\nb.py\n", quietStdout: true, onProgress: (u) => updates.push(u.fraction) });
  assert.equal(result.code, 3);
  assert.equal(result.stdout, "a.py\nb.py\n");
  assert.equal(result.reader.pages, 2);
  assert.deepEqual(updates, [0, 0.05 + 0.85 * 0.5, 1]);
  assert.equal(result.cancelled, false);
});

function cancelAfter(ms: number): cli.Cancellation {
  const listeners: (() => void)[] = [];
  const token = { isCancellationRequested: false, onCancellationRequested: (l: () => void) => listeners.push(l) };
  setTimeout(() => {
    token.isCancellationRequested = true;
    listeners.forEach((l) => l());
  }, ms);
  return token;
}

test("cancel sends Ctrl-C to code2pdf and the processes it started", async () => {
  const dir = tempDir();
  const marker = path.join(dir, "child-stopped");
  // Like bin/code2pdf: a shell script whose child does the work and cleans up on SIGINT
  const child = script(dir, "child", `trap 'touch "${marker}"; echo "code2pdf: stopped (SIGINT); nothing was written" >&2; exit 1' INT\nwhile :; do sleep 0.1; done`);
  const parent = script(dir, "parent", `"${child}"`);
  const started = Date.now();
  const result = await cli.run(parent, { cwd: dir, args: [], cancellation: cancelAfter(300), graceMs: 10_000 });
  assert.equal(result.cancelled, true);
  assert.ok(fs.existsSync(marker), "the child got SIGINT");
  assert.ok(Date.now() - started < 5000, "stopped without waiting for the kill");
});

test("cancel kills code2pdf if Ctrl-C doesn't stop it", async () => {
  const dir = tempDir();
  const stubborn = script(dir, "stubborn", `trap '' INT\nwhile :; do sleep 0.1; done`);
  const result = await cli.run(stubborn, { cwd: dir, args: [], cancellation: cancelAfter(200), graceMs: 300 });
  assert.equal(result.cancelled, true);
});

test("run rejects when the command doesn't exist", async () => {
  await assert.rejects(cli.run("/nonexistent/code2pdf", { cwd: "/", args: [] }), /ENOENT/);
});
