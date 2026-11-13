import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { log } from './log';
import { readIdentity } from './accounts';
import { accountsRoot, NOT_A_STORE } from './platform';
import { deleteToken, tokenState } from './credentials';

/**
 * Reclaiming sensitive data from a forgotten account.
 *
 * An account directory holds exactly ONE credential: its OAuth access + refresh
 * token — `<dir>/.credentials.json`, or on macOS the Keychain item named after
 * the dir (see credentials.ts). Everything else in the dir is either
 * identity/config (`.claude.json` — email/org, no token), rotating backups of
 * that config, or symlinks into the shared-history store. So "reclaim the
 * sensitive data" reduces to deleting that one token — which is exactly what
 * Claude Code's own `/logout` does (verified in its bundle: the credential
 * store's `delete()` unlinks the file, or deletes the Keychain item).
 *
 * A forceful forget deletes that token unconditionally, then interrupts any
 * live `claude` session still pointing at the dir so nothing keeps running on a
 * credential that no longer exists.
 */

/**
 * Account state Claude Code's own `/logout` clears out of `.claude.json`,
 * alongside deleting the token. Deleting the token but LEAVING these behind
 * produces a half-signed-out dir that Claude Code never creates itself: it
 * still finds `oauthAccount`, believes it is signed in, renders "signed in" —
 * and never starts the OAuth flow, so login hangs. Mirroring the real logout
 * is what keeps the dir in a state Claude Code understands.
 *
 * Taken from the logout routine in Claude Code's bundle. `hasCompletedOnboarding`
 * / `seenNotifications` are deliberately NOT reset (the real logout does reset
 * them): they are onboarding UI state, not auth, and clearing them on the shared
 * default dir would throw every window back into the onboarding wizard.
 */
const CLEARED_ON_LOGOUT = [
  'oauthAccount',
  'additionalModelOptionsCache',
  'additionalModelCostsCache',
  'modelAccessCache',
  'orgModelDefaultCache',
  'lastSeenOrgDefaultUpdatedAt',
  'clientDataCache',
  'clientDataCacheSlots',
  'autoCompactWindowsCache',
] as const;

/**
 * The config file(s) holding a dir's account state. Named dirs keep it in
 * `<dir>/.claude.json`; the default `~/.claude` keeps its identity in the
 * home-root `~/.claude.json` instead — both must be cleared.
 */
function configFilesFor(dir: string): string[] {
  const files = [path.join(dir, '.claude.json')];
  if (path.normalize(dir) === path.normalize(path.join(os.homedir(), '.claude'))) {
    files.push(path.join(os.homedir(), '.claude.json'));
  }
  return files.filter((f) => fs.existsSync(f));
}

/**
 * What signOut() did: `removed` a token, found `none` to remove, or `failed` to
 * delete the one that is there — in which case NOTHING was changed.
 */
export type SignOutResult = 'removed' | 'none' | 'failed';

/**
 * Signs an account dir out the way Claude Code's `/logout` does: deletes the
 * OAuth token AND clears the account identity + its derived caches from the
 * config. Settings, backups and (shared) history are untouched — the dir stays,
 * it just no longer holds an account.
 *
 * Fails CLOSED: if the token can't be deleted, the identity stays too. Clearing
 * it anyway produced a dir that looked signed out — to us and to the user — while
 * still holding a live credential.
 */
export function signOut(dir: string): SignOutResult {
  const result = deleteToken(dir);
  if (result === 'failed') {
    log(`signOut: could not delete the token of ${dir}`);
    return 'failed';
  }

  for (const cfg of configFilesFor(dir)) {
    try {
      const obj = JSON.parse(fs.readFileSync(cfg, 'utf-8')) as Record<string, unknown>;
      let touched = false;
      for (const key of CLEARED_ON_LOGOUT) {
        if (key in obj) {
          delete obj[key];
          touched = true;
        }
      }
      if (obj.hasAvailableSubscription !== undefined) {
        obj.hasAvailableSubscription = false;
        touched = true;
      }
      if (obj.subscriptionNoticeCount !== undefined) {
        obj.subscriptionNoticeCount = 0;
        touched = true;
      }
      if (!touched) continue;
      const tmp = `${cfg}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, cfg); // atomic: never leave a half-written config
      log(`signOut: cleared account state in ${cfg}`);
    } catch (err) {
      log(`signOut: could not clear ${cfg}: ${(err as Error).message}`);
    }
  }
  return result;
}

/**
 * Live `claude` processes grouped by the CLAUDE_CONFIG_DIR they run against —
 * read from /proc on Linux/WSL, from `ps` on macOS. A process with no
 * CLAUDE_CONFIG_DIR uses the default `~/.claude`. Returns an EMPTY map where
 * neither works — including native Windows, which offers no supported way to
 * read another process's environment. Keys are normalized for direct comparison.
 */
export function canListSessions(): boolean {
  return process.platform !== 'win32';
}

export function claudeSessionsByDir(): Map<string, number[]> {
  const byDir = new Map<string, number[]>();
  if (!canListSessions()) return byDir;
  const defaultDir = path.normalize(path.join(os.homedir(), '.claude'));
  const sessions = process.platform === 'darwin' ? claudeSessionsFromPs() : claudeSessionsFromProc();
  for (const { pid, configDir } of sessions) {
    const dir = configDir ? path.normalize(configDir) : defaultDir;
    const list = byDir.get(dir) ?? [];
    list.push(pid);
    byDir.set(dir, list);
  }
  return byDir;
}

interface ClaudeSession {
  pid: number;
  configDir?: string;
}

const CONFIG_DIR_PREFIX = 'CLAUDE_CONFIG_DIR=';

function claudeSessionsFromProc(): ClaudeSession[] {
  let pids: string[];
  try {
    pids = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p));
  } catch {
    return []; // no /proc on this platform
  }
  const sessions: ClaudeSession[] = [];
  for (const pid of pids) {
    let comm: string;
    try {
      comm = fs.readFileSync(path.join('/proc', pid, 'comm'), 'utf-8').trim();
    } catch {
      continue; // process gone or not ours
    }
    if (comm !== 'claude') continue;
    let environ: string;
    try {
      environ = fs.readFileSync(path.join('/proc', pid, 'environ'), 'utf-8');
    } catch {
      continue;
    }
    const entry = environ.split('\0').find((e) => e.startsWith(CONFIG_DIR_PREFIX));
    sessions.push({ pid: Number(pid), configDir: entry?.slice(CONFIG_DIR_PREFIX.length) });
  }
  return sessions;
}

/**
 * macOS has no /proc. `ps -o comm=` gives each process's executable path (the
 * Claude Code extension's native binary ends in `/claude`), and `ps -E` appends
 * a process's environment to its command line — readable for the user's own
 * processes, which is all a forget may signal anyway.
 *
 * The environment comes back space-joined, so a CLAUDE_CONFIG_DIR containing a
 * space is cut short there; ours live under the home dir and have none.
 */
/**
 * macOS reports the resolved executable: `…/claude` for the binary bundled with
 * the Claude Code extension, but `~/.local/share/claude/versions/<version>` for
 * the native CLI install, which `claude` on PATH only symlinks to.
 */
export function isClaudeExecutable(exe: string): boolean {
  return path.basename(exe) === 'claude' || /[\\/]claude[\\/]versions[\\/][^\\/]+$/.test(exe);
}

function claudeSessionsFromPs(): ClaudeSession[] {
  const ps = (args: string[]): string =>
    execFileSync('ps', args, { encoding: 'utf-8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  let pids: number[];
  try {
    pids = ps(['-A', '-o', 'pid=,comm='])
      .split('\n')
      .map((line) => /^\s*(\d+)\s+(.+)$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null && isClaudeExecutable(m[2].trim()))
      .map((m) => Number(m[1]));
  } catch {
    return []; // ps unavailable — same as no /proc: nothing to signal
  }
  const sessions: ClaudeSession[] = [];
  for (const pid of pids) {
    let line: string;
    try {
      line = ps(['-E', '-ww', '-o', 'command=', '-p', String(pid)]);
    } catch {
      continue; // process gone or not ours
    }
    // The environment follows the arguments, so the LAST match is the env var.
    const matches = [...line.matchAll(/(?:^|\s)CLAUDE_CONFIG_DIR=(\S+)/g)];
    sessions.push({ pid, configDir: matches[matches.length - 1]?.[1] });
  }
  return sessions;
}

/**
 * Interrupts every live `claude` session running against any of the given dirs,
 * so a forceful forget leaves no process alive on a just-deleted token. Uses
 * SIGKILL on purpose: on a graceful SIGTERM shutdown Claude Code flushes its
 * in-memory token back to its store, which would resurrect the very token
 * we're about to delete. Callers MUST call this BEFORE signOut.
 * Returns the number of processes signalled. No-op where sessions can't be listed.
 */
export function interruptSessions(dirs: string[]): number {
  const targets = new Set(dirs.map((d) => path.normalize(d)));
  const byDir = claudeSessionsByDir();
  let killed = 0;
  for (const [dir, pids] of byDir) {
    if (!targets.has(dir)) continue;
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
        killed++;
        log(`interrupted claude pid=${pid} on ${dir}`);
      } catch (err) {
        log(`could not signal pid=${pid}: ${(err as Error).message}`);
      }
    }
  }
  return killed;
}

/**
 * Every on-disk Claude data dir currently holding this account's token — the
 * default `~/.claude` (its identity lives in `~/.claude.json`) AND every named
 * `~/.claude-*` and saved-account copy. Capturing an account snapshots its token into a named
 * dir but leaves the original in the source (often the default) dir, so the
 * SAME token can sit in several places. To truly sign an account out, forget
 * must clear the token from ALL of them, not just the registry copy.
 */
export function dirsHoldingToken(email: string): string[] {
  const home = os.homedir();
  const candidates = [path.join(home, '.claude')];
  for (const root of [home, accountsRoot()]) {
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        if (root === home && (!/^\.claude[-_]/.test(e.name) || NOT_A_STORE.has(e.name))) continue;
        candidates.push(path.join(root, e.name));
      }
    } catch {
      /* not there or unreadable — fall back to whatever we have */
    }
  }
  // A token the Keychain couldn't confirm is kept as a candidate: deleting it is
  // harmless if it isn't there, and skipping it would leave the account signed in.
  return candidates.filter((d) => readIdentity(d)?.email === email && tokenState(d) !== 'absent');
}
