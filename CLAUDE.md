# code2pdf for VS Code

A VS Code extension (Marketplace id `readbysearch.code2pdf`) that runs the code2pdf command-line
tool ([readbysearch/code2pdf](https://github.com/readbysearch/code2pdf)). It draws nothing
itself: every PDF comes from `code2pdf`, so features belong in the CLI first. User docs are in
README.md only.

## Layout

- `src/extension.ts`: commands, settings, messages; the only file that imports `vscode`.
- `src/cli.ts`: finds code2pdf (setting, PATH, the installers' folders), checks
  `MIN_VERSION`, runs it with progress and cancellation (SIGINT to its process group, then
  SIGKILL). On Windows a program without a console gets no Ctrl-C: `taskkill /T /F` ends
  code2pdf.exe and its parts workers, and `removeLeftovers` deletes the `.code2pdf-*` files it
  left next to the PDF.
- `src/args.ts`: the command line for each kind of print; version 1's settings mapped to options.
- `src/git.ts`: the choices for Print Changes. A commit in the list means "it and everything
  after it" (`--changed <its parent>`); a typed REV means `--changed REV`.
- `src/progress.ts`: reads code2pdf's stderr (`[2/3] … (50%)`, `Done: N pages`, `Warning:`,
  `Note:`, `Error:`); `-s` reports on stdout.
- `src/install.ts`: install and update commands per platform and install kind. On Windows the
  "command" is a download (`download: true`), not a terminal.
- `src/download.ts`: Windows. Downloads `code2pdf-windows-x64.zip` from code2pdf's latest
  release (its `.sha256` first; `$CODE2PDF_DOWNLOAD_BASE` points elsewhere for tests), unpacks it
  with Windows' own `tar.exe`, runs `code2pdf.exe --version`, then swaps the folder in:
  `cli.windowsInstallDir()`, `%LOCALAPPDATA%\Programs\code2pdf`, the same place code2pdf's README
  tells terminal users to unzip it. One download at a time (`downloading` in extension.ts): a
  second one could reach the swap while Print Now runs code2pdf.exe, and Windows won't rename a
  folder whose program is running ("is in use").
- `src/telemetry.ts`: anonymous usage events for Azure Application Insights, sent through
  `vscode.env.createTelemetryLogger` (nothing when VS Code's telemetry is off or
  `code2pdf.telemetry` is false, and nothing while `CONNECTION_STRING` is empty). `EVENTS` lists every field that may be sent; the sender drops
  any other.
- `src/save.ts`: where a PDF goes without asking: the Desktop (Windows' registry, which knows
  where OneDrive moved it; XDG's user-dirs on Linux, where it may be `~/桌面`), else Documents,
  else home. `freePath` never replaces a file code2pdf didn't make from the same print: the
  `pdfsMade` list in globalState maps each PDF to what it was printed from.
- `src/viewer.ts`, `media/viewer.js`, `media/viewer.css`: the PDF tab, a custom editor
  (`code2pdf.pdf`, priority `option`, so it never takes over other PDFs) whose webview runs
  pdf.js. The extension sends the file's bytes (as a plain Uint8Array: a Node Buffer arrives as
  JSON), so it works over Remote SSH and WSL, and again when the file changes. pdf.js's worker
  starts from a blob URL (a webview can't start one from its resource origin). `pdfjs-dist` is a
  devDependency pinned to an exact version; `scripts/copy-pdfjs.mjs` (part of `compile`) copies
  its legacy build to `out/pdfjs`, which also runs in VS Code 1.90's Chromium.
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
- Usage events carry names and values only: never paths, file names, code, or VS Code's own
  IDs. No ID may outlive the session (`tags()`: a fresh `ai.session.id`, and `ai.location.ip`
  0.0.0.0 so Azure doesn't geolocate). PRIVACY.md promises both. Events need VS Code's
  telemetry on (the logger checks) and `code2pdf.telemetry`, which may only ever turn them off:
  it stays application-scoped so a workspace can't turn it on, and there's no popup asking
  (developers complain about both). A new field goes into `EVENTS`,
  `telemetry.json` (a unit test compares them), the README's "Usage data" list and PRIVACY.md
  together. Events are sent only by an installed extension
  (`ExtensionMode.Production`), never under test or while debugging, so the sender is checked
  by unit tests, and against Azure by `test/usage-data.sh` before each release.
- On Windows, code2pdf is code2pdf's Windows build (`code2pdf.exe`, 3.13 and later). The
  extension downloads only from code2pdf's GitHub release, checks the published SHA-256 and that
  it runs before replacing anything, and needs no administrator rights. A Windows build that
  isn't in `windowsInstallDir()` was unzipped by hand: it's never updated from here.
- Untrusted workspaces aren't supported: code2pdf runs git, and a repository's git config can
  run programs.
- No personal data or credentials in commits or their history, anywhere: files, comments, test
  data or commit messages. That means no email addresses, names, account, subscription or tenant
  IDs, local paths such as `/Users/<name>`, tokens or keys. Commits are authored as
  `readbysearch <readbysearch@users.noreply.github.com>`. Name an account by its role and look
  values up at run time, as `test/azure-setup.sh` does. The one exception is the connection
  string in `src/telemetry.ts`: it can only send events, and every copy of the extension carries
  it. Before each push, search what it adds (`git log -p origin/main..HEAD`). If something got
  pushed, a fix in a new commit leaves it in the public history: say so, and rewrite history
  only with the user's OK.

## Testing

```bash
npm ci
npm run lint
npm run test:unit            # node:test; the code2pdf-backed tests skip if it isn't installed
npx vscode-test              # integration, in a downloaded VS Code (.vscode-test/), on a git fixture
VSCODE_TEST_VERSION=1.90.0 npx vscode-test   # the oldest VS Code in engines
CODE2PDF_TEST_FILES='out/test/manual/*.test.js' npx vscode-test   # opens a PDF in the viewer, and in the tab for 20 s
npm run test:fresh           # first print on fresh Ubuntu 24.04 and 22.04 containers (needs Docker)
test/usage-data.sh           # usage data against Azure (needs `az login`; macOS, or Linux with a display)
```

`test/usage-data.sh` is the only check of what really reaches Azure. It checks the resources
still match PRIVACY.md (Sweden Central, 90 days, IP addresses not stored) and that
`CONNECTION_STRING` is the real resource's. It sends an event with and one without
`ai.location.ip`: only the second may get a location. Then it rebuilds the .vsix to send to
`code2pdf-vscode-test` and installs it in a separate VS Code profile with a helper extension
(`test/usage-data/driver/`). That prints one file three times: with VS Code's telemetry off,
with `code2pdf.telemetry` off, and with both on. Only the last run may send events, and those
must have no location, user ID or path. Nothing goes into the real resource's numbers.
`test/azure-setup.sh` creates or repairs the resources (the budget alert too); it never
re-creates `code2pdf-vscode`, whose connection string the extension ships.

`test/fresh-machine.sh` makes a container look like a fresh Ubuntu desktop (wget and python3;
no curl, git or code2pdf) and runs `src/test/fresh/`: the real install command runs in VS
Code's terminal (24.04: the .deb; 22.04: install.sh), then Print Now must print. Only the two
clicks are stubbed. CI's `fresh` job runs it on both, on a macOS runner (Homebrew, no
code2pdf), and on a Windows runner (the Install button downloads the Windows build).

`.vscode-test.mjs` builds the fixture project (a git repo with two commits and an uncommitted
edit) and points `code2pdf.outputFolder` outside it. Integration tests stub `vscode.window`
pickers and messages. CI (`.github/workflows/ci.yml`) runs on Ubuntu (the .deb; stable and
1.90.0), macOS (Homebrew) and Windows (the Windows build, unzipped as code2pdf's README says),
and weekly against the latest code2pdf release. Unit tests whose fake programs are shell
scripts skip on Windows (`POSIX_ONLY`).

## Releasing

1. Bump `version` in package.json (above the version on the Marketplace) and add a
   CHANGELOG.md entry.
2. `npm run lint && npm run test:unit && npx vscode-test && test/usage-data.sh`, then
   `npx vsce package` and `npx vsce ls` to check the contents (only out/*.js, out/pdfjs/ (pdf.js,
   its LICENSE and spinner), media/viewer.js and viewer.css, telemetry.json, the icon and
   images/pages.png, media/install.md, README, CHANGELOG, LICENSE).
3. Commit as readbysearch and push `main` (`gh auth switch -u readbysearch`; switch back to
   waleking afterwards), wait for CI, then tag `vX.Y.Z` and push the tag.
4. Publish: upload the .vsix at https://marketplace.visualstudio.com/manage/publishers/readbysearch
   (signed in as the publisher's owner), or `npx vsce publish` with an Azure DevOps PAT
   (Marketplace: Manage scope, all accessible organizations; PATs expire).
5. Images in README.md are relative; vsce turns them into github.com/…/raw/HEAD/ links, so they
   must be pushed before the listing shows them. `images/src/render.sh` draws the icon.
6. The README's demo GIFs: `npx vsce package && demos/record.sh` (Docker, ~4 minutes) records them
   in a real VS Code on a virtual screen, driven by `demos/record.py` (xdotool clicks at fixed
   positions on a 1280x800 screen; when VS Code's layout moves, take screenshots with shot() and
   adjust). `demos/make-project.sh` makes the demo project and its git history. Re-record when
   the UI changes.
