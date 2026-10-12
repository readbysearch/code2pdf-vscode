// Which command installs or updates code2pdf on this machine. Pure, so the unit tests can check
// each platform.

import type { Code2pdf } from "./cli";

export const INSTALL_GUIDE = "https://github.com/readbysearch/code2pdf#installation";

const DEB_URL = "https://github.com/readbysearch/code2pdf/releases/latest/download/code2pdf_all.deb";
const INSTALL_SH = "https://raw.githubusercontent.com/readbysearch/code2pdf/main/install.sh";

export interface InstallCommand {
  /** Button label, such as "Install with Homebrew". */
  label: string;
  /** How, in a few words: "with Homebrew (brew install readbysearch/tap/code2pdf)", "just for you (no sudo)". */
  how: string;
  /** Run in a terminal, where the user sees it and can answer prompts (sudo, for one). */
  command: string;
  /** What it asks in the terminal, so the user knows to answer there. */
  asks?: string;
}

/**
 * Fetch URL with curl or wget, whichever is there: fresh Ubuntu desktops have wget but not
 * curl. Inside `bash -c '…'`, so it works whatever shell the terminal runs (zsh, fish, …).
 */
function fetch(url: string, to: string): string {
  return to === "-"
    ? `if command -v curl >/dev/null; then curl -fsSL ${url}; else wget -qO- ${url}; fi`
    : `if command -v curl >/dev/null; then curl -fL -o ${to} ${url}; else wget -O ${to} ${url}; fi`;
}

/** What `/etc/os-release` says, as far as it matters here. */
export interface OsRelease {
  id: string;
  versionId: string;
}

export function parseOsRelease(text: string): OsRelease {
  const field = (name: string) => text.match(new RegExp(`^${name}="?([^"\\n]*)"?$`, "m"))?.[1] ?? "";
  return { id: field("ID"), versionId: field("VERSION_ID") };
}

/** Whether the .deb installs here: it needs Ubuntu 24.04 or later, or Debian 13 or later. */
export function debWorks(release: OsRelease): boolean {
  const version = parseFloat(release.versionId);
  return (release.id === "ubuntu" && version >= 24.04) || (release.id === "debian" && version >= 13);
}

const brew = (verb: "install" | "upgrade"): InstallCommand => ({
  label: verb === "install" ? "Install with Homebrew" : "Update with Homebrew",
  how: `with Homebrew (brew ${verb} readbysearch/tap/code2pdf)`,
  command: `brew ${verb} readbysearch/tap/code2pdf`,
  // Homebrew 7 asks before installing anything with dependencies
  asks: "Homebrew lists what it will install and asks you to confirm: type y in the terminal.",
});

const deb = (verb: "Install" | "Update"): InstallCommand => ({
  label: `${verb} with apt (sudo)`,
  how: "for all users with apt (sudo)",
  command: `bash -c '${fetch(DEB_URL, "/tmp/code2pdf_all.deb")} && sudo apt install /tmp/code2pdf_all.deb'`,
  asks: "apt asks for your password, then to confirm: answer in the terminal.",
});

const installScript = (verb: "Install" | "Update", where: "--user" | "--system"): InstallCommand => ({
  label: where === "--user" ? `${verb} for Me (no sudo)` : `${verb} for All Users (sudo)`,
  how: where === "--user" ? "just for you (no sudo)" : "for all users (sudo)",
  command: `bash -c '${fetch(INSTALL_SH, "-")} | bash -s -- ${where}'`,
  asks: where === "--system" ? "It asks for your password: answer in the terminal." : undefined,
});

/**
 * The ways to install code2pdf here, best first; empty when only the guide can help. On Linux
 * without Homebrew there are two: for all users (sudo), or just for you (no sudo; also where
 * you can't use sudo, such as a shared server).
 */
export function installCommands(platform: NodeJS.Platform, hasBrew: boolean, release?: OsRelease): InstallCommand[] {
  if (platform === "darwin") {
    return hasBrew ? [brew("install")] : [];
  }
  if (platform !== "linux") {
    return [];
  }
  if (hasBrew) {
    return [brew("install")];
  }
  if (release && debWorks(release)) {
    return [deb("Install"), installScript("Install", "--user")];
  }
  return [installScript("Install", "--user"), installScript("Install", "--system")];
}

/** How to update the code2pdf that was FOUND, the same way it was installed. */
export function updateCommand(found: Code2pdf, home: string): InstallCommand | undefined {
  const kind = found.installKind;
  if (kind === "Homebrew") {
    return brew("upgrade");
  }
  if (kind === "Debian package") {
    return deb("Update");
  }
  if (kind.startsWith("install.sh")) {
    return installScript("Update", found.installDir.startsWith(home + "/") ? "--user" : "--system");
  }
  return undefined;
}
