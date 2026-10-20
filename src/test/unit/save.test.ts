import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import * as save from "../../save";
import { tempDir } from "./helpers";

test("reads Windows' Desktop from the registry, where OneDrive may have moved it", () => {
  const output = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders\r\n" +
    "    Desktop    REG_EXPAND_SZ    %USERPROFILE%\\OneDrive\\Desktop\r\n\r\n";
  assert.equal(save.parseRegistry(output, { UserProfile: "C:\\Users\\a" }), "C:\\Users\\a\\OneDrive\\Desktop");
  assert.equal(save.parseRegistry("    Desktop    REG_SZ    D:\\Desk\r\n", {}), "D:\\Desk");
  assert.equal(save.parseRegistry("    Desktop    REG_EXPAND_SZ    %NOPE%\\Desktop\r\n", {}), undefined, "a variable it can't fill in");
  assert.equal(save.parseRegistry("ERROR: The system was unable to find the specified registry key or value.", {}), undefined);
});

test("reads a Linux desktop's own name for its Desktop folder", () => {
  const dirs = '# written by xdg-user-dirs-update\nXDG_DESKTOP_DIR="$HOME/桌面"\nXDG_DOWNLOAD_DIR="$HOME/下载"\n';
  assert.equal(save.parseUserDirs(dirs, "/home/a"), path.normalize("/home/a/桌面"));
  assert.equal(save.parseUserDirs('XDG_DESKTOP_DIR="/data/desk"\n', "/home/a"), path.normalize("/data/desk"));
  assert.equal(save.parseUserDirs('XDG_DESKTOP_DIR="$HOME/"\n', "/home/a"), undefined, "$HOME means no Desktop folder");
  assert.equal(save.parseUserDirs('XDG_DOWNLOAD_DIR="$HOME/Downloads"\n', "/home/a"), undefined);
});

test("PDFs go to the Desktop, else Documents, else the home folder", async () => {
  const home = tempDir();
  const env = { XDG_CONFIG_HOME: path.join(home, "config") };
  const folder = async (platform: NodeJS.Platform) => {
    save.forget();
    return save.defaultFolder(home, env, platform);
  };
  assert.equal(await folder("darwin"), home, "neither: the home folder");
  fs.mkdirSync(path.join(home, "Documents"));
  assert.equal(await folder("darwin"), path.join(home, "Documents"));
  fs.mkdirSync(path.join(home, "Desktop"));
  assert.equal(await folder("darwin"), path.join(home, "Desktop"));
  fs.mkdirSync(path.join(home, "config"));
  fs.mkdirSync(path.join(home, "桌面"));
  fs.writeFileSync(path.join(home, "config", "user-dirs.dirs"), 'XDG_DESKTOP_DIR="$HOME/桌面"\n');
  assert.equal(await folder("linux"), path.join(home, "桌面"), "the desktop's own name for it");
  save.forget();
});

test("never replaces a file code2pdf didn't make, but replaces its own PDF when printed again", () => {
  const dir = path.resolve("/d");
  const at = (name: string) => path.join(dir, name);
  const files = new Set([at("util.pdf"), at("util (2).pdf"), at("shop.pdf")]);
  const exists = (file: string) => files.has(file);
  const made = { [at("util (2).pdf")]: "file /a/util.py", [at("shop.pdf")]: "folder /a/shop" };
  assert.equal(save.freePath(dir, "new.pdf", "file /a/new.py", made, exists, "linux"), at("new.pdf"), "free");
  assert.equal(save.freePath(dir, "shop.pdf", "folder /a/shop", made, exists, "linux"), at("shop.pdf"), "the same print again");
  assert.equal(save.freePath(dir, "util.pdf", "file /a/util.py", made, exists, "linux"), at("util (2).pdf"),
    "util.pdf isn't code2pdf's; util (2).pdf is this print's");
  assert.equal(save.freePath(dir, "util.pdf", "file /b/util.py", made, exists, "linux"), at("util (3).pdf"),
    "another project's util.py doesn't replace this one's");
  assert.equal(save.freePath(dir, "Shop.pdf", "folder /a/shop", made, (f) => f.toLowerCase() === at("shop.pdf").toLowerCase(), "darwin"),
    at("Shop.pdf"), "a Mac's file system ignores case");
});

test("remembers the latest PDFs made, each once", () => {
  let made: Record<string, string> = {};
  for (let i = 0; i < 5; i++) {
    made = save.remember(made, `/d/${i}.pdf`, `file ${i}`, 3, "linux");
  }
  assert.deepEqual(Object.keys(made), ["/d/2.pdf", "/d/3.pdf", "/d/4.pdf"]);
  made = save.remember(made, "/d/2.pdf", "file again", 3, "linux");
  assert.deepEqual(made, { "/d/3.pdf": "file 3", "/d/4.pdf": "file 4", "/d/2.pdf": "file again" });
});

test("says ~/Desktop rather than the whole path", () => {
  assert.equal(save.tilde(path.join("/home/a", "Desktop"), "/home/a"), path.join("~", "Desktop"));
  assert.equal(save.tilde("/elsewhere", "/home/a"), "/elsewhere");
  assert.equal(save.tilde("/home/a", "/home/a"), "/home/a");
});
