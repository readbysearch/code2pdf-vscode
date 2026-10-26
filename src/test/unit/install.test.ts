import { strict as assert } from "node:assert";
import { test } from "node:test";
import { debWorks, installCommands, parseOsRelease, updateCommand } from "../../install";

const installCommand = (...a: Parameters<typeof installCommands>) => installCommands(...a)[0];

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
  assert.equal(installCommand("darwin", true)?.command, "HOMEBREW_NO_ASK=1 brew install readbysearch/tap/code2pdf", "no [y/n] question: the button was the answer");
  assert.match(installCommand("darwin", false)?.command ?? "", /\| bash -s -- --user'$/, "without Homebrew: code2pdf's installer, just for this user");
  assert.equal(installCommand("linux", true, parseOsRelease(UBUNTU_24))?.label, "Install with Homebrew");
  assert.match(installCommand("linux", false, parseOsRelease(UBUNTU_24))?.command ?? "", /sudo apt install \/tmp\/code2pdf_all\.deb'$/);
  assert.match(installCommand("linux", false, { id: "ubuntu", versionId: "22.04" })?.command ?? "", /\| bash -s -- --user'$/);
  assert.match(installCommand("linux", false)?.command ?? "", /--user'$/);
  assert.equal(installCommand("win32", false)?.download, true, "Windows: the extension downloads the Windows build itself");
  assert.equal(installCommand("win32", false)?.command, undefined, "no terminal");
  const labels = (...a: Parameters<typeof installCommands>) => installCommands(...a).map((i) => i.label);
  assert.deepEqual(labels("linux", false, parseOsRelease(UBUNTU_24)), ["Install with apt (sudo)", "Install for Me (no sudo)"],
    "where you can't use sudo (a shared server), the no-sudo install is offered too");
  assert.deepEqual(labels("linux", false, { id: "fedora", versionId: "41" }), ["Install for Me (no sudo)", "Install for All Users (sudo)"]);
  assert.match(installCommands("linux", false)[1].command ?? "", /bash -s -- --system'$/);
  assert.deepEqual(labels("darwin", true), ["Install with Homebrew"]);
  assert.deepEqual(labels("darwin", false), ["Install for Me (no sudo)"]);
  assert.equal(installCommand("darwin", true)?.asks, undefined, "Homebrew has nothing to ask with HOMEBREW_NO_ASK");
  assert.match(installCommand("linux", false, parseOsRelease(UBUNTU_24))?.asks ?? "", /password/);
});

test("update the way it was installed", () => {
  const found = (installKind: string, installDir = "") => ({ command: "code2pdf", version: "3.11", installKind, installDir });
  assert.equal(updateCommand(found("Homebrew"), "/home/u")?.command, "HOMEBREW_NO_ASK=1 brew upgrade readbysearch/tap/code2pdf");
  assert.match(updateCommand(found("Debian package"), "/home/u")?.command ?? "", /apt install/);
  assert.match(updateCommand(found("install.sh", "/home/u/.local/share/code2pdf"), "/home/u")?.command ?? "", /--user'$/);
  assert.match(updateCommand(found("install.sh (conda-forge environment)", "/usr/local/share/code2pdf"), "/home/u")?.command ?? "", /--system'$/);
  assert.equal(updateCommand(found("git checkout"), "/home/u"), undefined);
  const windows = "C:\\Users\\u\\AppData\\Local\\Programs\\code2pdf";
  assert.equal(updateCommand(found("Windows build", `${windows}\\_internal`), "C:\\Users\\u", windows)?.label, "Update code2pdf");
  assert.equal(updateCommand(found("Windows build", "D:\\tools\\code2pdf\\_internal"), "C:\\Users\\u", windows), undefined,
    "one unzipped by hand elsewhere is updated by hand (the Install button's copy would come after it)");
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
  // PATH has only the fake wget (on Ubuntu /bin is /usr/bin, which has curl)
  const out = execFileSync("/bin/bash", ["-c", fetchPart], { env: { PATH: dir }, encoding: "utf8" });
  assert.match(out, /^wget -qO- https:\/\/raw\.githubusercontent\.com\/readbysearch\/code2pdf\/main\/install\.sh/);
});
