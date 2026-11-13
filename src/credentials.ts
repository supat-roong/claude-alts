import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';
import { isDefaultConfigDir } from './platform';
import { log } from './log';

/**
 * Where a Claude data dir's OAuth token lives, and the one place that reads,
 * writes and deletes it.
 *
 * Linux and Windows: a file, `<dir>/.credentials.json`.
 *
 * macOS: an item in the login Keychain, named after the dir. Verified against
 * Claude Code's bundle (2.1.323) and the items on a real machine:
 *
 *   service  `Claude Code-credentials` for the default `~/.claude` (Claude Code
 *            run with CLAUDE_CONFIG_DIR unset), and
 *            `Claude Code-credentials-<first 8 hex of sha256(CLAUDE_CONFIG_DIR)>`
 *            for any other dir — the variable's exact string, NFC-normalized;
 *   account  $USER (else the OS user name), or `claude-code-user` if that has
 *            characters outside [a-zA-Z0-9._-];
 *   secret   the same JSON the file would hold.
 *
 * So every per-window working dir gets a Keychain item of its own, just as it
 * gets a file of its own elsewhere, and the isolation between windows carries
 * over unchanged. Claude Code still reads `.credentials.json` when the Keychain
 * has no item for the dir (its plaintext fallback), so that is honoured too.
 *
 * Items are read and written through `/usr/bin/security`, as Claude Code does.
 * That matters beyond consistency: an item's access list names the program that
 * created it, and both sides going through the same binary is what lets each
 * read the other's items without a Keychain prompt.
 *
 * A Keychain that can't be asked (locked, timed out, a dismissed prompt) is an
 * answer of its own — `unknown` — and callers must never read it as "signed
 * out": doing so would prune accounts and sign windows out over a locked screen.
 */

/** The token file inside a dir: the store on Linux and Windows, the fallback on macOS. */
export const TOKEN_FILE = '.credentials.json';

/** What a dir's token is known to be. `unknown` is not `absent`. */
export type TokenState = 'present' | 'absent' | 'unknown';

/** What a delete did: `removed` a token, found `none`, or `failed` (nothing changed). */
export type DeleteResult = 'removed' | 'none' | 'failed';

/**
 * `keychain` on macOS, `file` elsewhere. CLAUDE_ALTS_TOKEN_STORE overrides it —
 * for tests only, so they never touch the real Keychain of the machine they run on.
 */
export function tokenStore(): 'file' | 'keychain' {
  const forced = process.env.CLAUDE_ALTS_TOKEN_STORE;
  if (forced === 'file' || forced === 'keychain') return forced;
  return process.platform === 'darwin' ? 'keychain' : 'file';
}

/** Where a user should look for a token this extension failed to delete. */
export function describeTokenLocation(dir: string): string {
  return tokenStore() === 'keychain'
    ? `the Keychain item "${keychainService(dir)}"`
    : path.join(dir, TOKEN_FILE);
}

export function tokenFile(dir: string): string {
  return path.join(dir, TOKEN_FILE);
}

// ─── Keychain naming ──────────────────────────────────────────────────────────

const SERVICE = 'Claude Code-credentials';

/** The Keychain service Claude Code uses for `dir`'s token (see the header). */
export function keychainService(dir: string): string {
  if (isDefaultConfigDir(dir)) return SERVICE;
  const hash = crypto.createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8);
  return `${SERVICE}-${hash}`;
}

/** The Keychain account Claude Code files its items under. */
export function keychainAccount(): string {
  let user: string;
  try {
    user = process.env.USER || os.userInfo().username;
  } catch {
    user = '';
  }
  return /^[a-zA-Z0-9._-]+$/.test(user) ? user : 'claude-code-user';
}

// ─── Talking to `security` ────────────────────────────────────────────────────

/** `security` exit codes Claude Code tells apart (errSecItemNotFound, errSecInteractionNotAllowed). */
const NOT_FOUND = 44;
const LOCKED = 36;
/** Longest line `security -i` reads from stdin; longer payloads go through argv, as in Claude Code. */
const STDIN_LIMIT = 4032;
const TIMEOUT_MS = 3000;

interface Run {
  /** Exit code, or null when it timed out or couldn't be started. */
  status: number | null;
  stdout: string;
}

function security(args: string[], input?: string): Run {
  // CLAUDE_ALTS_SECURITY_BIN: a stand-in for tests, so the Keychain path is
  // exercised on any OS without touching a real Keychain.
  const bin = process.env.CLAUDE_ALTS_SECURITY_BIN || '/usr/bin/security';
  try {
    const r = spawnSync(bin, args, {
      input,
      encoding: 'utf-8',
      timeout: TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    if (r.error || r.signal) return { status: null, stdout: '' };
    return { status: r.status, stdout: r.stdout ?? '' };
  } catch {
    return { status: null, stdout: '' };
  }
}

/**
 * After the Keychain fails to answer, background checks leave it alone for a
 * while: each attempt can block the window for the full timeout, and a locked
 * Keychain asked every few seconds would freeze it over and over. Reads, writes
 * and deletes — what the user asked for — always try for real.
 */
const COOL_DOWN_MS = 30_000;
let coolDownUntil = 0;

/**
 * Presence answers are cached briefly: the status bar and every reconcile ask,
 * and each answer costs a process. Our own writes and deletes drop the entry,
 * and the account watcher drops them all when the Keychain changes.
 */
const STATE_TTL_MS = 1500;
const stateCache = new Map<string, { state: TokenState; at: number }>();

/** Drops every cached answer, and the cool-down: the Keychain changed, so it answers again. */
export function forgetCachedTokenStates(): void {
  stateCache.clear();
  coolDownUntil = 0;
}

/** The item's attributes (never its secret), or what kept us from them. */
function keychainAttributes(dir: string): { state: TokenState; attrs: string } {
  const r = security(['find-generic-password', '-a', keychainAccount(), '-s', keychainService(dir)]);
  if (r.status === 0) return { state: 'present', attrs: r.stdout };
  if (r.status === NOT_FOUND) return { state: 'absent', attrs: '' };
  return { state: 'unknown', attrs: '' };
}

/** The item's last-modified time, from `security`'s `"mdat"<timedate>=… "YYYYMMDDhhmmssZ…"` line. */
function modifiedAt(attrs: string): number | undefined {
  const m = /"mdat"<timedate>=\S*\s+"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z/.exec(attrs);
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

// ─── The file ─────────────────────────────────────────────────────────────────

function fileExists(dir: string): boolean {
  return fs.existsSync(tokenFile(dir));
}

/** The file's bytes, null if there is none, undefined if it can't be read. */
function readFile(dir: string): Buffer | null | undefined {
  const file = tokenFile(dir);
  if (!fs.existsSync(file)) return null;
  try {
    return fs.readFileSync(file);
  } catch {
    return undefined;
  }
}

function writeFile(dir: string, data: Buffer): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = tokenFile(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file); // atomic: a half-written token is worse than none
}

function deleteFile(dir: string): DeleteResult {
  const file = tokenFile(dir);
  try {
    if (!fs.existsSync(file)) return 'none';
    fs.rmSync(file, { force: true });
    return 'removed';
  } catch (err) {
    log(`credentials: could not delete ${file}: ${(err as Error).message}`);
    return 'failed';
  }
}

// ─── The API ──────────────────────────────────────────────────────────────────

/**
 * Whether `dir` holds a token. On macOS this looks at the item's attributes
 * only: no secret is read, so no Keychain prompt can appear.
 */
export function tokenState(dir: string): TokenState {
  if (tokenStore() === 'file') return fileExists(dir) ? 'present' : 'absent';
  const key = path.normalize(dir);
  const cached = stateCache.get(key);
  if (cached && Date.now() - cached.at < STATE_TTL_MS) return cached.state;
  let state: TokenState;
  if (Date.now() < coolDownUntil) {
    state = 'unknown';
  } else {
    state = keychainAttributes(dir).state;
    if (state === 'unknown') coolDownUntil = Date.now() + COOL_DOWN_MS;
  }
  // No item: Claude Code falls back to the file, and so do we. An unanswered
  // Keychain with a file present still counts as signed in.
  if (state !== 'present' && fileExists(dir)) state = 'present';
  stateCache.set(key, { state, at: Date.now() });
  return state;
}

/**
 * The token's bytes: null if `dir` has none, undefined if it can't be read (a
 * locked Keychain, an unreadable file). Never mistake the second for the first.
 */
export function readToken(dir: string): Buffer | null | undefined {
  if (tokenStore() === 'file') return readFile(dir);
  const r = security(['find-generic-password', '-a', keychainAccount(), '-w', '-s', keychainService(dir)]);
  if (r.status === 0) {
    const text = r.stdout.trim();
    // Claude Code stores JSON. Anything else (an empty item, a hex dump of
    // binary data) is not a token we can hand on, and copying it would plant a
    // broken sign-in somewhere.
    try {
      JSON.parse(text);
      return Buffer.from(text, 'utf-8');
    } catch {
      log(`credentials: ${keychainService(dir)} holds no readable token`);
      return undefined;
    }
  }
  if (r.status === NOT_FOUND) return readFile(dir);
  // The Keychain didn't answer; a fallback file is still a usable token.
  return fileExists(dir) ? readFile(dir) : undefined;
}

/** Stores `data` as `dir`'s token, where Claude Code will look for it. True on success. */
export function writeToken(dir: string, data: Buffer): boolean {
  stateCache.delete(path.normalize(dir));
  if (tokenStore() === 'file') {
    try {
      writeFile(dir, data);
      return true;
    } catch (err) {
      log(`credentials: could not write ${tokenFile(dir)}: ${(err as Error).message}`);
      return false;
    }
  }
  const account = keychainAccount();
  const service = keychainService(dir);
  // Hex over stdin keeps the token out of process listings. `-U` updates the
  // item in place when it already exists.
  const hex = data.toString('hex');
  const line = `add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"\n`;
  const r =
    line.length <= STDIN_LIMIT
      ? security(['-i'], line)
      : security(['add-generic-password', '-U', '-a', account, '-s', service, '-X', hex]);
  if (r.status === 0) {
    // The item now wins over any fallback file; a stale copy of a token left
    // lying next to it is only a credential nobody uses.
    deleteFile(dir);
    return true;
  }
  // No usable Keychain at all (as opposed to a locked one, or a timeout): Claude
  // Code then keeps the token in the file, and so do we — but only when no item
  // exists for the dir, which would shadow the file with an older token.
  if (r.status !== null && r.status !== LOCKED && keychainAttributes(dir).state === 'absent') {
    try {
      writeFile(dir, data);
      log(`credentials: Keychain refused ${service} (exit ${r.status}); wrote ${tokenFile(dir)} instead`);
      return true;
    } catch (err) {
      log(`credentials: could not write ${tokenFile(dir)}: ${(err as Error).message}`);
      return false;
    }
  }
  log(`credentials: could not write ${service} (exit ${r.status ?? 'timeout'})`);
  return false;
}

/**
 * Deletes `dir`'s token from everywhere Claude Code could find it. Fails closed:
 * if the Keychain refuses, the fallback file is left alone too and the result
 * is `failed`, so the caller keeps the dir's identity alongside the live token.
 */
export function deleteToken(dir: string): DeleteResult {
  stateCache.delete(path.normalize(dir));
  if (tokenStore() === 'file') return deleteFile(dir);
  const r = security(['delete-generic-password', '-a', keychainAccount(), '-s', keychainService(dir)]);
  if (r.status !== 0 && r.status !== NOT_FOUND) {
    log(`credentials: could not delete ${keychainService(dir)} (exit ${r.status ?? 'timeout'})`);
    return 'failed';
  }
  const file = deleteFile(dir);
  if (file === 'failed') return 'failed';
  return r.status === 0 || file === 'removed' ? 'removed' : 'none';
}

/**
 * When `dir`'s token last changed (ms), undefined if it has none or can't be
 * asked. Picks the freshest copy of an account; reads attributes only.
 */
export function tokenModifiedAt(dir: string): number | undefined {
  const fileTime = (): number | undefined => {
    try {
      return fs.statSync(tokenFile(dir)).mtimeMs;
    } catch {
      return undefined;
    }
  };
  if (tokenStore() === 'file') return fileTime();
  const { state, attrs } = keychainAttributes(dir);
  // The item, when there is one, is what Claude Code reads — never the file.
  return state === 'present' ? modifiedAt(attrs) ?? fileTime() : fileTime();
}

/**
 * A cheap fingerprint of `dir`'s token that changes when it is written or
 * deleted: `absent`, a modification stamp, or undefined while the Keychain
 * can't be asked. The secret is never read.
 */
export function tokenFingerprint(dir: string): string | undefined {
  if (tokenStore() === 'file') {
    try {
      return `f:${fs.statSync(tokenFile(dir)).mtimeMs}`;
    } catch {
      return 'absent';
    }
  }
  const { state, attrs } = keychainAttributes(dir);
  if (state === 'unknown') return undefined;
  const file = fileExists(dir) ? `+f:${fs.statSync(tokenFile(dir)).mtimeMs}` : '';
  return state === 'present' ? `k:${modifiedAt(attrs) ?? '?'}${file}` : `absent${file}`;
}

/** The file whose modification signals a Keychain change, or undefined off macOS. */
export function keychainDatabase(): string | undefined {
  if (tokenStore() !== 'keychain') return undefined;
  return path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');
}
