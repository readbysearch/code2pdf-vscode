import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { test } from "node:test";
import * as specs from "../../specs";
import { installed, tempDir, write } from "./helpers";

const sel = (startLine: number, endLine: number, endCharacter: number, isEmpty = false) => ({ startLine, endLine, endCharacter, isEmpty });

test("a selection inside one line prints that line", () => {
  assert.deepEqual(specs.selectionRanges([sel(4, 4, 12)]), [{ start: 5, end: 5 }]);
});

test("whole lines selected by dragging end at the start of the next line, which isn't printed", () => {
  assert.deepEqual(specs.selectionRanges([sel(9, 12, 0)]), [{ start: 10, end: 12 }]);
  assert.deepEqual(specs.selectionRanges([sel(9, 12, 3)]), [{ start: 10, end: 13 }]);
});

test("several selections are sorted and merged; empty ones are ignored", () => {
  assert.deepEqual(specs.selectionRanges([sel(30, 34, 5), sel(2, 3, 1), sel(33, 40, 1), sel(4, 5, 2), sel(60, 60, 0, true)]),
    [{ start: 3, end: 6 }, { start: 31, end: 41 }]);
  assert.deepEqual(specs.selectionRanges([sel(7, 7, 0, true)]), []);
});

test("range specs as code2pdf reads them", () => {
  assert.equal(specs.rangeSpec("src/app.py", [{ start: 5, end: 5 }]), "src/app.py:5");
  assert.equal(specs.rangeSpec("src/app.py", [{ start: 1, end: 3 }, { start: 7, end: 9 }]), "src/app.py:1-3,7-9");
});

test("paths given to code2pdf are never taken for options", () => {
  assert.equal(specs.argPath("-weird.py"), "./-weird.py");
  assert.equal(specs.argPath("src/app.py"), "src/app.py");
  assert.equal(specs.argPath("."), ".");
});

test("relative paths and containment", () => {
  assert.equal(specs.relativePath("/p", "/p"), ".");
  assert.equal(specs.relativePath("/p", "/p/src/a.py"), "src/a.py");
  assert.ok(specs.isInside("/p", "/p/src"));
  assert.ok(specs.isInside("/p", "/p"));
  assert.ok(!specs.isInside("/p", "/pq/src"));
  assert.ok(!specs.isInside("/p/src", "/p"));
});

test("the folder that holds every selected item", () => {
  const folders = new Set(["/p", "/p/src", "/p/src/lib", "/p/docs"]);
  const isFolder = (p: string) => folders.has(p);
  assert.equal(specs.commonFolder(["/p/src/a.py", "/p/src/lib/b.py"], isFolder), "/p/src");
  assert.equal(specs.commonFolder(["/p/src/lib", "/p/docs/x.md"], isFolder), "/p");
  assert.equal(specs.commonFolder(["/p/src/lib"], isFolder), "/p/src/lib");
  assert.equal(specs.commonFolder(["/p/src/a.py"], isFolder), "/p/src");
});

test("tree order: depth first, by name, files and folders mixed", () => {
  const sorted = ["src/b.py", "README.md", "src/a/x.py", "a.py", "src/c.py", "bin/run", "CLAUDE.md", "a/z.py"].sort(specs.treeOrder);
  assert.deepEqual(sorted, ["CLAUDE.md", "README.md", "a/z.py", "a.py", "bin/run", "src/a/x.py", "src/b.py", "src/c.py"]);
  assert.deepEqual(["src/a.py", "src"].sort(specs.treeOrder), ["src", "src/a.py"]);
});

test("file names", () => {
  assert.equal(specs.stem("/x/app.test.py"), "app.test");
  assert.equal(specs.stem("/x/Makefile"), "Makefile");
  assert.equal(specs.stem("/x/.bashrc"), ".bashrc");
  assert.equal(specs.fileNamePart("feature/login fix"), "feature-login-fix");
  assert.equal(specs.fileNamePart("///"), "code");
  assert.equal(specs.selectionPdfName("/x/app.py", [{ start: 10, end: 40 }, { start: 90, end: 99 }]), "app-lines-10-99.pdf");
  assert.equal(specs.unique(["a", "b", "a"]).join(), "a,b");
});

test("~ means the home folder", () => {
  assert.equal(specs.expandHome("~/out", "/home/u"), path.join("/home/u", "out").replace(/\\/g, "/"));
  assert.equal(specs.expandHome("~", "/home/u"), "/home/u");
  assert.equal(specs.expandHome("/abs/~x", "/home/u"), "/abs/~x");
  assert.equal(specs.expandHome("~other/x", "/home/u"), "~other/x");
});

test("tree order matches code2pdf's own order", { skip: !installed() && "code2pdf isn't installed" }, () => {
  const dir = tempDir();
  for (const file of ["README.md", "Makefile", "a.py", "a/b.py", "src/b.py", "src/C.py", "src/a/x.py", "src/a/y/z.py", "tests/t.py", "_x.py"]) {
    write(dir, file, "x = 1\n");
  }
  const listed = execFileSync("code2pdf", ["-a", ".", "--list-files"], { cwd: dir, encoding: "utf8" }).trim().split("\n");
  assert.equal(listed.length, 10);
  assert.deepEqual([...listed].reverse().sort(specs.treeOrder), listed);
});
