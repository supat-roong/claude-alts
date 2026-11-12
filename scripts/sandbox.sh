#!/usr/bin/env bash
# Runs the extension from source in an isolated VS Code: its own HOME, user data
# and extensions, so your real ~/.claude and running sessions are never touched.
#
#   scripts/sandbox.sh          build, set up the sandbox (once), launch
#   scripts/sandbox.sh clean    delete the sandbox (quit its VS Code first)
#
# SANDBOX=/path overrides the location (default ~/cpa-sandbox).
set -euo pipefail

# Run from a VS Code terminal (or a Claude Code session), this shell inherits
# that window's CLAUDE_CONFIG_DIR / CLAUDE_SECURESTORAGE_CONFIG_DIR, and the
# sandbox would then run on YOUR real account dir. VSCODE_* would also make
# `code` hand the launch to the running VS Code. Drop all of them.
while read -r v; do unset "$v"; done < <(compgen -e | grep -E '^(CLAUDE|ANTHROPIC|VSCODE)_' || true)

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SB="${SANDBOX:-$HOME/cpa-sandbox}"

if [[ "${1:-}" == "clean" ]]; then
  rm -rf "$SB"
  echo "Removed $SB"
  exit 0
fi

command -v code >/dev/null || { echo "The 'code' CLI is not on PATH." >&2; exit 1; }
CLAUDE_BIN="$(command -v claude || true)"
[[ -n "$CLAUDE_BIN" ]] || { echo "The 'claude' CLI is not on PATH." >&2; exit 1; }

echo "Building ($(git -C "$REPO" branch --show-current))…"
(cd "$REPO" && npm run build --silent)

mkdir -p "$SB/home" "$SB/projA" "$SB/projB"
# The extension calls `claude` through a login shell; under the fake HOME that
# shell reads the sandbox's rc files, so point it at the real CLI.
echo "export PATH=\"$(dirname "$CLAUDE_BIN"):\$PATH\"" > "$SB/home/.zshenv"
cp "$SB/home/.zshenv" "$SB/home/.bash_profile"

# macOS finds the login Keychain under $HOME/Library/Keychains, so the fake HOME
# has none ("A keychain cannot be found to store 'Code'"). Give the sandbox an
# empty Keychain of its own — your real one is never touched. Unlocked on every
# launch, with no auto-lock, since its password is empty anyway.
sbsec() { HOME="$SB/home" security "$@"; }
if [[ ! -f "$SB/home/Library/Keychains/login.keychain-db" ]]; then
  echo "Creating the sandbox Keychain…"
  mkdir -p "$SB/home/Library/Keychains"
  sbsec create-keychain -p '' login.keychain
  sbsec list-keychains -d user -s login.keychain
  sbsec default-keychain -d user -s login.keychain
fi
sbsec unlock-keychain -p '' login.keychain
sbsec set-keychain-settings login.keychain

vscode() {
  HOME="$SB/home" code --user-data-dir "$SB/data" --extensions-dir "$SB/ext" "$@"
}

if ! vscode --list-extensions 2>/dev/null | grep -qi '^anthropic.claude-code$'; then
  echo "Installing Claude Code into the sandbox…"
  vscode --install-extension anthropic.claude-code
fi

echo "Launching sandbox VS Code (HOME=$SB/home)."
echo "Second window: File → New Window, open $SB/projB."
vscode --extensionDevelopmentPath="$REPO" --new-window "$SB/projA"
