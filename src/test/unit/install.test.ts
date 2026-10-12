import { strict as assert } from "node:assert";
import { test } from "node:test";
import { debWorks, installCommand, parseOsRelease, updateCommand } from "../../install";

const UBUNTU_24 = `PRETTY_NAME="Ubuntu 24.04.1 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
ID=ubuntu
ID_LIKE=debian
`;

test("os-release", () => {
  assert.deepEqual(parseOsRelease(UBUNTU_24), { id: "ubuntu", versionId: "24.04" });
  assert.ok(debWorks(parseOsRelease(UBUNTU_24)));
  assert.ok(!debWorks({ id: "ubuntu", versionId: "22.04" }));
  assert.ok(debWorks({ id: "debian", versionId: "13" }));
  assert.ok(!debWorks({ id: "debian", versionId: "12" }));
  assert.ok(!debWorks({ id: "fedora", versionId: "41" }));
});

test("install: Homebrew where there is one, else the .deb, else install.sh without sudo", () => {
  assert.equal(installCommand("darwin", true)?.command, "brew install readbysearch/tap/code2pdf");
  assert.equal(installCommand("darwin", false), undefined, "the guide explains Homebrew");
  assert.equal(installCommand("linux", true, parseOsRelease(UBUNTU_24))?.label, "Install with Homebrew");
  assert.match(installCommand("linux", false, parseOsRelease(UBUNTU_24))?.command ?? "", /sudo apt install \/tmp\/code2pdf_all\.deb'$/);
  assert.match(installCommand("linux", false, { id: "ubuntu", versionId: "22.04" })?.command ?? "", /\| bash -s -- --user'$/);
  assert.match(installCommand("linux", false)?.command ?? "", /--user'$/);
  assert.equal(installCommand("win32", false), undefined);
});

test("update the way it was installed", () => {
  const found = (installKind: string, installDir = "") => ({ command: "code2pdf", version: "3.11", installKind, installDir });
  assert.equal(updateCommand(found("Homebrew"), "/home/u")?.command, "brew upgrade readbysearch/tap/code2pdf");
  assert.match(updateCommand(found("Debian package"), "/home/u")?.command ?? "", /apt install/);
  assert.match(updateCommand(found("install.sh", "/home/u/.local/share/code2pdf"), "/home/u")?.command ?? "", /--user'$/);
  assert.match(updateCommand(found("install.sh (conda-forge environment)", "/usr/local/share/code2pdf"), "/home/u")?.command ?? "", /--system'$/);
  assert.equal(updateCommand(found("git checkout"), "/home/u"), undefined);
});

test("the download works with curl or wget, in any shell", { skip: process.platform === "win32" }, async () => {
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  for (const command of [installCommand("linux", false, parseOsRelease(UBUNTU_24)), installCommand("linux", false)].map((c) => c?.command ?? "")) {
    assert.match(command, /^bash -c '[^']*'$/, "one single-quoted bash -c, so zsh and fish run it unchanged");
    assert.match(command, /if command -v curl >\/dev\/null; then curl .*; else wget .*; fi/);
  }
  // Run the fetch part with a fake wget and no curl: it must fall back to wget
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2p-fetch-"));
  fs.writeFileSync(path.join(dir, "wget"), '#!/bin/sh\necho "wget $*"\n', { mode: 0o755 });
  const fetchPart = (installCommand("linux", false)?.command ?? "").match(/^bash -c '(if .*?fi)/)?.[1] ?? "";
  const out = execFileSync("/bin/bash", ["-c", fetchPart], { env: { PATH: `${dir}:/bin` }, encoding: "utf8" });  // no curl here
  assert.match(out, /^wget -qO- https:\/\/raw\.githubusercontent\.com\/readbysearch\/code2pdf\/main\/install\.sh/);
});
