# code2pdf for VS Code

A VS Code extension (Marketplace id `readbysearch.code2pdf`) that runs the code2pdf command-line
tool ([readbysearch/code2pdf](https://github.com/readbysearch/code2pdf)). It draws nothing
itself: every PDF comes from `code2pdf`, so features belong in the CLI first. User docs are in
README.md only.

## Layout

- `src/extension.ts`: commands, settings, messages; the only file that imports `vscode`.
- `src/cli.ts`: finds code2pdf (setting, PATH, the installers' folders), checks
  `MIN_VERSION`, runs it with progress and cancellation (SIGINT to its process group, then
  SIGKILL).
- `src/args.ts`: the command line for each kind of print; version 1's settings mapped to options.
- `src/git.ts`: the choices for Print Changes. A commit in the list means "it and everything
  after it" (`--changed <its parent>`); a typed REV means `--changed REV`.
- `src/progress.ts`: reads code2pdf's stderr (`[2/3] … (50%)`, `Done: N pages`, `Warning:`,
  `Note:`, `Error:`); `-s` reports on stdout.
- `src/install.ts`: install and update commands per platform and install kind.
- `src/upgrade.ts`: telling version 1 users what changed, once. VS Code doesn't say what an
  update came from, so it's inferred: version 1 settings set, or the first print is what
  activated the extension for the first time (a fresh Marketplace install opens the walkthrough,
  which activates it earlier).
- Getting code2pdf: the `start` walkthrough opens on install (`onWalkthrough:start` activates
  the extension; its first step completes on the `code2pdf.installed` context, which
  `checkInstalled()` sets). An install started from a message or `code2pdf.install` runs in a
  terminal; `watchForInstall()` then calls `cli.find` every 3 s and offers Print Now (the
  last print command, `lastPrint`).

## Rules

- Never fail silently (the old version's reviews were about that): every error reaches a
  message, with the command and code2pdf's output in the code2pdf output channel.
- Paths go to code2pdf relative to the workspace folder (cwd), so the PDF shows project paths.
- Options passed to code2pdf must exist in `code2pdf --help`: the unit test
  `every option used here is in code2pdf --help` checks it. Using a newer CLI feature means
  raising `MIN_VERSION` in `src/cli.ts` and saying so in the README.
- `--files-from` takes no `--include`/`--exclude`, and `--changed` takes no `--include`
  (code2pdf refuses them).
- Untrusted workspaces aren't supported: code2pdf runs git, and a repository's git config can
  run programs.

## Testing

```bash
npm ci
npm run lint
npm run test:unit            # node:test; the code2pdf-backed tests skip if it isn't installed
npx vscode-test              # integration, in a downloaded VS Code (.vscode-test/), on a git fixture
VSCODE_TEST_VERSION=1.90.0 npx vscode-test   # the oldest VS Code in engines
CODE2PDF_TEST_FILES='out/test/manual/*.test.js' npx vscode-test   # opens a PDF in the viewer
npm run test:fresh           # first print on fresh Ubuntu 24.04 and 22.04 containers (needs Docker)
```

`test/fresh-machine.sh` makes a container look like a fresh Ubuntu desktop (wget and python3;
no curl, git or code2pdf) and runs `src/test/fresh/`: the real install command runs in VS
Code's terminal (24.04: the .deb; 22.04: install.sh), then Print Now must print. Only the two
clicks are stubbed. CI's `fresh` job runs it on both, and on a macOS runner (Homebrew, no
code2pdf).

`.vscode-test.mjs` builds the fixture project (a git repo with two commits and an uncommitted
edit) and points `code2pdf.outputFolder` outside it. Integration tests stub `vscode.window`
pickers and messages. CI (`.github/workflows/ci.yml`) runs on Ubuntu (the .deb; stable and
1.90.0) and macOS (Homebrew), and weekly against the latest code2pdf release.

## Releasing

1. Bump `version` in package.json (above the version on the Marketplace) and add a
   CHANGELOG.md entry.
2. `npm run lint && npm run test:unit && npx vscode-test`, then `npx vsce package` and
   `npx vsce ls` to check the contents (only out/*.js, icon, README, CHANGELOG, LICENSE).
3. Commit as readbysearch and push `main` (`gh auth switch -u readbysearch`; switch back to
   waleking afterwards), wait for CI, then tag `vX.Y.Z` and push the tag.
4. Publish: upload the .vsix at https://marketplace.visualstudio.com/manage/publishers/readbysearch
   (signed in as the publisher's owner), or `npx vsce publish` with an Azure DevOps PAT
   (Marketplace: Manage scope, all accessible organizations; PATs expire).
5. Images in README.md are relative; vsce turns them into github.com/…/raw/HEAD/ links, so they
   must be pushed before the listing shows them. `images/src/render.sh` draws the icon.
