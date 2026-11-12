# Claude Alts

[![CI](https://img.shields.io/github/actions/workflow/status/supat-roong/claude-alts/ci.yml?label=CI)](https://github.com/supat-roong/claude-alts/actions)
[![Platform: Linux | macOS | Windows](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows%20%7C%20WSL%20%7C%20SSH-orange.svg)](#requirements)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**A companion for the [Claude Code extension for VS Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code): run a different Claude account in each VSCode window, at the same time — with one shared conversation history.**

**[⬇️ Install from the Marketplace](https://marketplace.visualstudio.com/items?itemName=supat-roong.claude-alts)** · **[🐙 Source](https://github.com/supat-roong/claude-alts)** · **[🐛 Report an issue](https://github.com/supat-roong/claude-alts/issues)**

Claude Code signs you into **one** account, shared by every VSCode window. If you juggle several — personal, work, a second Pro for when the first hits its limits — this extension gives **each window its own account**: pick it once per window, and your conversations follow you across accounts instead of disappearing.

ℹ️ It's a **companion**, not a replacement: the official Claude Code extension must be installed; this one only controls which account each window uses.

ℹ️ Based on [Claude Parallel Accounts](https://github.com/DercasDrol/claude-parallel-profiles) by dercasdrol, published separately with its own settings and data folder. Already using it? See [Coming from Claude Parallel Accounts](#coming-from-claude-parallel-accounts).

> 🐧🍎🪟 **Linux, macOS and Windows:** desktop VSCode on Linux, **WSL**, **Remote-SSH** to a Linux host, dev containers, and macOS where Claude Code keeps its sign-in in `~/.claude/.credentials.json`. On a Mac whose Claude Code keeps it in the **Keychain** the extension stays inert and the status bar says why. **Native Windows** works too, with a few differences, see [Native Windows](#native-windows). The check happens where the extension actually runs: in a WSL/SSH window that's the *remote* side.

---

## The idea in 30 seconds

- **Sign in as usual** — through Claude Code's own UI (its account menu; `/login` in the chat works too). The extension notices and saves the account by itself — nothing extra to click, no names to invent: the account *is* its email.
- **Each window picks its account** from the status bar. Two windows run two accounts simultaneously — no logout/login dance, no cross-contamination. The window's integrated terminals get the same account.
- **Switching reloads the window** — required, not cosmetic: Claude Code reads its account once at start-up, so only a reload makes it both *show* and *bill* the account you picked.
- **History stays one whole.** Giving each window its own data directory would scatter your chats across them, so the extension keeps them in one store instead — your history is exactly the single history Claude Code always had. Hit a usage limit, switch account, *continue the same conversation*.
- **See how much each account has left.** The hover card and the account list show each account's session and weekly usage, as Claude Code last cached it.
- **Hit a limit, continue elsewhere.** When this window's account hits a usage limit, the extension offers to continue with another saved account. It only asks; nothing switches unless you pick one.
- **Forget really signs out.** Forgetting an account deletes its OAuth token from every copy on this machine and stops sessions running on it. The data directories stay — signing in again restores everything.
- **Uninstalling really cleans up.** Your history is consolidated back into the default `~/.claude`, your last account is handed back to Claude Code (still signed in), and every folder the extension made is deleted — no tokens left lying around.

> ⭐ **Enjoying it?** [Rate it on the Marketplace](https://marketplace.visualstudio.com/items?itemName=supat-roong.claude-alts&ssr=false#review-details) — it helps other developers discover it.

---

## Requirements

| Requirement | Notes |
| --- | --- |
| Linux, macOS or Windows | desktop Linux, WSL, Remote-SSH (Linux host), a dev container, a Mac whose Claude Code keeps its sign-in in `~/.claude/.credentials.json` (not the Keychain), or native Windows |
| VSCode ≥ 1.85 | |
| [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) | the thing being multiplied |
| `claude` CLI | asked read-only whether a directory is signed in. The binary bundled with Claude Code is used when `claude` isn't on `$PATH` (and first, on macOS) |

---

## Quick start

1. **Install** from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=supat-roong.claude-alts) (search "Claude Alts").
2. **You're probably already signed in** — the status bar shows your email, and the account is saved automatically.
3. **Add the second account**: in Claude Code, sign in as the other account (its account menu — or `/login` in the chat). The extension saves it and reloads the window onto it — the previous account stays in the list.
4. **Assign accounts to windows**: status bar → **Switch account**. Open another window for another project, give it the other account — both run in parallel.

---

## Daily use

**The status bar item** — `👤 you@example.com` (or the account's name, in its colour, if you gave it one) is the account **this window** runs as, confirmed against the real token (`claude auth status`), not just a label. A `○` after it means the account isn't saved yet; `Claude: sign in` means the window is signed out. **Click** it and the one action that makes sense right now happens directly: switch when there are other accounts, pick a saved account when the window is signed out, save when the account is new. **Hover** it for the full card — account details, switch/forget actions, and quick links to the extension page, its settings and its log.

**Switching** reloads the window; after the reload both the identity Claude Code shows and the token it bills are the ones you picked.

**Signing in as another account inside a window** (Claude Code's account menu, or `/login`) replaces only *that window's* account. The extension saves the new account, keeps the old one in the list, and reloads the window so Claude Code actually switches to it — other windows are untouched.

**Reopening a project** — the extension remembers which account each repository used last and restores it automatically (the tooltip says so).

**Rules and a default account.** To pin an account to a folder, run *Claude Alts: Always Use an Account for This Folder*, or add rules by folder glob or git remote in the `claudeAlts.folderRules` setting. A rule beats the remembered account; an account you pick in the window itself still wins. *Set the Account for New Windows* chooses what a brand-new window starts with (otherwise: the last account used).

**Names and colours.** *Name and Colour an Account* gives an account a short label (say, "Work") and a colour for the status bar. The email is still shown next to it everywhere it matters.

**Usage.** The hover card shows this account's session and weekly usage with reset times, and the Switch list shows every account's. The numbers are the ones Claude Code itself caches in each account's config; the extension makes no network call to get them, so they are as fresh as Claude Code last left them (the card says how old).

**Hitting a limit.** When Claude Code refuses a request in this window because the account hit a limit, the extension offers *Continue as …* with your other saved accounts, least used first, each with its usage (say, *Continue as Work (12% used)*). Accounts that are at a limit themselves aren't offered. Picking one switches this window; the conversation is in the shared history, so you reopen it from Claude Code's session list. It asks at most once per 15 minutes and never switches by itself. Turn it off with `claudeAlts.offerSwitchOnLimit`.

**Other terminals.** Integrated terminals already follow their window. For anything else (iTerm, Windows Terminal, ssh), run *Use Accounts in Other Terminals* and add the line it shows to your shell profile. Then `claude-as <account> [args]` runs Claude Code as that account, `claude-use <account>` switches the shell, and `claude-accounts` lists them. `<account>` is the email or the saved name. The script is kept up to date as accounts come and go; the extension never edits your profile itself.

**One account, one entry** — saving the same email twice reuses the existing entry; lists are collapsed by email, so you always see one row per account.

**Forgetting** (status bar hover → *Forget…*) asks for confirmation, then removes the account from the list, **deletes its OAuth token from every copy on this machine**, interrupts Claude sessions running on it, and reloads any window that was using it. That window comes back signed out and offers to switch to another saved account. If a copy of the sign-in can't be deleted, nothing is forgotten and you're told where it is. History, settings and the data folders stay on disk; signing in again brings the account back.

**Signing out** (Claude Code's account menu, or `/logout`) revokes the token on Anthropic's side — for every copy of it. The extension notices and removes the account from the list everywhere, since switching to it could only fail.

### Commands

Everything is reachable from the status bar; the Command Palette has it all under **Claude Alts:**

| Command | What it does |
| --- | --- |
| *Switch Account for This Window* | Pick another saved account; the window reloads onto it. |
| *Account Quick Action* | What clicking the status bar does: switch, pick an account, or save a new one. |
| *Save Current Account* | Save the signed-in account by hand (it's normally saved automatically). |
| *Forget a Saved Account* | Sign an account out everywhere on this machine and remove it from the list. |
| *Always Use an Account for This Folder…* | Add a folder rule for the current workspace. |
| *Set the Account for New Windows…* | Choose the account a brand-new window starts with. |
| *Name and Colour an Account…* | Give an account a short label and a status bar colour. |
| *Use Accounts in Other Terminals…* | Set up `claude-as`, `claude-use` and `claude-accounts` for outside terminals. |
| *Show Log* | Open the extension's output channel. |

---

## One conversation history

Claude Code has **one** history: it is stored per *data directory*, and vanilla Claude Code only ever has one directory. This extension gives each window a directory of its own — so it has to put the history back together, or installing it would make every conversation you ever had disappear from the panel.

It does that with one store, `~/.claude-alts/shared`, symlinked from every directory:

```text
~/.claude/projects                       ──┐
~/.claude-alts/accounts/work/projects    ──┼──▶  ~/.claude-alts/shared/projects/<per-repo>/…
~/.claude-alts/windows/a1b2…/projects    ──┘
```

- Conversations (`projects/`), session state, shell snapshots, file-edit history (checkpoints), plans, todos and your prompt history (`history.jsonl`) live there. **Credentials and identity never do** — those stay strictly per-account, which is the whole point of the extension.
- Transcripts stay keyed by workspace folder, exactly as Claude Code writes them, so nothing leaks between repositories.
- Hit a usage limit, switch account, carry on in the same conversation.

There is **nothing to configure** — this isn't a feature bolted onto Claude Code, it's what keeps Claude Code's own behaviour intact. If one of these entries is already a link to somewhere else you chose, the extension leaves it alone and tells you, rather than hide what's behind it.

**Uninstalling** moves the store back into the default `~/.claude` — see [Uninstalling](#uninstalling).

---

## How it works

Claude Code resolves its data directory from the `CLAUDE_CONFIG_DIR` environment variable. Every VSCode window runs its own extension-host process, so `process.env` is per-window — that's the isolation mechanism. Each **account** is a store (`~/.claude-alts/accounts/<name>`, or a `~/.claude-<name>` directory you set up yourself); each **window** runs on a private working copy of the account it picked:

```text
account stores                                       per-window working copies
~/.claude-alts/accounts/work      ──copy──▶  ~/.claude-alts/windows/a1b2… ◀── window A
~/.claude-alts/accounts/personal  ──copy──▶  ~/.claude-alts/windows/c3d4… ◀── window B
```

Everything the extension creates lives under that one `~/.claude-alts` folder.

The details that make it reliable — each one a bug found and fixed:

- **Activation order.** Claude Code reads `CLAUDE_CONFIG_DIR` the moment it activates and caches it — so this extension must get there *first*. It uses the `*` activation event, which VSCode's docs discourage because it loads the extension at every start-up: a deliberate, load-bearing trade-off — with any lazier activation the variable would be set after Claude Code has already read it, and per-window accounts simply wouldn't work. The cost is kept negligible: a ~60 KB bundle with zero runtime dependencies, and the activation path itself only sets the variable and does a handful of file checks — everything heavier is deferred. (The same start-up read is why switching needs a window reload.)
- **A working copy per window.** A `/login` writes into the window's own directory, so it can only ever affect that window — "which window signed in?" is answered by construction, and no other window's account can be overwritten. Copies of an OAuth token authenticate independently, so the duplicates are safe.
- **No competing source of truth.** A machine-wide `CLAUDE_CONFIG_DIR` in `claudeCode.environmentVariables` or `terminal.integrated.env` would force all windows onto one account — the extension strips it and keeps isolation in `process.env` only.
- **Terminals follow the window.** Integrated terminals get the window's account via VSCode's environment-variable API. External terminals keep using the default `~/.claude` unless you use the [shell helpers](#daily-use).
- **Reload safety.** Automatic reloads (after a forget or an in-window sign-in) go through a circuit breaker: state is corrected *before* reloading, and at most one automatic reload of each kind per minute (and three kinds in two minutes). A misbehaving edge case degrades to a message with a button, never a reload loop.
- **Survives its own absence.** The account in the focused window is mirrored into Claude Code's own default `~/.claude` on every sync, so if the extension is ever gone (uninstalled, disabled, or not yet activated), Claude Code is already signed in there and just works. Nothing important waits on the uninstall script, which VSCode defers to its next restart and may never run.
- **Found where it runs.** The extension is published as a single universal package, not per-platform. In WSL and Remote-SSH it executes on the Linux *remote*, but the VSCode *client* that resolves the Marketplace is often Windows or macOS — a Linux-only build would be invisible to that client, which then reports the extension as missing and never updates it. The platform requirement is enforced at runtime instead (the inert mode above).

---

## Native Windows

Claude Code on Windows keeps its sign-in in `%USERPROFILE%\.claude\.credentials.json`, so the extension works as on Linux, with these differences:

- **History links** are directory junctions, and a hard link for `history.jsonl`. Neither needs administrator rights or Developer Mode.
- **The CLI** is the `claude.exe` bundled with Claude Code, or `claude` run through `cmd` (for an npm install).
- **Forget can't stop running sessions.** Windows doesn't let an extension read another process's environment, so it can't tell which `claude` process uses which account. Close chats on a forgotten account yourself; the message reminds you.
- **Other terminals** get a PowerShell script: run *Use Accounts in Other Terminals* for the line to add to `$PROFILE`. Windows ships with PowerShell scripts disabled, `$PROFILE` included; if PowerShell says *running scripts is disabled*, allow your own with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

WSL and Remote-SSH windows are unaffected: there the extension runs on the Linux side, as before.

---

## Settings

All optional; accounts are still managed from the status bar.

| Setting | What it does |
| --- | --- |
| `claudeAlts.folderRules` | Pick a window's account by `folder` (path or glob, `~` allowed) or `gitRemote` (like `github.com/my-org/*`). First match wins. |
| `claudeAlts.defaultAccount` | The account (email) a brand-new window starts with. Empty: the last one used. |
| `claudeAlts.accountLabels` | Names and colours by email, like `{ "me@work.com": { "label": "Work", "color": "charts.blue" } }`. |
| `claudeAlts.offerSwitchOnLimit` | Offer another account when this one hits a usage limit. On by default. |

```json
"claudeAlts.folderRules": [
  { "folder": "~/work/**", "account": "me@work.com" },
  { "gitRemote": "github.com/my-org/*", "account": "me@work.com" }
]
```

---

## Privacy & your data

This extension is built to manage credentials, so it holds itself to a strict policy — each point verifiable in the [source](https://github.com/supat-roong/claude-alts):

- **No telemetry, no analytics, no network code at all.** The source contains zero network calls and **zero runtime dependencies** — it is your files, the `vscode` API, and Node's standard library. Nothing is ever sent anywhere.
- **Everything stays in your home directory.** Accounts, working copies and the history store live under `~/.claude-alts`, created with owner-only permissions (`600`/`700`). Credentials are only ever *copied between* Claude Code's own data directories on this machine — never parsed beyond checking they exist, never displayed, never transmitted.
- **Conversations are moved, not read.** Shared history relinks the files. The one exception is the limit offer: it reads the lines Claude Code *appends* to this window's own transcripts, only to spot Claude Code's "you've hit your limit" error. Nothing is stored or sent.
- **Usage numbers are Claude Code's own.** They are read from the cache Claude Code keeps in each account's config; the extension never asks the API.
- **Minimal footprint elsewhere:** the workspace folder path is hashed to tell windows apart; `claude auth status` is asked (locally, read-only) to confirm a directory is signed in; the process list (`/proc` on Linux/WSL, `ps` on macOS; not available on Windows) is scanned only during *Forget*, to stop `claude` processes running on the token being deleted.
- **Self-restricted in the VSCode manifest:** disabled in virtual workspaces, and in Restricted Mode (untrusted folders) it never runs anything from the workspace ([`capabilities`](package.json)). From the workspace itself it reads only the folder's path, to tell windows apart, and — only if you have a `gitRemote` rule — the remote URLs in its `.git/config`. Git is never run.
- **Never touches the Keychain.** On a Mac whose Claude Code keeps its sign-in there, the extension does nothing at all.
- **Inert where unsupported.** On any OS other than Linux, macOS and Windows it performs no operations at all: no file reads, no writes, no account changes. The uninstall hook is guarded the same way.
- **Uninstalling cleans up after itself:** the directories the extension created are deleted and stray OAuth tokens wiped; the one token it leaves is in `~/.claude`, exactly where Claude Code keeps its own login with no extension installed — see [Uninstalling](#uninstalling).

---

## Uninstalling

Removing the extension takes away everything it made and nothing that's yours — **and leaves Claude Code signed in and working**.

**You stay signed in the whole time, not just at the end.** While the extension runs it continuously keeps Claude Code's own default account (`~/.claude`) pointed at whichever account you last used — the normal place Claude Code keeps its login. So the instant the extension is gone — uninstalled, disabled, or simply not activated yet — plain Claude Code is already signed in and working. This does **not** depend on the uninstall step running: VSCode defers uninstall scripts to its next restart (and may skip them), so nothing that matters is trusted to one.

When the uninstall script *does* run, it tidies up:

- **Your history is consolidated** into `~/.claude` — the shared store is *moved* there (instant, whatever its size; a few hundred milliseconds even for gigabytes), and any history an account kept to itself is folded in. Plain Claude Code has one history, not one per account.
- **Every directory the extension created is deleted** — the account stores, the per-window working copies, the shared store — **unless you put something of your own in it.** Claude Code writes your `settings.json`, skills, plugins, agents and user-scope MCP servers into whichever directory it runs on; a directory holding any of those is kept (minus its OAuth token) instead of deleted. Backups the extension made of diverging conversations are kept too.
- **A `~/.claude-<name>` directory you made yourself** and the extension only adopted (say, from `CLAUDE_CONFIG_DIR=~/.claude-work claude`) is kept with its settings and sign-in; only its history links are pointed at `~/.claude`.
- **If anything can't be moved in time**, the script stops rather than risk your data: it still wipes stray tokens, but keeps any directory whose history hasn't safely reached `~/.claude`. (It runs on a strict deadline — VSCode kills uninstall scripts after five seconds — so it never reads a file it can only move.)

Your other accounts stay signed out afterwards; sign into them the normal way. Directories the extension didn't create are never deleted: it deletes only stores that its manifest, their location and a marker file inside them all say it made. And if the extension is still installed elsewhere on this machine — a newer version, or another editor sharing your home folder (VS Code Insiders, Cursor, a remote server…) — the script does nothing at all, since that copy still uses the data.

---

## Coming from Claude Parallel Accounts

The two extensions can't run at the same time: both link Claude Code's own `~/.claude` history to their store. While Claude Parallel Accounts is installed (in any editor on this machine), Claude Alts stays inactive and the status bar says so.

1. Install Claude Alts.
2. Uninstall Claude Parallel Accounts — in every editor where you have it — and reload.

On its first run Claude Alts carries everything over:

- **Conversations:** the history behind Claude Parallel Accounts' links is moved into this extension's store, so nothing disappears from the panel.
- **Saved accounts:** the `~/.claude-<name>` accounts Claude Parallel Accounts managed are copied into `~/.claude-alts/accounts`. Copies, because its uninstall deletes the originals; the copies keep working after that.
- **Settings** don't carry over: they were `claudeProfiles.*` and are now `claudeAlts.*`. Copy your folder rules, default account and labels across.

Saved accounts are copied as soon as Claude Alts sees Claude Parallel Accounts installed, so nothing depends on which runs first. VSCode runs an extension's uninstall step at its next start, and Claude Parallel Accounts' step resets `~/.claude` to plain Claude Code. Until a window running Claude Alts starts again, `claude` in an outside terminal may show no history or another account. Nothing is lost, and the next window start puts it back.

---

## Limitations

- **On native Windows, *Forget* can't interrupt running sessions** (see [Native Windows](#native-windows)). **Keychain-backed Macs aren't supported:** there the extension stays inert. It needs Claude Code's sign-in in `~/.claude/.credentials.json`.
- ***Forget* stops `claude` sessions by executable name.** A CLI installed through npm runs as `node` and isn't recognised; close those sessions yourself.
- **The limit offer can't tell windows on the same folder apart.** If a folder is also open as part of a `.code-workspace` in another window, or used by `claude-as` in a terminal, a limit hit there can trigger the offer here. It only ever asks.
- **Loads at every VSCode start-up** (`*` activation). Required to win the activation race against Claude Code — see [How it works](#how-it-works). The extension is deliberately tiny, so the impact is milliseconds.
- **API-key users**: this is for OAuth (claude.ai) logins. With `ANTHROPIC_API_KEY` you don't need it — set the key per window yourself.
- **Switching reloads the window** — a consequence of Claude Code reading its account once at start-up; surfaced honestly rather than pretended around.
- **Uninstalling leaves you signed into one account** (the last one you used). Vanilla Claude Code holds one account at a time — the others have to be signed into the normal way.
- **The same project in two windows shares one conversation list.** VSCode won't open the same folder twice, but a folder and a `.code-workspace` containing it are two windows on one project — and since history is one store (as it is in plain Claude Code), both see the same chats and could resume the same one under *different accounts*. The transcript is a tree of parent-linked entries, so this forks the conversation rather than corrupting it, but the two branches will bill two accounts. Don't drive one chat from two windows at once.

---

## Development & releases

```bash
npm ci            # install
npm run watch     # dev build with watch
npm run compile   # typecheck + build
npm test          # unit tests: logic, uninstall safety, migration, shell helpers in real shells
npm run test:integration  # loads the extension in a real VS Code
npm run package   # build .vsix
npm run release:ovsx  # publish to Open VSX by hand (needs OVSX_PAT)
```

- **CI** ([ci.yml](.github/workflows/ci.yml)): every push/PR to `main` builds and tests on Linux, macOS and Windows, runs the integration test on Linux, then uploads the `.vsix` artifact.
- **Manual test** ([docs/manual-test.md](docs/manual-test.md)): what CI can't cover, with real sign-ins. Run it per platform before a release.
- **Release** ([release.yml](.github/workflows/release.yml)): pushing a `v*` tag builds, tests, creates a GitHub Release with the `.vsix`, and publishes to the VS Code Marketplace (Trusted Publishing via GitHub OIDC — no secret) and Open VSX (trusted publishing; the first-ever Open VSX publish needs an `OVSX_PAT` secret).

```bash
# release flow: make sure package.json version matches the tag, then
git tag v<version>
git push origin main --tags     # CI does the rest
```

---

## Credits

Claude Alts is inspired by and built on [Claude Parallel Accounts](https://github.com/DercasDrol/claude-parallel-profiles) by dercasdrol, which itself grew out of [claude-profiles](https://github.com/tundak/claude-profiles) by tundak. Thanks to both for the idea of running a Claude account per VSCode window.

---

## License

MIT License — see [LICENSE](LICENSE) for details.
