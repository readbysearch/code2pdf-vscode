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
  assert.match(installCommand("linux", false, parseOsRelease(UBUNTU_24))?.command ?? "", /sudo apt install \/tmp\/code2pdf_all\.deb$/);
  assert.match(installCommand("linux", false, { id: "ubuntu", versionId: "22.04" })?.command ?? "", /install\.sh \| bash -s -- --user$/);
  assert.match(installCommand("linux", false)?.command ?? "", /--user$/);
  assert.equal(installCommand("win32", false), undefined);
});

test("update the way it was installed", () => {
  const found = (installKind: string, installDir = "") => ({ command: "code2pdf", version: "3.11", installKind, installDir });
  assert.equal(updateCommand(found("Homebrew"), "/home/u")?.command, "brew upgrade readbysearch/tap/code2pdf");
  assert.match(updateCommand(found("Debian package"), "/home/u")?.command ?? "", /apt install/);
  assert.match(updateCommand(found("install.sh", "/home/u/.local/share/code2pdf"), "/home/u")?.command ?? "", /--user$/);
  assert.match(updateCommand(found("install.sh (conda-forge environment)", "/usr/local/share/code2pdf"), "/home/u")?.command ?? "", /--system$/);
  assert.equal(updateCommand(found("git checkout"), "/home/u"), undefined);
});
