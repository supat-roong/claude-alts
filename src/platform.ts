import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Where this extension can run.
 *
 * What it depends on is Claude Code keeping its OAuth token as a FILE
 * (`<CLAUDE_CONFIG_DIR>/.credentials.json`), and a way to link every dir to the
 * shared history. Linux has both. Native Windows keeps the file, and links
 * through directory junctions and hard links — neither needs admin rights or
 * Developer Mode (see sharedHistory.ts); the CLI is the `claude.exe` Claude Code
 * bundles. macOS has the links, but the file only conditionally: Claude Code
 * prefers the Keychain there, and a Keychain-backed Mac is not supported (see
 * credentialsInKeychain).
 */
export function isSupportedPlatform(): boolean {
  return process.platform === 'linux' || process.platform === 'darwin' || process.platform === 'win32';
}

let keychain: boolean | undefined;

/**
 * True when this Mac's Claude Code keeps its token in the Keychain instead of
 * `.credentials.json`. Every flow here copies, compares and deletes that file,
 * and on such a Mac there is none — so the extension stays INERT there, exactly
 * as on an unsupported OS. It never reads or writes the Keychain.
 *
 * The fingerprint is the default account: `~/.claude.json` names a signed-in
 * account but `~/.claude/.credentials.json` does not exist. Our own sign-out
 * clears that identity along with the token (see reclaim.signOut), so a leftover
 * identity without a token is Claude Code's Keychain at work, not our doing.
 *
 * Decided once per activation: the answer must not flip under a running window.
 */
export function credentialsInKeychain(): boolean {
  if (keychain !== undefined) return keychain;
  if (process.platform !== 'darwin') return (keychain = false);
  const home = os.homedir();
  if (fs.existsSync(path.join(home, '.claude', '.credentials.json'))) return (keychain = false);
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8')) as {
      oauthAccount?: { emailAddress?: string };
    };
    return (keychain = Boolean(cfg.oauthAccount?.emailAddress));
  } catch {
    return (keychain = false); // no config yet — nothing signed in, nothing to misread
  }
}

/**
 * Everything this extension keeps on disk lives under this one dir: per-window
 * working dirs, the shared history, the account stores it creates, the shell
 * helpers and the uninstall manifest. One root, named after the extension, so
 * nothing collides with another tool's `~/.claude-*` dirs — including the
 * extension this one was forked from, whose discovery adopts any `~/.claude-*`
 * holding a sign-in and whose uninstall would then delete it.
 */
export function dataRoot(): string {
  return path.join(os.homedir(), '.claude-alts');
}

/**
 * Records the extensions dir this copy runs from in `<dataRoot>/.installs.json`.
 * Editors share this home, so the uninstall hook reads the list to tell whether
 * a copy in another editor (Insiders, Cursor, a remote server…) still uses the
 * data. Best-effort: uninstall also checks the editors it knows by name.
 */
export function recordInstall(extensionPath: string): void {
  const file = path.join(dataRoot(), '.installs.json');
  const dir = path.dirname(extensionPath);
  try {
    let list: string[] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (Array.isArray(raw)) list = raw.filter((d): d is string => typeof d === 'string');
    } catch {
      /* first record */
    }
    // Windows paths come back with either drive-letter case (D:\ or d:\).
    const key = (p: string) => (process.platform === 'win32' ? path.normalize(p).toLowerCase() : path.normalize(p));
    if (list.some((d) => key(d) === key(dir))) return;
    fs.mkdirSync(dataRoot(), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...list, dir], null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    /* best-effort */
  }
}

/** Account stores this extension creates (`<dataRoot>/accounts/<name>`). */
export function accountsRoot(): string {
  return path.join(dataRoot(), 'accounts');
}

/**
 * The extension this one was forked from, Claude Parallel Accounts. Both point
 * Claude Code's own `~/.claude` history at their store, so they can't run side
 * by side (see extension.activate); and its uninstall deletes the stores it
 * listed, so accounts are imported from it rather than adopted (see accounts.ts).
 */
export const ORIGINAL = {
  id: 'dercasdrol.claude-parallel-accounts',
  /** Its shared history store. */
  store: () => path.join(os.homedir(), '.claude-shared'),
  /** Its list of the `~/.claude-<name>` stores it manages — and deletes on uninstall. */
  manifest: () => path.join(os.homedir(), '.claude-windows', '.manifest.json'),
  /** Marker file in a store it created. */
  marker: '.claude-parallel-accounts',
};

/**
 * Extensions dirs of the editors (and remote servers) that may share this home.
 * Kept in sync with KNOWN_EXTENSION_DIRS in uninstall.js.
 */
const KNOWN_EXTENSION_DIRS = [
  '.vscode',
  '.vscode-insiders',
  '.vscode-oss',
  '.cursor',
  '.windsurf',
  '.vscode-server',
  '.vscode-server-insiders',
  '.cursor-server',
  '.windsurf-server',
].map((d) => path.join(d, 'extensions'));

/** True if an extension with this id is installed (not pending removal) in any known editor here. */
export function installedInAnyEditor(id: string): boolean {
  const prefix = `${id.toLowerCase()}-`;
  return KNOWN_EXTENSION_DIRS.some((rel) => {
    const dir = path.join(os.homedir(), rel);
    try {
      let obsolete: Record<string, unknown> = {};
      try {
        obsolete = JSON.parse(fs.readFileSync(path.join(dir, '.obsolete'), 'utf-8')) ?? {};
      } catch {
        /* nothing pending removal */
      }
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .some((e) => e.isDirectory() && e.name.toLowerCase().startsWith(prefix) && !obsolete[e.name]);
    } catch {
      return false; // that editor isn't here
    }
  });
}

/**
 * Names of `~/.claude-*` dirs that hold other things, not an account: ours, and
 * those of the extension this one was forked from. Adopting one would invent a
 * phantom account.
 */
export const NOT_A_STORE = new Set(['.claude-alts', '.claude-windows', '.claude-shared', '.claude-vault']);

/**
 * True if `dir` is Claude Code's default `~/.claude` (trailing slash or not) —
 * the one dir Claude Code runs with CLAUDE_CONFIG_DIR unset.
 */
export function isDefaultConfigDir(dir: string): boolean {
  const strip = (p: string) => path.normalize(p).replace(/[\\/]+$/, '');
  return strip(dir) === strip(path.join(os.homedir(), '.claude'));
}

/**
 * Tells Claude Code which dir's credential slot to use, independently of
 * CLAUDE_CONFIG_DIR. This extension never sets it: inherited, it would pin
 * every window to one token whatever account the window runs, so it is stripped
 * wherever it could leak in (see extension.activate, binding.clearMachineOverride).
 */
export const SECURE_ENV_VAR = 'CLAUDE_SECURESTORAGE_CONFIG_DIR';
