import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import * as cli from "../../cli";
import { POSIX_ONLY, script, tempDir } from "./helpers";

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

test("on Windows: PATH, then where the Install button puts it", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };
  assert.equal(cli.windowsInstallDir(env, "C:\\Users\\u"), "C:\\Users\\u\\AppData\\Local\\Programs\\code2pdf");
  assert.equal(cli.windowsInstallDir({}, "C:\\Users\\u"), "C:\\Users\\u\\AppData\\Local\\Programs\\code2pdf");
  assert.deepEqual(cli.candidates("", "C:\\Users\\u", "win32", env),
    ["code2pdf", "C:\\Users\\u\\AppData\\Local\\Programs\\code2pdf\\code2pdf.exe"]);
  assert.deepEqual(cli.candidates("D:\\tools\\code2pdf.exe", "C:\\Users\\u", "win32", env), ["D:\\tools\\code2pdf.exe"]);
});

test("after a stop: the temporary files code2pdf left are removed, older ones kept", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, ".code2pdf-old.pdf"), "");
  fs.utimesSync(path.join(dir, ".code2pdf-old.pdf"), new Date(2020, 0, 1), new Date(2020, 0, 1));
  const since = Date.now();
  fs.writeFileSync(path.join(dir, ".code2pdf-a1b2.pdf"), "");
  fs.mkdirSync(path.join(dir, ".code2pdf-parts-x9"));
  fs.writeFileSync(path.join(dir, ".code2pdf-parts-x9", "part-1.pdf"), "");
  fs.writeFileSync(path.join(dir, "report.pdf"), "");
  assert.deepEqual(cli.removeLeftovers(dir, since).sort(), [".code2pdf-a1b2.pdf", ".code2pdf-parts-x9"]);
  assert.deepEqual(fs.readdirSync(dir).sort(), [".code2pdf-old.pdf", "report.pdf"]);
  assert.deepEqual(cli.removeLeftovers(path.join(dir, "missing"), since), []);
});

test("find: a working code2pdf, an old one, and none", { skip: POSIX_ONLY }, async () => {
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

test("find on Windows: what code2pdf.exe's --version said stands until the file changes", { skip: POSIX_ONLY }, async () => {
  const dir = tempDir();
  const runs = path.join(dir, "runs");
  const said = "code2pdf 3.13 (commit x, 2026-10-20)\n  installed: Windows build, C:\\Users\\a\\AppData\\Local\\Programs\\code2pdf\n";
  const exe = script(dir, "code2pdf.exe", `echo run >> "${runs}"\ncat <<'EOF'\n${said}EOF`);
  const seen = new Map<string, cli.SeenVersion>();
  const cache = { get: (file: string) => seen.get(file), set: (file: string, version: cli.SeenVersion) => void seen.set(file, version) };
  const asked = () => fs.readFileSync(runs, "utf8").split("\n").filter(Boolean).length;
  assert.equal((await cli.find(exe, cache, "win32")).installKind, "Windows build");
  assert.equal((await cli.find(exe, cache, "win32")).version, "3.13");
  assert.equal(asked(), 1, "asked once");
  fs.appendFileSync(exe, "\n");  // an update: another size
  assert.equal((await cli.find(exe, cache, "win32")).version, "3.13");
  assert.equal(asked(), 2, "a changed file is asked again");
  await cli.find(exe, cache, "darwin");
  assert.equal(asked(), 3, "only on Windows");
  const old = script(dir, "old.exe", `echo run >> "${runs}"; echo "code2pdf 3.11 (commit x, 2026-10-10)"`);
  await assert.rejects(cli.find(old, cache, "win32"), (e: unknown) => e instanceof cli.TooOld);
  assert.ok(!seen.has(old), "one too old isn't remembered, so an update is seen");
});

test("finds code2pdf.exe on Windows' PATH", () => {
  const exists = (file: string) => file === "C:\\Tools\\code2pdf.exe";
  assert.equal(cli.windowsProgram("code2pdf", { Path: 'C:\\Windows;"C:\\Tools";' }, exists), "C:\\Tools\\code2pdf.exe");
  assert.equal(cli.windowsProgram("code2pdf", { PATH: "C:\\Windows" }, exists), undefined);
  assert.equal(cli.windowsProgram("C:\\x\\code2pdf.exe", {}, exists), "C:\\x\\code2pdf.exe");
});

test("run: stdin in, stdout and progress out, exit code", { skip: POSIX_ONLY }, async () => {
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

test("cancel sends Ctrl-C to code2pdf and the processes it started", { skip: POSIX_ONLY }, async () => {
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

test("cancel kills code2pdf if Ctrl-C doesn't stop it", { skip: POSIX_ONLY }, async () => {
  const dir = tempDir();
  const stubborn = script(dir, "stubborn", `trap '' INT\nwhile :; do sleep 0.1; done`);
  const result = await cli.run(stubborn, { cwd: dir, args: [], cancellation: cancelAfter(200), graceMs: 300 });
  assert.equal(result.cancelled, true);
});

test("on Windows, cancel ends code2pdf and the processes it started", { skip: process.platform !== "win32" && "Windows only" }, async () => {
  const dir = tempDir();
  const ticks = path.join(dir, "ticks");
  // Like parts mode: the worker is a process of its own, and keeps writing until it's stopped
  const worker = `setInterval(() => require("fs").appendFileSync(${JSON.stringify(ticks)}, "."), 50)`;
  const parent = `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(worker)}], { stdio: "inherit" }); setInterval(() => {}, 1000)`;
  const result = await cli.run(process.execPath, { cwd: dir, args: ["-e", parent], cancellation: cancelAfter(1500) });
  assert.equal(result.cancelled, true);
  await new Promise((r) => setTimeout(r, 1000));
  const after = fs.statSync(ticks).size;
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(fs.statSync(ticks).size, after, "the worker stopped too");
});

test("run rejects when the command doesn't exist", async () => {
  await assert.rejects(cli.run("/nonexistent/code2pdf", { cwd: "/", args: [] }), /ENOENT/);
});

test("find: a code2pdf that doesn't answer in time is Unresponsive, not too old", { skip: POSIX_ONLY }, async () => {
  const dir = tempDir();
  const slow = script(dir, "slow", `sleep 3; echo "code2pdf 3.13 (commit x, 2026-10-20)"`);
  await assert.rejects(cli.find(slow, undefined, process.platform, 500), (e: unknown) => e instanceof cli.Unresponsive && e.command === slow && e.seconds === 1);
});
