import * as fs from 'fs';
import * as path from 'path';
import { dataRoot, isDefaultConfigDir, SECURE_ENV_VAR } from './platform';
import { log } from './log';

/**
 * Accounts in terminals this extension can't reach — a plain shell, iTerm,
 * Windows Terminal, ssh. VSCode's own terminals already follow their window's
 * account; for everything else the extension writes a small script, sourced
 * from the user's shell profile, that knows every saved account:
 *
 *   claude-as <account> [args…]   run claude once as that account
 *   claude-use <account>          point this shell at that account
 *   claude-accounts               list them
 *
 * `<account>` is the email or the saved name. The script runs an account on its
 * STORE — the same thing as `CLAUDE_CONFIG_DIR=<store> claude` by hand — so its
 * conversations land in the shared history like every window's. The script is
 * regenerated whenever the account list changes; this extension never edits the
 * user's profile itself, it only offers the line to add.
 */

export interface ShellAccount {
  name: string;
  email?: string;
  dir: string;
}

export function shellDir(): string {
  return path.join(dataRoot(), 'shell');
}

export function posixScript(): string {
  return path.join(shellDir(), 'claude-accounts.sh');
}

export function powershellScript(): string {
  return path.join(shellDir(), 'claude-accounts.ps1');
}

/** The line to add to a shell profile — guarded, so uninstalling never breaks the shell. */
export function sourceLine(kind: 'posix' | 'powershell'): string {
  if (kind === 'powershell') {
    const file = psq(powershellScript());
    return `if (Test-Path ${file}) { . ${file} }`;
  }
  const file = shq(posixScript());
  return `[ -f ${file} ] && . ${file}`;
}

/** The variables that run `dir` as Claude Code itself would (see cli.runClaude). */
function envFor(dir: string): { set: Record<string, string>; unset: string[] } {
  if (isDefaultConfigDir(dir)) return { set: {}, unset: ['CLAUDE_CONFIG_DIR', SECURE_ENV_VAR] };
  return { set: { CLAUDE_CONFIG_DIR: dir }, unset: [SECURE_ENV_VAR] };
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** PowerShell ends a single-quoted string at any of these quotes; doubling one escapes it. */
const psq = (s: string) => `'${s.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`;

function keysOf(a: ShellAccount): string[] {
  return [...new Set([a.name, ...(a.email ? [a.email] : [])])];
}

function renderPosix(accounts: ShellAccount[]): string {
  const cases = accounts.map((a) => {
    const { set, unset } = envFor(a.dir);
    const body = [
      ...unset.map((v) => `unset ${v}`),
      ...Object.entries(set).map(([k, v]) => `export ${k}=${shq(v)}`),
    ].join('; ');
    return `    ${keysOf(a).map(shq).join('|')}) ${body} ;;`;
  });
  const list = accounts.map((a) => `${a.email ?? a.name}  (${a.name})`);
  return `# Claude Alts — generated, do not edit: rewritten whenever accounts change.
# bash/zsh. Add to your profile:  ${sourceLine('posix')}
claude-use() {
  case "$1" in
${cases.join('\n')}
    *) echo "claude-use: unknown account '$1' — see claude-accounts" >&2; return 1 ;;
  esac
}
claude-as() {
  [ $# -ge 1 ] || { echo "usage: claude-as <account> [claude args…]" >&2; return 2; }
  ( claude-use "$1" || exit 1; shift; exec claude "$@" )
}
claude-accounts() {
  printf '%s\\n' ${list.map(shq).join(' ') || "'(no saved accounts)'"}
}
`;
}

function renderPowerShell(accounts: ShellAccount[]): string {
  const seen = new Set<string>();
  const entries = accounts.flatMap((a) => {
    const { set, unset } = envFor(a.dir);
    const value =
      `@{ Set = @{ ${Object.entries(set).map(([k, v]) => `${k} = ${psq(v)}`).join('; ')} }; ` +
      `Unset = @(${unset.map(psq).join(', ')}) }`;
    return keysOf(a)
      .filter((k) => {
        // Hashtable keys ignore case: a second `Work` next to `work` is a parse error.
        if (seen.has(k.toLowerCase())) return false;
        seen.add(k.toLowerCase());
        return true;
      })
      .map((k) => `  ${psq(k)} = ${value}`);
  });
  const list = accounts.map((a) => psq(`${a.email ?? a.name}  (${a.name})`));
  // The BOM makes Windows PowerShell 5.1 read the file as UTF-8, not the ANSI
  // code page, which would garble non-ASCII paths and can even turn UTF-8 bytes
  // into quote characters that break parsing.
  return `\uFEFF# Claude Alts — generated, do not edit: rewritten whenever accounts change.
# PowerShell. Add to your $PROFILE:  ${sourceLine('powershell')}
$global:ClaudeAccounts = @{
${entries.join('\n')}
}
function claude-use([string]$Account) {
  $a = $global:ClaudeAccounts[$Account]
  if (-not $a) { Write-Error "claude-use: unknown account '$Account' - see claude-accounts"; return }
  foreach ($v in $a.Unset) { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }
  foreach ($k in $a.Set.Keys) { Set-Item "Env:$k" $a.Set[$k] }
}
function claude-as([string]$Account) {
  if (-not $global:ClaudeAccounts[$Account]) { Write-Error "claude-as: unknown account '$Account' - see claude-accounts"; return }
  $saved = @{ CLAUDE_CONFIG_DIR = $env:CLAUDE_CONFIG_DIR; ${SECURE_ENV_VAR} = $env:${SECURE_ENV_VAR} }
  claude-use $Account
  try { claude @args } finally {
    foreach ($k in $saved.Keys) {
      if ($null -eq $saved[$k]) { Remove-Item "Env:$k" -ErrorAction SilentlyContinue } else { Set-Item "Env:$k" $saved[$k] }
    }
  }
}
function claude-accounts { @(${list.join(', ') || "'(no saved accounts)'"}) }
`;
}

/** Rewrites both scripts for the current account list. Best-effort. */
export function writeShellHelpers(accounts: ShellAccount[]): void {
  try {
    fs.mkdirSync(shellDir(), { recursive: true, mode: 0o700 });
    for (const [file, text] of [
      [posixScript(), renderPosix(accounts)],
      [powershellScript(), renderPowerShell(accounts)],
    ] as const) {
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : undefined;
      if (current === text) continue;
      // Per-process temp name: every window rewrites these at once on startup.
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text, { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
  } catch (err) {
    log(`shell helpers: ${(err as Error).message}`);
  }
}
