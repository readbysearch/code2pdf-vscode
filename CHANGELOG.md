# Changelog

## 2.0.0

A new extension, built on the [code2pdf](https://github.com/readbysearch/code2pdf) command-line
tool (3.12 or later) instead of Vim and Ghostscript.

- PDFs have a contents page, the files' own line numbers, their paths on every page, and a
  bookmark per file.
- Print a folder, files you check in a list, several selected files and folders, one file, or
  the lines you selected.
- Print what changed in git: uncommitted changes, the last commit, a branch, or everything since
  a commit. Changed lines are marked in the margin.
- If code2pdf isn't installed, or is too old, the extension says so and offers to install or
  update it in a terminal.
- A progress notification you can cancel, warnings and errors shown instead of failing
  silently, and everything code2pdf printed in the **code2pdf** output panel.
- Settings: where PDFs go, what opens them, the colour theme, and globs to include or exclude.
  Version 1's settings still work if you set them.
- Works over Remote SSH and in WSL; on Windows itself it explains how to use WSL.

## 1.2.0

- Better syntax highlighting.

## 1.1.1

- First release: print a file or all source files with Vim and Ghostscript.
