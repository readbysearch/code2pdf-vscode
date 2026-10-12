import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import * as args from "../../args";
import { installed } from "./helpers";

const plain: args.PrintSettings = { theme: "paper", include: [], exclude: [], legacy: {} };

test("a file, with the default theme left out", () => {
  assert.deepEqual(args.fileArgs("src/app.py:10-20", "/o/app.pdf", plain), ["-s", "src/app.py:10-20", "-o", "/o/app.pdf"]);
  assert.deepEqual(args.fileArgs("app.py", "/o/a.pdf", { ...plain, theme: " mono " }), ["-s", "app.py", "-o", "/o/a.pdf", "--theme", "mono"]);
});

test("a folder, with include and exclude globs", () => {
  const settings = { ...plain, include: ["*.json", " "], exclude: ["tests", "*_test.go"] };
  assert.deepEqual(args.folderArgs(".", "/o/p.pdf", settings),
    ["-a", ".", "-o", "/o/p.pdf", "--include", "*.json", "--exclude", "tests", "--exclude", "*_test.go"]);
  assert.deepEqual(args.listArgs("src", settings), ["-a", "src", "--list-files", "--include", "*.json", "--exclude", "tests", "--exclude", "*_test.go"]);
});

test("a list of files takes no selection options (code2pdf refuses them)", () => {
  const settings = { ...plain, include: ["*.json"], exclude: ["tests"] };
  assert.deepEqual(args.filesFromArgs(".", "/o/p.pdf", settings), ["-a", ".", "--files-from", "-", "-o", "/o/p.pdf"]);
});

test("changes take exclude, but not include (code2pdf refuses it)", () => {
  const settings = { ...plain, include: ["*.json"], exclude: ["tests"], theme: "mono" };
  assert.deepEqual(args.changedArgs("HEAD~1", ".", "/o/c.pdf", settings),
    ["--changed", "HEAD~1", "-a", ".", "-o", "/o/c.pdf", "--theme", "mono", "--exclude", "tests"]);
});

test("version 1's settings, when set, keep their meaning", () => {
  assert.deepEqual(args.legacyArgs({}), []);
  assert.deepEqual(args.legacyArgs({
    blacklistedFolders: ["node_modules", "gen"],
    blacklistedFolderPattern: "tmp*",
    whitelistedFileExtensions: ["py", ".sh", "*.js"],
    whitelistedFileNames: ["README.md", "launch.json"],
  }), ["--ignore-folders", "node_modules,gen", "--exclude", "tmp*", "--include-types", "py,sh,js",
    "--include", "README.md", "--include", "launch.json"]);
  assert.deepEqual(args.legacyArgs({ blacklistedFolderPattern: "env*" }), [], "code2pdf skips env* folders anyway");
});

test("command lines in the log are quoted for a shell", () => {
  assert.equal(args.shellQuote(["code2pdf", "-a", ".", "--exclude", "*_test.go", "-o", "/tmp/my file.pdf", "--summary", "it's"]),
    "code2pdf -a . --exclude '*_test.go' -o '/tmp/my file.pdf' --summary 'it'\\''s'");
});

test("every option used here is in code2pdf --help", { skip: !installed() && "code2pdf isn't installed" }, () => {
  const help = execFileSync("code2pdf", ["--help"], { encoding: "utf8" });
  const settings = { theme: "mono", include: ["*.json"], exclude: ["tests"], legacy: {
    blacklistedFolders: ["x"], blacklistedFolderPattern: "y*", whitelistedFileExtensions: ["py"], whitelistedFileNames: ["z"] } };
  const used = new Set([
    ...args.fileArgs("a.py", "o.pdf", settings), ...args.folderArgs(".", "o.pdf", settings), ...args.listArgs(".", settings),
    ...args.filesFromArgs(".", "o.pdf", settings), ...args.changedArgs("HEAD", ".", "o.pdf", settings),
  ].filter((a) => a.startsWith("-") && a !== "-"));
  for (const option of used) {
    assert.match(help, new RegExp(`(^|[\\s,])${option}(?=[\\s,=]|$)`, "m"), `${option} isn't in code2pdf --help`);
  }
});
