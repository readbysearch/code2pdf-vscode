# Install code2pdf

This extension prints with the **code2pdf** command-line tool. The button on the left
installs it in a terminal, where you see the command and can answer its prompts:

| System | For all users (sudo) | Just for you (no sudo) |
| --- | --- | --- |
| macOS, or Linux with Homebrew | `brew install readbysearch/tap/code2pdf` (no sudo needed) | without Homebrew, on a Mac: `install.sh --user` (from conda-forge) |
| Ubuntu 24.04+, Debian 13+ | the `.deb` from GitHub, with `sudo apt install` | `install.sh --user` |
| Other Linux | `install.sh --system` | `install.sh --user` |

On Linux the button offers both. Choose "just for you" where you can't use sudo, such as a
shared server.

On Windows, the button downloads code2pdf for Windows (about 40 MB) from its GitHub release and
checks it: no terminal, and no administrator rights.

When the install finishes, this step is checked off and VS Code says so.

[Installation guide](https://github.com/readbysearch/code2pdf#installation)
