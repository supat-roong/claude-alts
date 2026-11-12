# Manual release test

CI builds and tests on Linux, macOS and Windows and starts the extension in a real VS Code, but it has no Claude Code and no signed-in account. This checklist covers what only real sign-ins can show. Run it once per platform before a release, on Windows especially.

Paths below are written for Windows (`%USERPROFILE%`). On macOS and Linux read `~` instead.

## What you need

- VS Code with the **Claude Code** extension installed.
- The `.vsix` to test: run `npm run package`, or download the `vsix-package` artifact from a green CI run. Install it with **Extensions → … → Install from VSIX**.
- Two claude.ai accounts, called **A** and **B** below.
- Two project folders, called **one** and **two**.
- **Claude Parallel Accounts** must not be installed. If it is, see step 9.

Tick each line as you go. If a check fails, run **Claude Alts: Show Log**, copy the log, and note the step number.

## 1. First start

- [ ] Open folder **one**. The status bar shows `👤` with an email, or offers to sign in.
- [ ] `%USERPROFILE%\.claude-alts` exists and contains `.installs.json`.
- [ ] Sign in to account **A** in Claude Code (its account menu, or `/login`). After the reload the status bar shows A's email.
- [ ] `%USERPROFILE%\.claude-alts\accounts\` contains a folder for A.

## 2. Second account

- [ ] In the same window, sign in to **B** through Claude Code. The window reloads and the status bar shows B.
- [ ] Hover the status bar item. Both A and B are listed.

## 3. Two windows at once

- [ ] Open folder **two** in a new window. Use **Switch Account for This Window** to pick **A**. That window reloads and shows A.
- [ ] Window **one** still shows **B**.
- [ ] Send a chat message in each window. In Claude Code's account view, each window bills its own account.
- [ ] Integrated terminal in window **one**: `claude auth status` reports B. In window **two** it reports A.

## 4. Shared history

- [ ] A conversation started in window **one** (B) is in window **two**'s (A) session history, and can be resumed there.

## 5. Switching

- [ ] In window **two**, switch to **B** and back to **A**. Each switch reloads the window, and the status bar and `claude auth status` agree afterwards.
- [ ] Close and reopen folder **two**. It comes back on **A**.

## 6. Other terminals

- [ ] Run **Use Accounts in Other Terminals…**. Add the line it shows to your PowerShell `$PROFILE` (on macOS/Linux, to `~/.zshrc` or `~/.bashrc`).
- [ ] Windows only: on a fresh Windows, a new PowerShell says *running scripts is disabled*, and the dialog explains how to allow it. After `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, new terminals load the helpers.
- [ ] In a new terminal outside VS Code, `claude-accounts` lists A and B.
- [ ] `claude-as <A's email> auth status` reports A. `claude-as <B's email> auth status` reports B.
- [ ] Windows only: run the same in **Windows PowerShell 5.1** (`powershell.exe`) as well as in `pwsh`.

## 7. Forget

- [ ] Hover → **Forget…** account **A**, and confirm.
- [ ] Window **two** reloads signed out and offers to switch to B.
- [ ] A is no longer in the list, and `claude-as <A's email> auth status` reports signed out.
- [ ] Windows only: the message says running sessions on A can't be stopped. macOS/Linux: any `claude` session on A is stopped.
- [ ] Sign in to A again. It comes back, and its old conversations are still there.

## 8. Uninstall

VS Code runs the uninstall step on its next start, not when you click Uninstall.

- [ ] Uninstall Claude Alts, then quit VS Code completely and start it again.
- [ ] Claude Code is still signed in, to the account you used last.
- [ ] Every conversation from steps 3–7 is in Claude Code's history.
- [ ] `%USERPROFILE%\.claude-alts` is gone. If it is still there, each folder left in it holds something of yours (`settings.json`, skills, plugins, MCP servers) and contains no `.credentials.json`.
- [ ] Optional: put `settings.json` into a window's working dir (`.claude-alts\windows\<id>\`) before uninstalling. That folder is kept, without its token.

## 9. Coming from Claude Parallel Accounts

Only if you can test the move from the original extension. Start from a machine where it is installed and has saved accounts.

- [ ] Install Claude Alts. The status bar says Claude Parallel Accounts is installed, and the extension stays inactive.
- [ ] `%USERPROFILE%\.claude-alts\accounts\` already contains copies of its accounts.
- [ ] Uninstall Claude Parallel Accounts and reload. Claude Alts starts working, lists the same accounts, and Claude Code's history shows every earlier conversation.
- [ ] Quit and restart VS Code, so the original's uninstall step runs. The accounts are still listed, and the history is complete once a window is open.
