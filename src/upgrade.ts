// Telling people who used version 1 what changed. Version 1 stored nothing, and VS Code updates
// extensions without saying from which version, so this is inferred. Pure, for the unit tests.

/** What is known when a print command starts. */
export interface Signs {
  /** The note was shown on this machine already. */
  noteShown: boolean;
  /** One of version 1's settings has a value the user set. */
  version1Settings: boolean;
  /** This is the extension's first activation on this machine. */
  firstActivation: boolean;
  /** This is the first command since the extension was activated. */
  firstCommand: boolean;
  /** Time from activation to this command. */
  msSinceActivation: number;
}

/**
 * Whether this user probably came from version 1. A fresh install from the Marketplace opens
 * the Get Started walkthrough, which activates the extension at once; after an update nothing
 * does until a print command, which activates it moments before it runs.
 */
export function cameFromVersion1(s: Signs): boolean {
  if (s.noteShown) {
    return false;
  }
  return s.version1Settings || (s.firstActivation && s.firstCommand && s.msSinceActivation < 5000);
}

export const WHATS_NEW = "https://github.com/readbysearch/code2pdf-vscode#coming-from-version-1";

export const NOTE =
  "code2pdf 2: PDFs now go into the project's code2pdf_generated_pdf folder, which git ignores, and open in a VS Code " +
  "tab; it prints all common source code, not only .py and .sh files.";

export const INSTALL_INTRO =
  "Version 2 of this extension prints with the code2pdf command-line tool instead of Vim and Ghostscript, and code2pdf isn't installed.";
