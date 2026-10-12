import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Whether the real code2pdf is on PATH (the tests that use it are skipped otherwise). */
export function installed(): boolean {
  try {
    execFileSync("code2pdf", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function tempDir(prefix = "code2pdf-vscode-"): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

/** An executable shell script at DIR/NAME. */
export function script(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

export function gitIn(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd: dir, encoding: "utf8" }).trim();
}

export function write(dir: string, file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}
