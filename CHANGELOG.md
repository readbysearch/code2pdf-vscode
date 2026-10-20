# Changelog

## 2.1.0

- Windows: code2pdf runs on Windows itself, with no WSL (code2pdf 3.13 has a Windows build).
  Install downloads it from its GitHub release (about 40 MB) into
  `%LOCALAPPDATA%\Programs\code2pdf`, checks it against its published SHA-256, and needs no
  terminal or administrator rights; Update does the same. Cancelling a print stops code2pdf and
  the processes it started, and removes the temporary files it left.
- Print Changes says when git isn't installed (on Windows, it needs Git for Windows).

## 2.0.1

- Anonymous usage data, only when VS Code's telemetry is on: whether code2pdf was found, which
  install people choose and whether it finished, and how prints end. It shows where people get
  stuck. Nothing in them identifies you: no ID lasts beyond a session, and Azure is told not to
  work out a location. The new `code2pdf.telemetry` setting turns them off for this extension
  alone. [Usage data](https://github.com/readbysearch/code2pdf-vscode#usage-data)
  lists everything that is sent, and the
  [privacy policy](https://github.com/readbysearch/code2pdf-vscode/blob/main/PRIVACY.md) covers
  the rest.

## 2.0.0

A new extension, built on the [code2pdf](https://github.com/readbysearch/code2pdf) command-line
tool (3.12 or later) instead of Vim and Ghostscript.

- PDFs have a contents page, the files' own line numbers, their paths on every page, and a
  bookmark per file.
- Print a folder, files you check in a list, several selected files and folders, one file, or
  the lines you selected.
- Print what changed in git: uncommitted changes, the last commit, a branch, or everything since
  a commit. Changed lines are marked in the margin.
- Getting code2pdf: a Get Started page (opened on install) and an Install command. If code2pdf
  is missing or too old when you print, the extension offers to install or update it in a
  terminal, notices when that's done, and offers to print. The install works on a fresh Ubuntu
  desktop (wget, no curl) and in any shell. On Linux it offers an install for all users (sudo)
  and one just for you (no sudo, for machines where you can't use sudo). CI tries each way on
  fresh machines: macOS, Ubuntu 24.04 and 22.04.
- A progress notification you can cancel, with the time so far always moving (even while
  code2pdf is quiet on a long file), warnings and errors shown instead of failing silently,
  and everything code2pdf printed in the **code2pdf** output panel.
- Settings: where PDFs go, what opens them, the colour theme, and globs to include or exclude.
  Version 1's settings still work if you set them.
- Works over Remote SSH and in WSL; on Windows itself it explains how to use WSL.
- MIT licensed (version 1 had no licence). code2pdf itself stays AGPL-3.0.
- For version 1 users: the install message says code2pdf replaces Vim and Ghostscript, and after
  the first print a note says what changed (where PDFs go, which files are printed). "Print All
  Src File to A Single PDF" is now "Print All Source Files to PDF"; the old command IDs still work.
  See [Coming from version 1](https://github.com/readbysearch/code2pdf-vscode#coming-from-version-1).

## 1.2.0

- Better syntax highlighting.

## 1.1.1

- First release: print a file or all source files with Vim and Ghostscript.
