import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import * as git from "../../git";
import { gitIn, installed, tempDir, write } from "./helpers";

function repo(): string {
  const dir = path.join(tempDir(), "shop");
  fs.mkdirSync(dir);
  gitIn(dir, "init", "-q", "-b", "main");
  return dir;
}

test("a repository without commits offers nothing", async () => {
  const dir = repo();
  write(dir, "a.py", "x = 1\n");
  assert.deepEqual(await git.changeChoices(dir), { main: [], commits: [] });
  // The long name: on Windows the temp folder's path can hold short names (RUNNER~1)
  assert.equal(await git.repositoryRoot(dir), fs.realpathSync.native(dir));
});

test("one commit: nothing to compare it with, since code2pdf can't diff a first commit", async () => {
  const dir = repo();
  write(dir, "a.py", "x = 1\n");
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-qm", "first");
  assert.deepEqual(await git.changeChoices(dir), { main: [], commits: [] });
});

test("uncommitted changes, the last commit, and commits back to now", async () => {
  const dir = repo();
  write(dir, "a.py", "x = 1\n");
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-qm", "first");
  const first = gitIn(dir, "rev-parse", "HEAD");
  write(dir, "a.py", "x = 2\n");
  gitIn(dir, "commit", "-qam", "Second: change x");
  const second = gitIn(dir, "rev-parse", "HEAD");
  write(dir, "a.py", "x = 3\n");
  write(dir, "new.py", "y = 1\n");

  const { main, commits } = await git.changeChoices(dir);
  assert.deepEqual(main.map((c) => c.label), ["Uncommitted changes", "The last commit"]);
  assert.equal(main[0].rev, "HEAD");
  assert.match(main[0].description ?? "", /1 file changed/);
  assert.match(main[0].detail ?? "", /\(1\)/, "the untracked file is mentioned");
  assert.equal(main[1].rev, first);
  assert.match(main[1].description ?? "", /Second: change x$/);
  assert.match(main[1].detail ?? "", /uncommitted/);
  assert.equal(main[1].name, `shop-${second.slice(0, 7)}`);
  // Picking a commit prints it and what came after it, so the first commit (no parent) isn't offered
  assert.deepEqual(commits.map((c) => [c.label, c.rev]), [["Second: change x", first]]);

  assert.ok(await git.isCommit(dir, "HEAD~1"));
  assert.ok(!(await git.isCommit(dir, "nope")));
  assert.ok(!(await git.isCommit(dir, "--all")));
});

test("a branch: its changes since it left main", async () => {
  const dir = repo();
  write(dir, "a.py", "x = 1\n");
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-qm", "first");
  write(dir, "a.py", "x = 2\n");
  gitIn(dir, "commit", "-qam", "second");
  const fork = gitIn(dir, "rev-parse", "HEAD");
  gitIn(dir, "checkout", "-qb", "feature/login");
  write(dir, "b.py", "y = 1\n");
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-qm", "login");
  write(dir, "b.py", "y = 2\n");
  gitIn(dir, "commit", "-qam", "login 2");

  const { main } = await git.changeChoices(dir);
  const branch = main.find((c) => c.label.startsWith("This branch"));
  assert.equal(branch?.label, "This branch, feature/login");
  assert.equal(branch?.rev, fork);
  assert.equal(branch?.description, "2 commits since it left main");
  assert.equal(branch?.name, "shop-feature-login");

  gitIn(dir, "checkout", "-q", "main");
  assert.ok(!(await git.changeChoices(dir)).main.some((c) => c.label.startsWith("This branch")), "not on main itself");
});

test("each choice works with code2pdf --changed", { skip: !installed() && "code2pdf isn't installed" }, async () => {
  const dir = repo();
  write(dir, "a.py", "def f():\n    return 1\n");
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-qm", "first");
  write(dir, "a.py", "def f():\n    return 2\n");
  gitIn(dir, "commit", "-qam", "second");
  write(dir, "a.py", "def f():\n    return 3\n");
  const { main, commits } = await git.changeChoices(dir);
  for (const choice of [...main, ...commits]) {
    const list = execFileSync("code2pdf", ["--changed", choice.rev, "--list-files"], { cwd: dir, encoding: "utf8" });
    assert.match(list, /^a\.py:.*\+2-2/m, choice.label);
  }
});
