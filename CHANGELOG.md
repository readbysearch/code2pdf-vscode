# Changelog

## 2.2.3

- macOS without Homebrew: the Install button now installs code2pdf just for you with code2pdf's
  own installer, which gets Python, WeasyPrint and Pango from conda-forge: no sudo, and nothing
  to sign. Before, there was only a link to brew.sh. A third of Mac sessions had no Homebrew.
- Windows: when Windows refuses to run the downloaded code2pdf.exe, the message says that
  antivirus or a security policy blocked it, instead of "spawn UNKNOWN".

## 2.2.2

- A folder print that finds nothing now says why: code2pdf's default selection skips data, text
  and image files and hidden, build and dependency folders. The message says how to print them
  anyway (select the files in the Explorer, or the `code2pdf.include` setting) and opens the
  setting. This was the commonest failed print in the usage data.
- Windows: the download is tried once more when the connection drops, and fails after 30 seconds
  without data instead of waiting forever, which left Install unusable until VS Code restarted.
- Windows: putting the new code2pdf in place is retried for a few seconds when the folder is
  locked, as it is while antivirus scans what was just unpacked.
- Windows: code2pdf.exe gets 5 minutes, not 2, to answer `--version` after the download, and is
  installed even if it doesn't: the SHA-256 says the files are right, and security software can
  hold a new program's first start. If it still doesn't start, the message says so and suggests
  trying again in a few minutes, instead of calling it too old.

## 2.2.1

- Windows: when downloading code2pdf fails, the usage event says at which step (the download,
  unpacking, running it…) and gives the error code, such as ENOTFOUND or HTTP 404, but not the
  message, which can contain paths. Until now it said only that the install failed. The privacy
  policy lists the new fields.
- Windows: "is in use" is said only when the old code2pdf folder couldn't be replaced, not for
  every permission error along the way.

## 2.2.0

- PDFs open in a VS Code tab, with no other extension needed: the page you're on, zoom, and the
  contents page's links. **Open in Default App** opens the PDF in your computer's PDF viewer, to
  print it on paper. It works over Remote SSH and in WSL too. Set `code2pdf.openWith` to `viewer`
  for the PDF viewer, as before.
- PDFs are saved without asking, in a `code2pdf_generated_pdf` folder in the project that git
  ignores: it holds its own `.gitignore`, so yours isn't changed. The first one says where it
  went. On a Mac, macOS doesn't have to ask whether VS Code may use the Desktop, and over Remote
  SSH, in WSL and in dev containers the PDFs are next to the code. Printing the same thing again
  replaces its PDF, and the open tab shows the new one; a file code2pdf didn't make is never
  replaced. **code2pdf: Choose Where PDFs Go…** picks the Desktop, the workspace folder itself (as
  version 1 did), another folder, or a save dialog each time (the new `code2pdf.askWhereToSave`
  setting).
- The first print after VS Code starts says at once if it's checking code2pdf, and runs that check
  once rather than twice. On Windows, where code2pdf.exe can take seconds to start, nothing was
  shown for several seconds; now it's checked only when code2pdf.exe has changed.

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
