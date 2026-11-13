import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { accountsRoot, dataRoot, NOT_A_STORE, ORIGINAL } from './platform';
import { log } from './log';
import { deleteToken as deleteTokenOf, readToken, tokenModifiedAt, tokenState, writeToken } from './credentials';

/**
 * An account = a Claude Code data directory (CLAUDE_CONFIG_DIR) that has been
 * logged in. Everything Claude Code needs lives inside it:
 *   <dir>/.claude.json        → config + oauthAccount identity
 *   <dir>/.credentials.json   → OAuth tokens (on macOS: a Keychain item named
 *                               after the dir — see credentials.ts)
 *
 * We NEVER touch ~/.claude.json (the global default) — isolation is achieved
 * purely by pointing each window's process.env.CLAUDE_CONFIG_DIR at a dir.
 */
export interface Account {
  /** Short, user-facing name (e.g. "work", "personal"). */
  name: string;
  /** Absolute CLAUDE_CONFIG_DIR path. */
  dir: string;
  /** Last known account email (cached for display; source of truth is the CLI). */
  email?: string;
  /**
   * Whether this extension made the store (`created`, under accountsRoot()) or
   * found it on disk (`adopted` — e.g. a `CLAUDE_CONFIG_DIR=~/.claude-work` the
   * user set up themselves). Uninstall deletes created stores only.
   */
  origin: 'created' | 'adopted';
}

/**
 * Marker file inside a store this extension created. globalState is per window,
 * so the marker is what lets every window — and the uninstall hook, which has no
 * globalState at all — agree on which stores are ours to delete.
 */
export const CREATED_MARKER = '.claude-alts';

/** Marks `dir` as a store this extension created. Best-effort. */
export function markCreated(dir: string): void {
  try {
    fs.writeFileSync(path.join(dir, CREATED_MARKER), 'created by Claude Alts\n', {
      mode: 0o600,
    });
  } catch {
    /* best-effort: an unmarked store is kept on uninstall, never wrongly deleted */
  }
}

/** A store we made: it sits in our accounts root AND carries our marker. */
function isCreatedStore(dir: string): boolean {
  return (
    path.normalize(path.dirname(dir)) === path.normalize(accountsRoot()) &&
    fs.existsSync(path.join(dir, CREATED_MARKER))
  );
}

/** `~/.claude-<name>` dirs the original extension manages, and deletes on its uninstall. */
function originalStores(): Set<string> {
  const dirs = new Set<string>();
  try {
    const listed = (JSON.parse(fs.readFileSync(ORIGINAL.manifest(), 'utf-8')) as { stores?: unknown }).stores;
    if (Array.isArray(listed)) for (const d of listed) if (typeof d === 'string') dirs.add(path.normalize(d));
  } catch {
    /* not installed, or never was */
  }
  return dirs;
}

/**
 * The dir holding the freshest copy of an account's token the original holds:
 * its working dirs (`~/.claude-windows/<id>`) carry the token Claude Code last
 * refreshed, its store only the one from when it was saved — or last synced back.
 */
function freshestOriginalToken(store: string, email: string): string {
  let best = store;
  let bestTime = tokenModifiedAt(store) ?? -1;
  const root = path.dirname(ORIGINAL.manifest());
  let dirs: string[] = [];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => path.join(root, e.name));
  } catch {
    /* no working dirs */
  }
  for (const dir of dirs) {
    // Identity first: it's a file read, where asking for the token may cost a process.
    if (readIdentityFile(path.join(dir, '.claude.json'))?.email !== email) continue;
    const t = tokenModifiedAt(dir);
    if (t !== undefined && t > bestTime) {
      best = dir;
      bestTime = t;
    }
  }
  return best;
}

/**
 * Copies a store's sign-in (token and config) into a new store of ours. A copy
 * of a token authenticates independently, so both keep working. Best-effort:
 * a half-made store is removed.
 */
function importStore(from: string, to: string, email: string): boolean {
  try {
    const token = readToken(freshestOriginalToken(from, email)) ?? readToken(from);
    if (!token) throw new Error('its sign-in could not be read');
    fs.mkdirSync(to, { recursive: true, mode: 0o700 });
    if (!writeToken(to, token)) throw new Error('the sign-in could not be written');
    const tmp = path.join(to, `.claude.json.${process.pid}.tmp`);
    fs.copyFileSync(path.join(from, '.claude.json'), tmp);
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, path.join(to, '.claude.json'));
    markCreated(to);
    return true;
  } catch (err) {
    log(`could not import ${from}: ${(err as Error).message}`);
    try {
      // The token may be a Keychain item, which removing the dir would orphan.
      deleteTokenOf(to);
      fs.rmSync(to, { recursive: true, force: true });
    } catch {
      /* a later import retries into what's left only if it's gone; it's not */
    }
    return false;
  }
}

/** True if `dir` is one of the original extension's `~/.claude-<name>` stores. */
function isOriginalStore(dir: string, listed: Set<string>): boolean {
  return listed.has(path.normalize(dir)) || fs.existsSync(path.join(dir, ORIGINAL.marker));
}

/**
 * Copies the accounts Claude Parallel Accounts manages into our accounts root.
 * Its uninstall deletes them, so they are never adopted in place; and since that
 * uninstall can run before this extension ever leaves its inert mode (it runs at
 * the next editor start, not at a reload), this also runs while the original is
 * still installed: it only reads the original's stores and writes into ours.
 */
export function importFromOriginal(): void {
  const home = os.homedir();
  const listed = originalStores();
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const m = /^\.claude[-_](.+)$/.exec(e.name);
    if (!m || !e.isDirectory() || NOT_A_STORE.has(e.name)) continue;
    const dir = path.join(home, e.name);
    if (!isOriginalStore(dir, listed)) continue;
    const email = readIdentityFile(path.join(dir, '.claude.json'))?.email;
    // No identity, no account to carry over (and nothing to pair a token with).
    if (!email) continue;
    const target = path.join(accountsRoot(), m[1]);
    if (fs.existsSync(target)) continue; // imported before
    if (!hasCredentials(dir)) continue;
    if (importStore(dir, target, email)) log(`imported ${dir} from Claude Parallel Accounts as ${target}`);
  }
}

/** Identity read live from <dir>/.claude.json. */
export interface AccountIdentity {
  email: string;
  displayName: string;
  organizationName?: string;
}

const REGISTRY_KEY = 'claudeAlts.accounts';
/**
 * Accounts the user explicitly forgot. Their dirs stay on disk untouched (this
 * extension performs no destructive operations), so discovery must remember
 * NOT to re-add them — and a later save of the same email restores the entry
 * instead of snapshotting a duplicate of the same OAuth token.
 */
const FORGOTTEN_KEY = 'claudeAlts.forgottenAccounts';

/** Parses oauthAccount identity out of a single .claude.json file. */
function readIdentityFile(file: string): AccountIdentity | null {
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      oauthAccount?: {
        emailAddress?: string;
        displayName?: string;
        organizationName?: string;
      };
    };
    const o = raw.oauthAccount;
    if (!o?.emailAddress) return null;
    return {
      email: o.emailAddress,
      displayName: o.displayName ?? o.emailAddress,
      organizationName: o.organizationName,
    };
  } catch {
    return null;
  }
}

/**
 * Reads oauthAccount identity for a config dir. Named accounts keep it in
 * <dir>/.claude.json. The default ~/.claude is special: its config dir's
 * .claude.json has no oauthAccount — that identity lives in ~/.claude.json at
 * the home root — so we fall back to it. Without this fallback an unbound
 * window has no identity to paint and the status bar hangs on its spinner.
 */
export function readIdentity(dir: string): AccountIdentity | null {
  const own = readIdentityFile(path.join(dir, '.claude.json'));
  if (own) return own;
  if (path.normalize(dir) === path.normalize(path.join(os.homedir(), '.claude'))) {
    return readIdentityFile(path.join(os.homedir(), '.claude.json'));
  }
  return null;
}

/** True if the dir is known to hold a token: a logged-in Claude Code config dir. */
export function hasCredentials(dir: string): boolean {
  return tokenState(dir) === 'present';
}

/**
 * True if the dir is known to hold NO token. Not the same as !hasCredentials:
 * a Keychain that can't be asked is neither, and anything that drops an account
 * or signs a window out must wait for a real answer.
 */
export function lacksCredentials(dir: string): boolean {
  return tokenState(dir) === 'absent';
}

/** Claude Code's own default dir — never ours to create or delete. */
function isDefaultStore(dir: string): boolean {
  return path.normalize(dir) === path.normalize(path.join(os.homedir(), '.claude'));
}

/** Expands a leading ~ to the home directory. */
export function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Mirror of the registry's directories, on disk.
 *
 * The uninstall hook runs as a bare `node` script with no vscode API, so
 * globalState — where the registry actually lives — is unreadable to it. Without
 * this list it could only guess which `~/.claude-*` dirs are ours, and the one
 * thing it must never do is delete a directory a user made for themselves. So
 * the registry writes down exactly what it manages, and uninstall deletes
 * nothing else.
 */
function manifestPath(): string {
  return path.join(dataRoot(), '.manifest.json');
}

/**
 * The account registry is stored in globalState so every window (and every
 * VSCode profile) on this machine sees the same set of accounts.
 */
export class AccountRegistry {
  /** Fires after the list of accounts (or forgotten ones) was written. */
  readonly onDidChange = new vscode.EventEmitter<void>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): Account[] {
    return this.context.globalState.get<Account[]>(REGISTRY_KEY, []);
  }

  /**
   * Records the dirs this extension manages, for the uninstall hook to clean up.
   * Forgotten accounts are included: their dirs are ours too and stay on disk.
   * Best-effort — a missing manifest only means uninstall leaves the stores be.
   */
  writeManifest(): void {
    try {
      const all = [...this.list(), ...this.listForgotten()];
      const dirs = (origin: Account['origin']) => [
        ...new Set(all.filter((a) => a.origin === origin).map((a) => path.normalize(a.dir))),
      ];
      const file = manifestPath();
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      // `stores` is what uninstall deletes: created stores only.
      fs.writeFileSync(
        file,
        JSON.stringify({ stores: dirs('created'), adopted: dirs('adopted') }, null, 2),
        { mode: 0o600 }
      );
    } catch {
      /* best-effort */
    }
    this.onDidChange.fire();
  }

  get(name: string): Account | undefined {
    return this.list().find((a) => a.name === name);
  }

  getByDir(dir: string): Account | undefined {
    const norm = path.normalize(dir);
    return this.list().find((a) => path.normalize(a.dir) === norm);
  }

  /** The email an account resolves to (cached, else read live from its dir). */
  emailOf(a: Account): string | undefined {
    return a.email ?? readIdentity(a.dir)?.email;
  }

  /** A saved account whose identity matches this email, if any. */
  savedForEmail(email: string): Account | undefined {
    return this.list().find((a) => this.emailOf(a) === email);
  }

  /**
   * The accounts collapsed to one per email — the old paradigm could snapshot
   * the same account into several dirs, so the raw list may hold duplicates.
   * The canonical copy (name equal to the email's local-part slug) wins; entries
   * with no resolvable email can't be deduped and are kept as-is.
   */
  listUniqueByEmail(): Account[] {
    const slug = (email: string) =>
      (email.split('@')[0] || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
    const chosen = new Map<string, Account>();
    const noEmail: Account[] = [];
    for (const a of this.list()) {
      const email = this.emailOf(a);
      if (!email) {
        noEmail.push(a);
        continue;
      }
      const current = chosen.get(email);
      if (!current || (a.name === slug(email) && current.name !== slug(email))) {
        chosen.set(email, a);
      }
    }
    return [...chosen.values(), ...noEmail].sort((a, b) => a.name.localeCompare(b.name));
  }

  async add(account: Account): Promise<void> {
    if (account.origin === 'created' && !isDefaultStore(account.dir)) markCreated(account.dir);
    const list = this.list().filter((a) => a.name !== account.name);
    list.push(account);
    list.sort((a, b) => a.name.localeCompare(b.name));
    await this.context.globalState.update(REGISTRY_KEY, list);
    this.writeManifest();
  }

  async remove(name: string): Promise<void> {
    const list = this.list().filter((a) => a.name !== name);
    await this.context.globalState.update(REGISTRY_KEY, list);
    this.writeManifest();
  }

  /**
   * Drops entries whose store has been signed out — the account no longer exists.
   *
   * This is what makes the account list agree across windows. `globalState` does
   * NOT propagate between them: each extension host holds its own copy, so an
   * account saved (or forgotten) in one window is invisible to the others until
   * they restart. The DISK is the only shared truth — an account IS its store —
   * so pairing this with discoverAndMerge() lets every window converge on it:
   * new accounts appear, and signed-out ones disappear.
   */
  async pruneSignedOut(): Promise<Account[]> {
    const gone = this.list().filter((a) => lacksCredentials(a.dir));
    for (const a of gone) await this.remove(a.name);
    return gone;
  }

  listForgotten(): Account[] {
    return this.context.globalState.get<Account[]>(FORGOTTEN_KEY, []);
  }


  /** Moves an account from the registry to the forgotten list. Dir stays on disk. */
  async forget(account: Account): Promise<void> {
    await this.remove(account.name);
    const norm = path.normalize(account.dir);
    const rest = this.listForgotten().filter((a) => path.normalize(a.dir) !== norm);
    rest.push(account);
    await this.context.globalState.update(FORGOTTEN_KEY, rest);
    this.writeManifest();
  }

  /** Restores a previously forgotten account matching this email, if any. */
  async restoreForgotten(email: string): Promise<Account | undefined> {
    const list = this.listForgotten();
    const found = list.find((a) => (a.email ?? readIdentity(a.dir)?.email) === email);
    if (!found) return undefined;
    await this.context.globalState.update(
      FORGOTTEN_KEY,
      list.filter((a) => a !== found)
    );
    found.email = email;
    await this.add(found);
    return found;
  }

  /**
   * Discovers logged-in config dirs on disk and merges any that aren't in the
   * registry yet: the stores this extension created (accountsRoot()), and
   * `~/.claude-<name>` dirs the user made, which are adopted. Non-destructive.
   */
  async discoverAndMerge(): Promise<Account[]> {
    const home = os.homedir();
    importFromOriginal();
    const adoptable: { name: string; dir: string }[] = [];
    const fromOriginal = originalStores();
    try {
      for (const e of fs.readdirSync(home, { withFileTypes: true })) {
        // Only explicit .claude-<name> dirs. The bare ~/.claude default is
        // skipped: its identity lives in ~/.claude.json (home), not in the dir,
        // so it isn't a self-contained account.
        const m = /^\.claude[-_](.+)$/.exec(e.name);
        if (!m || !e.isDirectory() || NOT_A_STORE.has(e.name)) continue;
        const dir = path.join(home, e.name);
        // The original's: imported above as a copy, never adopted in place.
        if (isOriginalStore(dir, fromOriginal)) continue;
        adoptable.push({ name: m[1], dir });
      }
    } catch {
      return this.list();
    }
    const candidates: { name: string; dir: string }[] = [];
    try {
      for (const e of fs.readdirSync(accountsRoot(), { withFileTypes: true })) {
        if (e.isDirectory()) candidates.push({ name: e.name, dir: path.join(accountsRoot(), e.name) });
      }
    } catch {
      /* nothing created yet */
    }
    candidates.push(...adoptable);
    const forgotten = new Set(this.listForgotten().map((a) => path.normalize(a.dir)));
    const found: Account[] = [];
    for (const { name, dir } of candidates) {
      // Explicitly forgotten dirs stay on disk — do not resurrect them.
      if (forgotten.has(path.normalize(dir))) continue;
      if (this.getByDir(dir)) continue;
      // Checked last: on macOS it costs a process, and the rest skip most dirs.
      if (!hasCredentials(dir)) continue;
      // Another window may have created it (globalState doesn't cross windows);
      // its marker says so. Anything else was made by someone else.
      found.push({ name, dir, origin: isCreatedStore(dir) ? 'created' : 'adopted' });
    }
    for (const acc of found) {
      // Avoid name collisions with existing registry entries.
      if (this.get(acc.name)) continue;
      await this.add(acc);
    }
    // Runs on every activation, so the manifest exists even if nothing was
    // discovered — without one uninstall conservatively leaves every store behind.
    this.writeManifest();
    return this.list();
  }
}
