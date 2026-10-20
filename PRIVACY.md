# Privacy

This policy covers the code2pdf extension for VS Code (`readbysearch.code2pdf`), published by
readbysearch. Last changed on 20 October 2026, for version 2.2.0.

## In short

- When VS Code's telemetry is on, the extension sends a few anonymous usage events. You can turn
  them off for VS Code as a whole, or for this extension alone.
- They say what happened, such as code2pdf found or missing, an install chosen, or a print
  finished. They never say who you are, what you printed, or where your files are.
- Microsoft Azure stores them for us for 90 days. Only the extension's maintainers can see them.
- The code2pdf command-line tool, which does the printing, sends nothing.

## What is sent

- **When the extension starts:** whether code2pdf was found, its version and how it was installed
  (Homebrew, Debian package and so on), whether Homebrew is installed, on Linux the distribution
  and its version, and whether this is the extension's first start on this computer.
- **When it offers to install or update code2pdf:** why (missing, too old, or not where a setting says), whether a
  print or the Get Started page led to it, the buttons it showed, and the one you chose.
- **When an install it started is done,** fails or is cancelled, or after 30 minutes without
  one: which install, and how long it took.
- **When a print ends:** what was printed (a file, some lines, a folder, chosen files or changes),
  whether it printed, failed, was cancelled or its save dialog was closed, the number of pages
  and warnings, how long it took, code2pdf's exit code if it failed, and two settings: whether
  PDFs go to the project's folder for them, a set folder or a save dialog, and what opens them.

Every event also carries the versions of the extension and VS Code, the editor's name (such as
Visual Studio Code or Cursor), the operating system, the processor type, the kind of remote
session (such as SSH or WSL, or none), and a random ID for this session.

`telemetry.json` in the extension lists every field. The extension drops anything not on that
list before sending, and `code --telemetry` shows the list alongside VS Code's own.

## What is never sent

- Your name, user name, email address or any account.
- File names, folder names, paths, or any code or text from your files.
- VS Code's machine ID or session ID, or any other ID your editor or computer already has.
- An ID that lasts: each time the extension starts, it makes a new random ID for that session,
  and never saves it. So events from different sessions can't be linked to each other, or to you.

## Your IP address

Like any connection over the internet, sending an event shows your IP address to Microsoft Azure,
which receives it. The extension tells Azure not to use it to work out a location, and Azure
Application Insights doesn't store IP addresses.

## Why

To find out where people get stuck, and fix it. For example: on Windows, on a Mac without
Homebrew, during an install that doesn't finish, or in a print that fails. We rely on our
legitimate interest in making the extension work for the people who install it (Article 6(1)(f)
of the GDPR). You can object at any time by turning telemetry off.

## Where it's kept, and for how long

The events are stored in Azure Application Insights, a Microsoft service that processes them for
us, in its Sweden Central region in the EU. They're deleted after 90 days. Only the extension's maintainers can see them. We may publish
overall numbers, such as the share of installs on each operating system, but never individual
events. We don't sell the data or share it with anyone else.

## Turning it off

There are two switches. Either one stops the events.

- **VS Code's telemetry setting** turns usage data off for VS Code and every extension. In
  Settings, search for **telemetry** and set **Telemetry Level** to `off`, or add
  `"telemetry.telemetryLevel": "off"` to your `settings.json`. The extension also sends nothing
  when the level is `crash` or `error`.
- **`code2pdf.telemetry`** turns it off for this extension alone. In Settings, search for
  **code2pdf telemetry** and uncheck it, or add `"code2pdf.telemetry": false` to your
  `settings.json`.

Only your own settings count: a project's `.vscode/settings.json` can't turn usage data back on.

## Your rights

No event carries anything that identifies you, and no ID lasts longer than a session. So we
can't find, show you, or delete the events that came from your computer. They're deleted after
90 days anyway. If you have a question about this policy, open an issue at
https://github.com/readbysearch/code2pdf-vscode/issues.

## Other connections

Sending these events is the only connection the extension makes by itself. Others happen only
when you choose them:

- **Installing or updating code2pdf from the extension** runs Homebrew, apt or code2pdf's install
  script in a terminal. They download from GitHub, Homebrew, the Python Package Index or
  conda-forge, under those services' own policies. On Windows, the extension downloads
  code2pdf's Windows build from GitHub itself. Homebrew counts installs in its own anonymous
  analytics, which `brew analytics off` turns off.
- **Links in the extension's messages,** such as brew.sh or the installation guide, open in your
  browser.

## Changes

Changes to this policy are listed in the extension's
[CHANGELOG](https://github.com/readbysearch/code2pdf-vscode/blob/main/CHANGELOG.md).
