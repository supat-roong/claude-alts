# Changelog

## 1.0.0 — 2026-11-08

First release as **Claude Alts** (`supat-roong.claude-alts`), based on [Claude Parallel Accounts](https://github.com/DercasDrol/claude-parallel-profiles) 1.3.2 by dercasdrol. It is published separately, with its own commands, settings (`claudeAlts.*`) and data folder (`~/.claude-alts`). Changes relative to Claude Parallel Accounts 1.3.2:

### Added

- **Moving over from Claude Parallel Accounts.** Its conversations are moved into this extension's history store, and the accounts it managed are imported as copies, which survive its uninstall. While it is still installed, in any editor on this machine, this extension only copies those accounts and otherwise stays inactive, saying why: both link Claude Code's own `~/.claude` history.
- **Native Windows support.** Claude Code on Windows keeps its sign-in in `.credentials.json`, so the file-based model applies. Shared history uses directory junctions and a hard link for `history.jsonl`, which need neither admin rights nor Developer Mode. The CLI is the `claude.exe` bundled with Claude Code, or `claude` through `cmd`. *Forget* can't interrupt live sessions on Windows and says so.
- **Usage meters.** The hover card shows the account's session and weekly usage with reset times, and the Switch list shows every account's. Read from the usage Claude Code already caches in each account's config (`cachedUsageUtilization`); no network calls.
- **Continue with another account at a limit.** When Claude Code records a usage-limit refusal in this window's transcript, the extension offers to continue with another saved account, least used first. It only asks, at most once per 15 minutes; nothing switches unless you pick an account. Setting: `claudeAlts.offerSwitchOnLimit`.
- **Folder and git-remote rules, and a default account.** `claudeAlts.folderRules` picks a window's account by folder glob or remote URL; `claudeAlts.defaultAccount` picks the account a brand-new window starts with. Commands: *Always Use an Account for This Folder*, *Set the Account for New Windows*.
- **Display names and colours** per account (`claudeAlts.accountLabels`, command *Name and Colour an Account*), shown in the status bar and the account lists.
- **Accounts in external terminals.** *Use Accounts in Other Terminals* sets up `claude-as`, `claude-use` and `claude-accounts` for bash/zsh and PowerShell, kept in step with the account list. The extension never edits your shell profile.
- A Settings link in the hover card, and an `npm run release:ovsx` script for publishing to Open VSX by hand.
- **macOS support**, where Claude Code keeps its sign-in in `~/.claude/.credentials.json`. *Forget* finds live `claude` sessions through `ps`. A Mac whose Claude Code keeps its sign-in in the Keychain is detected (the default account has an identity but no credential file) and the extension stays inert there, as on an unsupported OS: nothing is read or written, and the uninstall hook does nothing.

### Changed

- **Everything lives under `~/.claude-alts`**: per-window working dirs (`windows/`), the shared history (`shared/`), the accounts the extension creates (`accounts/`), and the shell helpers (`shell/`). `~/.claude-<name>` directories you made yourself are still found and adopted.
- A link in a Claude data directory that points somewhere you chose is left alone, with a warning, instead of being replaced.

### Fixed

- **Uninstall keeps what's yours.** A working dir or account store holding your own `settings.json`, skills, plugins, agents or user-scope MCP servers is kept, minus its token, instead of deleted; backups of diverging conversations (`.merge-backup`) are kept too.
- **Uninstalling from one editor no longer signs out another.** The uninstall step does nothing while a copy is installed in another editor sharing the home folder (VS Code Insiders, Cursor, Windsurf, remote servers, or any editor the extension has run from).
- On Windows, if uninstall can't move a history folder (a file in it is open), the link to it is restored instead of leaving `~/.claude` without its history.
- The PowerShell helper is written with a BOM and escapes every kind of single quote, so Windows PowerShell 5.1 reads non-ASCII paths correctly and never fails to parse it.
- A working dir is never stocked with a token but no matching config, which paired one account's token with another's identity.
- *Forget* finds sessions of the native Claude CLI install on macOS.
- `gitRemote` rules ignore submodule URLs.
- Temp files are per process, so windows starting together don't trip over each other.
- **Windows, found in a Windows 11 test run:** uninstall now deletes working dirs that hold junctions (under the Node VS Code runs the hook with, a recursive delete reported success and left them); *Use Accounts in Other Terminals* explains how to let PowerShell run scripts, which a fresh Windows blocks, profile included; and *Forget* no longer promises to interrupt sessions it can't find there.
- **Two windows on different accounts no longer overwrite each other.** Each window mirrored its account into the default `~/.claude` and woke up on the other window's mirror, so they rewrote it every couple of seconds and ran `claude auth status` nonstop. Now only the focused window mirrors, and a bound window doesn't watch `~/.claude.json`.
- **Uninstall never deletes a profile you made yourself.** A `~/.claude-<name>` directory the extension adopted used to be deleted with its settings and sign-in. Stores are now recorded as created or adopted, created ones carry a marker file, and only created ones are deleted; adopted ones keep everything and their history links are pointed at `~/.claude`. Stores from older versions count as created only if they hold nothing but what the extension puts in one.
- *Forget* and the clean-up after `/logout` fail closed: the account's own store is signed out first, nothing changes if that fails, and a sign-in that couldn't be deleted is reported instead of claimed gone.
- A window whose account was forgotten or signed out now comes back signed out, offering to switch, instead of silently adopting the default account.
- The first-run setup reload no longer swallows the sign-in reload that follows it: automatic reloads are limited per kind.
- A working directory is no longer stocked with an identity but no token (a state that looks like a `/logout`), and switching to an account whose sign-in can't be read says so instead of reloading onto the old account.
- `claude auth status` for the default `~/.claude` runs with `CLAUDE_CONFIG_DIR` unset, as Claude Code does; the variables are applied after the login shell's profile; and the binary bundled with Claude Code is used when `claude` isn't on `PATH` (first, on macOS).
- An inherited `CLAUDE_SECURESTORAGE_CONFIG_DIR` is dropped, and removed from `claudeCode.environmentVariables` and `terminal.integrated.env.*`.
- A command interrupted by its own window reload is no longer logged as `ERROR … Canceled`.

## Claude Parallel Accounts

Releases of the extension this one is based on.

### 1.2.5 — 2026-07-12

#### Fixed

- **Shared-history links are created the moment a window's working directory is stocked**, not only at activation. Previously a `claude` process started right after a mid-session bind could write history into unlinked real directories — invisible to other accounts — and could not see conversations recorded before the bind, failing with "Session … not found" when forking/resuming (the root cause of that error on v1.2.0/1.2.1; the stray history was merged back into the shared store automatically, nothing was lost).

#### Changed

- Sign-in/out wording in the README and in messages now leads with Claude Code's account-menu UI; slash commands are mentioned as the alternative.
- README documents the deliberate `*` activation trade-off: why winning the activation race against Claude Code requires it, and why the cost stays negligible (~25 KB bundle, zero dependencies, trivial activation path).
- README: the single-setting table replaced with plain text.

### 1.2.4 — 2026-07-12

#### Changed

- **Linux-only platform gate.** The extension is built for the file-based credential layout Claude Code uses on Linux; elsewhere those assumptions break (macOS keeps credentials in the Keychain, native Windows is untested). Two layers now enforce this honestly:
  - the Marketplace release ships **Linux packages only** (x64/arm64/armhf + Alpine), so macOS / native Windows aren't offered the extension at all — WSL, Remote-SSH and dev containers install into the remote Linux side and keep working;
  - if a VSIX is side-loaded anywhere else, the extension activates into an **inert mode**: no files read or written, no accounts or settings touched (the uninstall hook is guarded the same way); the status bar and all commands explain the situation instead of failing cryptically.
- README: prominent platform-support note; deduplicated the header links (one Marketplace link instead of six) and replaced the retired shields.io marketplace badges with live CI/platform/license ones.

### 1.2.3 — 2026-07-12

The per-window architecture release: account isolation is now structural, not heuristic.

#### Added

- **Per-window working directories.** Each window runs a private copy (`~/.claude-windows/<id>`) of its account's store, so a `/login` can only ever affect the window it happened in — no shared state, no focus guessing, no races.
- **Auto-save.** A signed-in account is saved the moment it's noticed; the separate "save" step is no longer required (the command remains for manual use).
- **Forceful forget.** Forgetting an account now deletes its OAuth token from every copy on the machine, interrupts live `claude` sessions running on it, and reloads any window that used it — with a confirmation up front and a "Switch account" offer after.
- **Logout handling.** `/logout` revokes the token server-side, so the account is removed from the list everywhere instead of lingering as a dead entry.
- **Terminals follow the window.** Integrated terminals get the window's account via VSCode's environment-variable collection.
- **Status bar hover card** with the extension's name, account details, actions, and quick links to Settings, the extension page, and the log (new *Show Log* command).
- **Reload circuit breaker.** All automatic window reloads correct their trigger state first and are capped at one per minute — a misbehaving edge degrades to a message with a manual button, never a reload loop.
- **Manifest self-restrictions:** disabled in virtual workspaces; limited (content never read, settings not overridable) in Restricted Mode.
- Signed-out windows offer one-click switching to a saved account (status bar click, notices, hover).

#### Fixed

- Infinite reload loop after forgetting the account a window was running.
- Switching appearing to do nothing after an in-window `/login` (the window now fully reloads onto the new account; the old one stays in the list).
- Newly added accounts not appearing in other windows until restart (the registry now converges on the on-disk stores).
- A fresh login taking ~30 s to be saved (identity is read from disk instead of spawning the CLI).
- A failed working-copy stocking is no longer mistaken for a logout (which used to drop a perfectly good account).
- Uninstall now also reverts the nested per-window directories and removes their token copies.

### 1.1.5 — 2026-07-12

- Reliable per-window switching: activation-order fix (the extension now sets `CLAUDE_CONFIG_DIR` before Claude Code reads it), machine-wide setting overrides stripped, identity confirmed against the real token.

### 1.0.5 — 2026-07-12

- Rework into per-window parallel accounts with a shared conversation history store (`~/.claude-shared`) and clean uninstall.

### 1.0.0 — 2026-07-12

- Initial release: capture, switch and isolate Claude Code accounts per VSCode window.
