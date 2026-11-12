import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { expandHome } from './accounts';

/**
 * Which account a window SHOULD run, by configuration rather than memory.
 *
 *   claudeAlts.folderRules     [{ folder | gitRemote, account }] — first match wins
 *   claudeAlts.defaultAccount  the account for a window that has never run one
 *
 * Rules are read synchronously at activation (the race with Claude Code allows
 * no awaiting), so everything here is plain file reads: the git remote comes
 * from `.git/config` directly, never from spawning git.
 */

export interface FolderRule {
  /** A folder path or glob (`~/work/**`); also matches everything inside it. */
  folder?: string;
  /** A remote URL glob, matched host/path style: `github.com/acme/*`. */
  gitRemote?: string;
  /** The account to use: its email (or saved name). */
  account: string;
}

const SECTION = 'claudeAlts';

/** macOS and Windows file systems are case-insensitive by default. */
const CASELESS = process.platform === 'darwin' || process.platform === 'win32';

function settings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

export function folderRules(): FolderRule[] {
  // Deep copy: settings come as read-only proxies, unsafe to copy shallowly and
  // write back (see labels.setLabel).
  const rules = JSON.parse(JSON.stringify(settings().get<FolderRule[]>('folderRules', []) ?? [])) as unknown;
  return Array.isArray(rules) ? (rules as FolderRule[]).filter((r) => r && typeof r.account === 'string') : [];
}

/** The configured default account (email or name), if any. */
export function defaultAccount(): string | undefined {
  return settings().get<string>('defaultAccount')?.trim() || undefined;
}

/** A glob as a regex: `**` any depth, `*` within one path segment, `?` one char. */
function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}(/.*)?$`, CASELESS ? 'i' : '');
}

/** Forward slashes, no trailing slash — so one pattern works on every OS. */
function slashed(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

function folderMatches(pattern: string, folder: string): boolean {
  return globToRegex(slashed(path.resolve(expandHome(pattern)))).test(slashed(folder));
}

/**
 * `git@github.com:acme/app.git`, `https://u@github.com/acme/app`,
 * `ssh://git@github.com:22/acme/app.git` → `github.com/acme/app`.
 */
export function normalizeRemote(url: string): string {
  let u = url.trim().replace(/\.git$/, '');
  u = u.replace(/^[a-z+]+:\/\//i, ''); // scheme
  u = u.replace(/^[^@/]+@/, ''); // user
  u = u.replace(/^([^/:]+):\d+\//, '$1/'); // port
  u = u.replace(/^([^/:]+):/, '$1/'); // scp-style host:path
  return u.replace(/\/+$/, '');
}

/** Remote URLs of the repo at `folder`, read straight from its git config. */
export function gitRemotes(folder: string): string[] {
  try {
    let gitDir = path.join(folder, '.git');
    const st = fs.statSync(gitDir);
    if (st.isFile()) {
      // A worktree or submodule: `.git` is a file pointing at the real git dir,
      // whose shared config sits in its "commondir".
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf-8'));
      if (!m) return [];
      gitDir = path.resolve(folder, m[1].trim());
      const common = path.join(gitDir, 'commondir');
      if (fs.existsSync(common)) gitDir = path.resolve(gitDir, fs.readFileSync(common, 'utf-8').trim());
    }
    // Only [remote "…"] sections: a [submodule "…"] url is another repo's.
    const urls: string[] = [];
    let inRemote = false;
    for (const line of fs.readFileSync(path.join(gitDir, 'config'), 'utf-8').split(/\r?\n/)) {
      const section = /^\s*\[\s*([^\s\]"]+)/.exec(line);
      if (section) inRemote = section[1].toLowerCase() === 'remote';
      const url = inRemote ? /^\s*url\s*=\s*(.+)$/.exec(line) : null;
      if (url) urls.push(url[1].trim());
    }
    return urls;
  } catch {
    return []; // not a git repo
  }
}

/** The account the first matching rule assigns to `folder`, if any. */
export function ruleAccountFor(folder: string | undefined): string | undefined {
  if (!folder) return undefined;
  const rules = folderRules();
  if (rules.length === 0) return undefined;
  let remotes: string[] | undefined;
  for (const rule of rules) {
    if (rule.folder && folderMatches(rule.folder, folder)) return rule.account;
    if (rule.gitRemote) {
      remotes ??= gitRemotes(folder).map(normalizeRemote);
      const re = globToRegex(normalizeRemote(rule.gitRemote));
      if (remotes.some((r) => re.test(r))) return rule.account;
    }
  }
  return undefined;
}

/** Adds (or replaces) the rule for exactly this folder, in user settings. */
export async function setFolderRule(folder: string, account: string): Promise<void> {
  const same = (r: FolderRule) => r.folder && slashed(path.resolve(expandHome(r.folder))) === slashed(folder);
  const rules = folderRules().filter((r) => !same(r));
  rules.unshift({ folder, account });
  await settings().update('folderRules', rules, vscode.ConfigurationTarget.Global);
}

export async function setDefaultAccount(account: string | undefined): Promise<void> {
  await settings().update('defaultAccount', account, vscode.ConfigurationTarget.Global);
}
