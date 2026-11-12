import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { log } from './log';
import { readIdentity } from './accounts';
import { SECURE_ENV_VAR, isDefaultConfigDir } from './platform';

/**
 * Thin wrapper around the `claude` CLI's auth commands, scoped to a specific
 * CLAUDE_CONFIG_DIR. This is the AUTHORITATIVE source of an account's identity:
 * `claude auth status` reflects the real OAuth token, so it can never disagree
 * with what Claude Code actually bills to (unlike reading .claude.json, whose
 * oauthAccount field can drift out of sync with the token).
 */

export interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
}

/** A failed CLI run, keeping whatever the command printed before exiting. */
class CliError extends Error {
  constructor(message: string, readonly stdout = '') {
    super(message);
  }
  /** The command ran and printed a verdict — an answer, even with a non-zero exit. */
  get answered(): boolean {
    return this.stdout.trim().startsWith('{');
  }
}

/**
 * The `claude` binary bundled with the Claude Code extension, if installed. It
 * is exactly what the panel runs, and it needs no PATH: a VSCode launched from
 * the Dock or a desktop menu never sources the shell profile that puts `claude`
 * on it.
 */
function bundledClaude(): string | undefined {
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  if (!ext) return undefined;
  const bin = path.join(
    ext.extensionPath,
    'resources',
    'native-binary',
    process.platform === 'win32' ? 'claude.exe' : 'claude'
  );
  return fs.existsSync(bin) ? bin : undefined;
}

/** Single-quotes a word for a POSIX shell (and fish, which reads it the same). */
function shq(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

interface Attempt {
  label: string;
  file: string;
  args: string[];
}

/**
 * Runs a claude CLI command against one config dir.
 *
 * The env is built the way Claude Code itself runs that dir: the default
 * `~/.claude` with CLAUDE_CONFIG_DIR UNSET — setting it to `~/.claude` is not
 * the same thing, it moves the identity into the dir — and any other dir with
 * it set. CLAUDE_SECURESTORAGE_CONFIG_DIR is always unset: it would pick the
 * credentials independently of the dir being asked about.
 *
 * Two ways to reach the binary, sharing one time budget: the one bundled with
 * Claude Code, and `claude` through a login shell so nvm/PATH resolve. In the
 * shell the variables are applied by `env` AFTER the profile ran, so a profile
 * exporting its own CLAUDE_CONFIG_DIR can't make the CLI answer for another dir.
 * On macOS the bundled binary goes first (a GUI-launched VSCode rarely has the
 * user's PATH); elsewhere the user's own `claude` does.
 */
async function runClaude(args: string[], dir: string, timeoutMs: number): Promise<string> {
  const vars: Record<string, string> = {};
  if (!isDefaultConfigDir(dir)) vars.CLAUDE_CONFIG_DIR = dir;

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR;
  delete env[SECURE_ENV_VAR];
  Object.assign(env, vars);

  const attempts: Attempt[] = [];
  const bundled = bundledClaude();
  if (bundled) attempts.push({ label: 'bundled', file: bundled, args });
  if (process.platform !== 'win32') {
    const shell = process.env.SHELL || '/bin/bash';
    const assign = Object.entries(vars).map(([k, v]) => `${k}=${shq(v)}`);
    const line = ['exec env -u CLAUDE_CONFIG_DIR', `-u ${SECURE_ENV_VAR}`, ...assign, 'claude', ...args.map(shq)];
    const viaShell: Attempt = { label: 'login shell', file: shell, args: ['-lc', line.join(' ')] };
    if (process.platform === 'darwin') attempts.push(viaShell);
    else attempts.unshift(viaShell);
  } else {
    // npm installs a claude.cmd shim, which only a shell can run.
    attempts.push({ label: 'cmd', file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'claude', ...args] });
  }

  const deadline = Date.now() + timeoutMs;
  let last: Error = new CliError('no way to run the claude CLI was found');
  for (const attempt of attempts) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    try {
      return await execOnce(attempt, env, left);
    } catch (err) {
      // A printed verdict is an answer, not a failure to ask — don't ask again.
      if (err instanceof CliError && err.answered) throw err;
      last = err as Error;
      log(`claude ${args.join(' ')} via ${attempt.label} failed: ${last.message.split('\n')[0]}`);
    }
  }
  throw last;
}

function execOnce(attempt: Attempt, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // execFile's own `timeout` sends SIGTERM, which a login shell can trap and
    // ignore — leaving the callback pending forever. Escalate to SIGKILL and
    // back it with our own hard timer so this promise ALWAYS settles.
    const child = execFile(
      attempt.file,
      attempt.args,
      { env, timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true },
      (err, stdout, stderr) => {
        clearTimeout(hardTimer);
        if (err) reject(new CliError(stderr?.toString() || err.message, stdout?.toString()));
        else resolve(stdout.toString());
      }
    );
    const hardTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      reject(new CliError(`timed out after ${timeoutMs}ms`));
    }, timeoutMs + 1000);
    if (typeof hardTimer.unref === 'function') hardTimer.unref();
  });
}

/**
 * Returns the authenticated account for a config dir, or null if the CLI call
 * fails or the dir isn't logged in. Never throws.
 */
export async function getAuthStatus(
  dir: string,
  timeoutMs = 15000
): Promise<AuthStatus | null> {
  let out: string;
  try {
    out = await runClaude(['auth', 'status', '--json'], dir, timeoutMs);
  } catch (err) {
    // `auth status` exits 1 when signed out — but still prints its verdict. That
    // is an ANSWER ("signed out"), not a failure to ask; discarding it made the
    // status bar treat every signed-out dir as "claude CLI unreachable".
    if (!(err instanceof CliError && err.answered)) {
      log(`auth status(${dir}) FAILED: ${(err as Error).message.split('\n')[0]}`);
      return null;
    }
    out = err.stdout.trim();
  }
  try {
    const parsed = JSON.parse(out) as AuthStatus;
    // Recent Claude Code versions (2.1.x) return `email: null` from
    // `auth status --json` even when logged in via claude.ai. The email still
    // lives in the account's .claude.json (oauthAccount.emailAddress), so fall
    // back to it — otherwise every identity-dependent flow (capture, switch,
    // dedupe-by-email) silently bails out with "no signed-in account".
    if (parsed.loggedIn && !parsed.email) {
      const id = readIdentity(dir);
      if (id?.email) {
        parsed.email = id.email;
        if (!parsed.orgName && id.organizationName) parsed.orgName = id.organizationName;
      }
    }
    log(`auth status(${dir}): loggedIn=${parsed.loggedIn} email=${parsed.email ?? '(none)'}`);
    return parsed;
  } catch (err) {
    log(`auth status(${dir}) FAILED: ${(err as Error).message.split('\n')[0]}`);
    return null;
  }
}
