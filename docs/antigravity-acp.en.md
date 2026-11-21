# Antigravity CLI as a local ACP Agent

[简体中文](antigravity-acp.md) · **English** · [Documentation](README.md)

You can opt in to Google's Antigravity CLI (`agy`) through **Agent Management → Connect a new Agent runtime** (`Agent 管理 → 接入新底座`). This recipe uses the installed desktop client's existing custom ACP support. It does not add a built-in runtime or bundle Google software.

Use your own Google account and credits. Do not share an account between people or use this setup to resell access; teams should arrange their own authorized accounts with the vendor. SoduWork's model allowance does not cover calls made with that account. Review the vendor's current terms, including its interaction-data collection policy, before use.

## Scope and prerequisites

- An installed SoduWork desktop with the custom Agent entry point and a working Hub connection.
- Antigravity CLI (`agy`) **1.5.0 or newer**, installed separately below. The `agy acp` subcommand exists only from 1.5.0; earlier builds have no stdio ACP server. From 1.5.1 every model available to your account is exposed to every ACP client. The version is explicit so upgrades remain deliberate.
- This recipe is for **local conversations**. The custom Agent does not declare support for SoduWork's unified access policy or native goal modes. Its tools can modify files and run commands; that is not a read-only or sandboxed configuration. Use a disposable working directory for the first conversation.
- Sign in through the vendor's own terminal UI before SoduWork starts. SoduWork's custom ACP bridge does not implement the ACP `authenticate` exchange or an Antigravity login/login-status button.

The vendor's [IDE extensions documentation](https://antigravity.google/docs/ide/extensions) defines `agy acp` as the stdio ACP server command (the "Other editors and tools (ACP)" section). The official installer is at [antigravity.google/cli](https://antigravity.google/cli); on macOS/Linux the binary lands in `~/.local/bin/agy` by default.

## 1. Install into a separate directory

Choose a directory outside your source and business workspaces. The example uses a dedicated SoduWork user-data directory so your everyday client settings are untouched; you will sign in to the Hub again inside that isolated client.

Windows PowerShell:

```powershell
$agyRoot = Join-Path $env:LOCALAPPDATA 'SoduWork-Antigravity'
$agyBin = Join-Path $agyRoot 'bin'
$env:SODUWORK_USER_DATA = Join-Path $agyRoot 'desktop'
New-Item -ItemType Directory -Force -Path $agyBin | Out-Null
irm https://antigravity.google/cli/install.ps1 | iex
# The official script installs under %LOCALAPPDATA%\agy\bin; to keep the
# setup fully separate, move or copy the downloaded agy.exe into $agyBin.
& (Join-Path $agyBin 'agy.exe') --version
```

macOS / Linux shell:

```sh
agy_root="$HOME/.local/share/soduwork-antigravity"
agy_bin="$agy_root/bin"
export SODUWORK_USER_DATA="$agy_root/desktop"
mkdir -p "$agy_bin"
curl -fsSL https://antigravity.google/cli/install.sh | bash
# The default location is ~/.local/bin/agy; copy it into $agy_bin to keep
# the setup fully separate.
agy_command="$agy_bin/agy"
[ -x "$agy_command" ] || agy_command="$HOME/.local/bin/agy"
"$agy_command" --version
```

Stop if `--version` reports below `1.5.0`: that version line has no `agy acp` at all. The vendor's installer ships an auto-updater; after any Antigravity upgrade, re-check the version pin and this recipe. Installation and updates need to reach the vendor's download source; resolve connectivity first. These commands never replace a global Antigravity installation.

## 2. Sign in, then start the desktop from the same terminal

Run `& (Join-Path $agyBin 'agy.exe')` in PowerShell, or `"$agy_command"` in the shell. Complete the vendor's Google OAuth sign-in in the terminal (browser authorization page, pasted code; over SSH, finish the printed authorization URL elsewhere), then exit the CLI. ACP execution reuses the same system-keyring credentials as the CLI. If `agy acp` asks for authentication after a terminal login, perform one interactive sign-in in the same user session first.

Before continuing, fully quit every SoduWork process using that user-data directory. Closing only the window can leave a background process running; relaunching would wake the old process without its updated environment.

Run the installed executable directly **from the same terminal**. Replace the example paths with your actual install location. On Windows use the stable `SoduWork.exe` at the installation root, not a versioned executable under `.soduwork-versions`:

```powershell
& 'C:\path\to\SoduWork.exe'
```

```sh
# macOS: use the executable inside the installed application bundle.
"/Applications/SoduWork.app/Contents/MacOS/SoduWork"
# Linux: instead run your installed executable or AppImage by its absolute path.
```

Every later start needs the same `SODUWORK_USER_DATA` before launching the executable directly; reinstalling is unnecessary, and re-signing in is unnecessary while the vendor session is valid. Ordinary desktop shortcuts do not inherit the terminal's environment variables.

**Source launcher limitation:** `start.cmd --desktop` / `sh start.sh --desktop` currently has no preserved path for desktop environment variables for this recipe; verify against the installed desktop if the source launcher filters or rewrites the variables.

The installed desktop passes its environment to the private Runner. Custom entries have no home override, so Antigravity uses its default keyring and `~/.gemini` state directories. Concurrent conversations inside one directory are not isolated; run one Antigravity turn at a time per account until you have verified the current release's concurrency behavior.

## 3. Register the local Agent

Open **Settings → Agent Management → Connect a new Agent runtime** and fill in:

| Field | Value |
| --- | --- |
| Display name | `Antigravity CLI` |
| Program | The full path of `$agy_command`, without surrounding quotes |
| Arguments | `acp` on its own line |
| Model source | The runtime's own account and models |

Click **Save and connect**. In this account mode do not select "Use models from SoduWork" and do not fill the model environment-variable mapping. Registration uses the existing custom Agent catalog mechanism; do not hand-edit JSON files or add `install.warn` or `runner.home` fields manually.

**Check program** only confirms the executable is found. It cannot verify vendor login, credits, ACP authentication, or model output. Create a local conversation selecting Antigravity CLI, and check those separately; sending a prompt uses the vendor account and may consume credits. Before real work, verify short answers, continuation, cancellation, and file operations inside a disposable working directory. If the CLI still demands an ACP authentication exchange after a terminal login, stop using this recipe: the current bridge does not support that flow.

## Troubleshooting and retirement

- **Program not found:** use the exact path from step 1. On Windows register `agy.exe`; do not put shell commands such as `cmd /c ...` in the program field.
- **`agy acp` exits immediately or produces nothing:** run `agy --version` and confirm it is at least `1.5.0`; earlier versions have no ACP server, so the bridge handshake cannot succeed.
- **Terminal is signed in but ACP still asks to log in:** confirm the desktop was fully quit and relaunched from the same user session; Antigravity credentials live in the system keyring and are unavailable across user or headless contexts. Never upload credential contents into issue reports.
- **Model list looks short:** the vendor exposes all account-available models to every ACP client from 1.5.1; older builds limit non-editor clients. Upgrade first, then re-check.
- **Wrong version:** run `--version` against the exact program registered in the UI, then reinstall only after evaluating and verifying a new pinned version in the vendor's release notes.
- **Retiring this recipe:** quit the isolated desktop and start your regular SoduWork from a fresh terminal or your normal shortcut without the temporary environment variables. Sessions in the isolated directory remain; do not remove the Agent by deleting the user-data directory, since custom registrations are append-only today.

Finding the executable, or completing an ACP handshake without a signed-in session, is not acceptance of a signed-in conversation. Vendor installation, authentication, and ACP behavior change with its release line; verify vendor authentication, paid calls, and native desktop behavior in your own environment before relying on this optional integration for work.
