// vscode:uninstall hook — runs via plain `node` when the extension is uninstalled.
//
// What VSCode actually gives us here — all four verified against its logs, and
// every one of them a trap this file used to fall into:
//
//   1. It does NOT run when you click Uninstall. The extension is only MARKED for
//      removal; the hook runs later, from `cleanUp() → deleteExtensionsMarkedForRemoval()`
//      at the next server start. So by the time it runs, the world may have moved on.
//   2. It gets FIVE SECONDS. Overrun and VSCode kills it mid-syscall
//      ("[error] Failed to run post uninstall script … timed out" — measured at
//      5.012s). A hook that is killed halfway through moving data destroys it.
//   3. Because of (1), it can fire AFTER a newer version has been installed — the
//      old version's folder is still on disk with its own copy of this script. A
//      cleanup that deletes account stores would then wipe the LIVE install's
//      accounts. Hence the guard below: if another copy is installed, do nothing.
//   4. It may never run at all (folder deleted by hand, cleanup skipped). So it is
//      best-effort by construction, and nothing may depend on it for correctness.
//
// The contract, in priority order — earlier goals are never sacrificed for later ones:
//   a. Never destroy a live install's data.          (the guard)
//   b. Never lose history.                           (deadline + no destructive step before its data is safe)
//   c. Leave Claude Code signed in and working.      (hand the account back first)
//   d. Leave no OAuth token behind.                  (tokens go even when (b) forces us to stop early)
//   e. Leave no leftover directories.                (only when everything above succeeded)
//
// Vanilla Claude Code (CLAUDE_CONFIG_DIR unset) reads its token from
// ~/.claude/.credentials.json and its identity from ~/.claude.json at the HOME
// ROOT — verified empirically, and NOT the layout of a CLAUDE_CONFIG_DIR account,
// where both sit inside the dir. Restoring to the wrong one leaves Claude Code
// silently signed out, which is the bug this hook exists to prevent.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/** Kept in sync with SHARED_DIRS + SHARED_FILES in src/sharedHistory.ts. */
const SHARED_DIRS = [
  'projects',
  'sessions',
  'session-env',
  'shell-snapshots',
  'file-history',
  'plans',
  'todos',
];
const SHARED_FILES = ['history.jsonl'];
const SHARED_ENTRIES = [...SHARED_DIRS, ...SHARED_FILES];

/**
 * Our own budget, comfortably inside VSCode's 5s kill timer. Being killed is not
 * an option: it happens between two syscalls of our choosing, so there is no way
 * to be safe against it — we simply must not still be running. Every loop that can
 * grow with the user's data checks this and stops at a consistent point instead.
 */
const DEADLINE_MS = 4000;
let deadline = Infinity;
const outOfTime = () => Date.now() > deadline;

/**
 * Extensions dirs of other editors (and their remote servers) on this machine.
 * They all share one home, so they all share this extension's data.
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

/** True if `extDir` holds a copy of this extension not pending removal (other than `me`). */
function liveCopyIn(extDir, prefix, me) {
  let obsolete = {};
  try {
    obsolete = JSON.parse(fs.readFileSync(path.join(extDir, '.obsolete'), 'utf-8')) || {};
  } catch {
    // no .obsolete → nothing is pending removal → any copy is a live install
  }
  return fs.readdirSync(extDir, { withFileTypes: true }).some(
    (e) =>
      e.isDirectory() &&
      e.name !== me &&
      e.name.toLowerCase().startsWith(prefix) &&
      !obsolete[e.name]
  );
}

/**
 * True if a DIFFERENT copy of this extension is still installed.
 *
 * VSCode defers this hook to the next server start, so the user may well have
 * reinstalled by then — and the folder we are running from is the OLD version's,
 * which knows nothing about that. Deleting the account stores at that point would
 * destroy the data of a perfectly healthy install.
 *
 * The same goes for another editor: VS Code, Insiders, Cursor and the rest each
 * have their own extensions dir but share this home, so uninstalling from one
 * must not sign the others out. Every activation records its extensions dir in
 * `<root>/.installs.json` (see extension.ts), which covers editors not listed above.
 */
function anotherCopyInstalled(home, root) {
  let prefix;
  const mine = path.dirname(__dirname); // …/extensions
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
    prefix = `${pkg.publisher}.${pkg.name}-`.toLowerCase();
    if (liveCopyIn(mine, prefix, path.basename(__dirname))) return true;
  } catch {
    // Cannot tell. Assume there IS one: leaving files behind is a nuisance,
    // deleting a live install's accounts is a catastrophe.
    return true;
  }
  let recorded = [];
  try {
    const list = JSON.parse(fs.readFileSync(path.join(root, '.installs.json'), 'utf-8'));
    if (Array.isArray(list)) recorded = list.filter((d) => typeof d === 'string');
  } catch {
    // never recorded — the known dirs still apply
  }
  // Real paths: Node reports __dirname resolved (macOS: /private/var/…), while
  // paths built from the home dir may go through a symlink.
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.normalize(p);
    }
  };
  const same = (a, b) => real(a).toLowerCase() === real(b).toLowerCase();
  const others = [...KNOWN_EXTENSION_DIRS.map((d) => path.join(home, d)), ...recorded].filter(
    (d) => !same(d, mine)
  );
  return others.some((d) => {
    try {
      return liveCopyIn(d, prefix, '');
    } catch {
      return false; // that editor isn't here
    }
  });
}

/** The per-window working dirs this extension creates (<root>/windows/<id>). */
function workingDirs(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.')) // .shell etc. are not windows
      .map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

/** Kept in sync with CREATED_MARKER in src/accounts.ts. */
const CREATED_MARKER = '.claude-alts';

/** Kept in sync with NOT_A_STORE in src/platform.ts. */
const NOT_A_STORE = ['.claude-alts', '.claude-windows', '.claude-shared', '.claude-vault'];

/** A dir directly inside `parent` (string-checked: manifest entries are untrusted). */
function isChildOf(parent, dir) {
  return typeof dir === 'string' && path.dirname(path.normalize(dir)) === path.normalize(parent);
}

/** A `~/.claude-<name>` dir the user made, which the extension may have adopted. */
function isAdoptableName(home, dir) {
  if (!isChildOf(home, dir)) return false;
  const base = path.basename(path.normalize(dir));
  return /^\.claude[-_].+$/.test(base) && !NOT_A_STORE.includes(base);
}

/**
 * The account stores the extension CREATED — the only ones it ever deletes.
 *
 * Three independent records must agree: the manifest lists the store as created,
 * it sits in our accounts root, and it carries our marker file. A
 * `~/.claude-<name>` dir the extension merely ADOPTED (say, from
 * `CLAUDE_CONFIG_DIR=~/.claude-work claude`) is the user's: its settings and
 * sign-in were there before us and stay after us.
 */
function createdStores(accountsRoot, manifestFile) {
  let stores = [];
  try {
    const listed = JSON.parse(fs.readFileSync(manifestFile, 'utf-8')).stores;
    if (Array.isArray(listed)) stores = listed;
  } catch {
    return []; // no manifest → delete no stores (fail safe)
  }
  const marked = (dir) => fs.existsSync(path.join(dir, CREATED_MARKER));
  return [...new Set(stores.filter((d) => isChildOf(accountsRoot, d)).map((d) => path.normalize(d)))].filter(marked);
}

/** The stores the extension adopted: kept, but their history links must be re-aimed. */
function adoptedStores(home, manifestFile) {
  try {
    const listed = JSON.parse(fs.readFileSync(manifestFile, 'utf-8')).adopted;
    return Array.isArray(listed) ? listed.filter((d) => isAdoptableName(home, d)) : [];
  } catch {
    return [];
  }
}

/** True if the link points at `target` (Windows junctions read back decorated). */
function pointsAt(link, target) {
  const win = process.platform === 'win32';
  const canon = (p) => {
    const n = path.normalize(p.replace(/^\\\\\?\\/, '')).replace(/[\\/]+$/, '');
    return win ? n.toLowerCase() : n;
  };
  try {
    return canon(fs.readlinkSync(link)) === canon(target);
  } catch {
    return false;
  }
}

/** Removes a symlink or junction itself, never what it points at. */
function removeLink(link) {
  try {
    fs.unlinkSync(link);
  } catch {
    fs.rmdirSync(link); // Windows removes a directory junction with rmdir
  }
}

/**
 * Deletes a file or a whole dir, removing links inside it as links.
 *
 * Not fs.rmSync: on Windows, under the Node VS Code runs this hook with (24),
 * rmSync({recursive, force}) silently leaves a dir holding dangling junctions
 * in place — exactly what every working dir holds once its history has moved.
 * Seen on Windows 11: it reported success and deleted nothing but the files.
 */
function removeTree(target) {
  const st = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isSymbolicLink()) return removeLink(target);
  if (!st.isDirectory()) return fs.unlinkSync(target);
  for (const e of fs.readdirSync(target)) removeTree(path.join(target, e));
  fs.rmdirSync(target);
}

/**
 * Points an adopted store's history links at `~/.claude`, where the history now
 * lives, so the dir keeps working on its own — with every conversation it had.
 * Only our own links (into the shared store) are touched.
 */
function reaimLinks(dir, store, defaultDir) {
  for (const name of SHARED_ENTRIES) {
    const link = path.join(dir, name);
    try {
      const st = fs.lstatSync(link, { throwIfNoEntry: false });
      // Windows hard-links history.jsonl: it already IS the file now in ~/.claude.
      if (!st || !st.isSymbolicLink()) continue;
      if (!pointsAt(link, path.join(store, name))) continue;
      removeLink(link);
      fs.symlinkSync(path.join(defaultDir, name), link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      /* best-effort: a dangling link only hides history, it loses none */
    }
  }
}

/**
 * Folds `src` into `dst` by MOVING entries, never by reading them.
 *
 * The previous version compared colliding files byte for byte. On a real 1.3 GB
 * history that is 1.3 GB of reads: measured at 22 seconds — four times over the
 * kill timer, so the hook died mid-move. Nothing here may cost more than a stat:
 * a file that is already there and the same size is a duplicate of a store every
 * dir was symlinked to, and gets dropped; anything else is left where it is and
 * reported as a conflict, so the caller keeps the store instead of deleting it.
 *
 * Returns false if anything could not be moved (conflict, error, or out of time).
 */
function moveDirInto(src, dst) {
  let complete = true;
  let entries;
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return false;
  }
  fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    if (outOfTime()) return false;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    try {
      const dstStat = fs.lstatSync(d, { throwIfNoEntry: false });
      if (!dstStat) {
        fs.renameSync(s, d);
      } else if (entry.isDirectory() && dstStat.isDirectory()) {
        if (!moveDirInto(s, d)) complete = false;
      } else if (entry.isFile() && dstStat.isFile() && fs.statSync(s).size === dstStat.size) {
        fs.rmSync(s, { force: true }); // same size ⇒ the same file, seen twice
      } else {
        complete = false; // a real divergence — never resolved by guessing
      }
    } catch {
      complete = false;
    }
  }
  return complete;
}

/** Folds a line-based file (history.jsonl) into `dst`, skipping lines it has. */
function mergeFileInto(src, dst) {
  try {
    const existing = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf-8') : '';
    const known = new Set(existing.split('\n').filter(Boolean));
    const incoming = fs
      .readFileSync(src, 'utf-8')
      .split('\n')
      .filter((line) => line && !known.has(line));
    if (incoming.length > 0) {
      const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(dst, `${prefix}${incoming.join('\n')}\n`, { mode: 0o600 });
    }
    fs.rmSync(src, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Brings the history into the default dir, where plain Claude Code will look for it.
 *
 * In the normal case every entry is a symlink into the store, so this is one
 * unlink + one rename per entry — eight syscalls, measured at 135 ms regardless of
 * how many gigabytes the store holds. The unlink and the rename sit next to each
 * other on purpose: a kill between two ENTRIES leaves the rest still symlinked to
 * an intact store, and loses nothing.
 *
 * Returns true only if EVERY entry made it. The caller must not delete the store
 * otherwise — by then it is the only copy of whatever stayed behind.
 */
function consolidateHistory(defaultDir, store, otherDirs) {
  let complete = true;
  fs.mkdirSync(defaultDir, { recursive: true, mode: 0o700 });

  for (const name of SHARED_ENTRIES) {
    if (outOfTime()) return false;
    const src = path.join(store, name);
    const dst = path.join(defaultDir, name);
    try {
      if (!fs.existsSync(src)) continue;
      const dstStat = fs.lstatSync(dst, { throwIfNoEntry: false });
      // The common case: our own symlink. Drop it and move the real thing in.
      if (dstStat && dstStat.isSymbolicLink()) {
        fs.unlinkSync(dst);
        try {
          fs.renameSync(src, dst);
        } catch (err) {
          // Windows refuses to move a dir with an open file in it. The history is
          // still safe in the store, but put the link back or ~/.claude loses it.
          const isDir = fs.statSync(src).isDirectory();
          fs.symlinkSync(src, dst, isDir ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
          throw err;
        }
        continue;
      }
      if (!dstStat) {
        fs.renameSync(src, dst);
      } else if (SHARED_FILES.includes(name)) {
        if (!mergeFileInto(src, dst)) complete = false;
      } else if (!moveDirInto(src, dst)) {
        complete = false;
      }
    } catch {
      complete = false;
    }
  }

  // History that never made it into the store (a link that failed to form)
  // still sits inside the account dirs. Fold that in too, or deleting those dirs
  // below would delete the only copy.
  for (const dir of otherDirs) {
    for (const name of SHARED_ENTRIES) {
      if (outOfTime()) return false;
      const src = path.join(dir, name);
      const dst = path.join(defaultDir, name);
      try {
        const st = fs.lstatSync(src, { throwIfNoEntry: false });
        if (!st || st.isSymbolicLink()) continue; // symlinks die with their dir (rm doesn't follow them)
        if (st.isDirectory()) {
          if (!moveDirInto(src, dst)) complete = false;
        } else if (st.isFile()) {
          if (fs.existsSync(dst)) {
            if (!mergeFileInto(src, dst)) complete = false;
          } else {
            fs.renameSync(src, dst);
          }
        }
      } catch {
        complete = false;
      }
    }
  }
  return complete;
}

/**
 * The dir holding the account to hand back: the freshest OAuth token on disk.
 *
 * Working dirs win over stores when both have one: a working dir is where Claude
 * Code actually ran, so its token is the one that got refreshed and its config is
 * the live one, where a store's config is only a snapshot from when it was saved.
 */
function lastUsedDir(working, stores) {
  const freshest = (dirs) => {
    let best;
    let bestTime = -1;
    for (const dir of dirs) {
      try {
        const t = fs.statSync(path.join(dir, '.credentials.json')).mtimeMs;
        if (t > bestTime) {
          bestTime = t;
          best = dir;
        }
      } catch {
        // no token here — not a candidate
      }
    }
    return best;
  };
  return freshest(working) ?? freshest(stores);
}

/**
 * Hands the account back to vanilla Claude Code: token into ~/.claude, identity
 * into ~/.claude.json. Both come from the SAME dir — an identity paired with
 * another account's token is the exact desync this extension was built to fix.
 *
 * Runs FIRST, before anything is moved or deleted: it is the one step that decides
 * whether the user still has a working Claude Code, and it costs two small copies.
 * The config is merged over whatever ~/.claude.json already had rather than
 * replacing it, so settings that predate the extension survive.
 */
function restoreDefaultAccount(source, defaultDir, defaultConfig) {
  try {
    const token = path.join(source, '.credentials.json');
    if (!fs.existsSync(token)) return;
    fs.mkdirSync(defaultDir, { recursive: true, mode: 0o700 });
    const dstToken = path.join(defaultDir, '.credentials.json');
    fs.copyFileSync(token, dstToken);
    fs.chmodSync(dstToken, 0o600);

    const cfgFile = path.join(source, '.claude.json');
    if (!fs.existsSync(cfgFile)) return;
    const incoming = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));
    let existing = {};
    try {
      existing = JSON.parse(fs.readFileSync(defaultConfig, 'utf-8'));
    } catch {
      // no default config yet, or unreadable — the account's is all we need
    }
    const merged = {
      ...existing,
      ...incoming,
      projects: { ...(existing.projects || {}), ...(incoming.projects || {}) },
    };
    const tmp = `${defaultConfig}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, defaultConfig); // atomic: a half-written config bricks Claude Code
  } catch {
    /* best-effort */
  }
}

/**
 * What Claude Code writes into a config dir that is safe to throw away once the
 * history is out: the token and config copies, their temp/lock/backup files, our
 * markers, and caches. Anything else — settings.json, CLAUDE.md, agents, skills,
 * commands, plugins — is the user's, and keeps its dir alive.
 */
const DISPOSABLE_FILE = /^(\.credentials\.json(\..*)?|\.claude\.json\..+|\.claude-alts(-ran)?|\.last-cleanup|\.last-update-result\.json|stats-cache\.json|policy-limits\.json.*|remote-settings\.json.*)$/;
const DISPOSABLE_DIRS = ['ide', 'cache', 'backups', 'state', 'telemetry', 'statsig', 'debug', 'paste-cache', 'downloads'];

/** True if the tree holds nothing but empty dirs (and dangling links, which hold nothing). */
function isEmptyTree(dir) {
  if (outOfTime()) return false;
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).every((e) => {
      if (e.isSymbolicLink()) return true;
      return e.isDirectory() && isEmptyTree(path.join(dir, e.name));
    });
  } catch {
    return false;
  }
}

/** `.claude.json` is a copy of the account's config, unless it gained user-scope MCP servers. */
function isDisposableConfig(file) {
  try {
    const servers = JSON.parse(fs.readFileSync(file, 'utf-8')).mcpServers;
    return !servers || Object.keys(servers).length === 0;
  } catch {
    return false;
  }
}

/** True if nothing in `dir` is the user's: it can be deleted without losing anything. */
function isDisposable(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).every((e) => {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) return true;
      if (e.isFile()) {
        if (e.name === '.claude.json') return isDisposableConfig(p);
        return DISPOSABLE_FILE.test(e.name);
      }
      if (e.isDirectory()) return DISPOSABLE_DIRS.includes(e.name) || isEmptyTree(p);
      return false;
    });
  } catch {
    return false;
  }
}

/** Deletes the OAuth token from our dirs. The one step that must happen even when we bail out. */
function dropTokens(dirs) {
  for (const dir of dirs) {
    try {
      fs.rmSync(path.join(dir, '.credentials.json'), { force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Kept in sync with credentialsInKeychain() in src/platform.ts: a Mac whose
 * Claude Code keeps its sign-in in the Keychain, where the extension is inert.
 */
function credentialsInKeychain(home) {
  if (os.platform() !== 'darwin') return false;
  if (fs.existsSync(path.join(home, '.claude', '.credentials.json'))) return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8'));
    return Boolean(cfg && cfg.oauthAccount && cfg.oauthAccount.emailAddress);
  } catch {
    return false;
  }
}

function main() {
  // On unsupported platforms — and on a Keychain-backed Mac — the extension
  // activates into an inert mode and never created anything, so there is nothing
  // to revert, and guessing at those layouts on uninstall is exactly the
  // manipulation that mode promises not to do.
  if (!['linux', 'darwin', 'win32'].includes(os.platform())) return;
  if (credentialsInKeychain(os.homedir())) return;

  const home = os.homedir();
  // Kept in sync with dataRoot() and friends in src/platform.ts.
  const root = path.join(home, '.claude-alts');

  // Another copy is live and this data is now ITS data. Touch nothing.
  if (anotherCopyInstalled(home, root)) return;

  deadline = Date.now() + DEADLINE_MS;

  const defaultDir = path.join(home, '.claude');
  const defaultConfig = path.join(home, '.claude.json');
  const accountsRoot = path.join(root, 'accounts');
  const store = path.join(root, 'shared');
  const workRoot = path.join(root, 'windows');

  const working = workingDirs(workRoot);
  const manifest = path.join(root, '.manifest.json');
  const stores = createdStores(accountsRoot, manifest);
  const adopted = adoptedStores(home, manifest);
  const ours = [...working, ...stores];

  // 1. Leave Claude Code working. Cheap, and everything after it is optional.
  const source = lastUsedDir(working, [...stores, ...adopted]);
  if (source) restoreDefaultAccount(source, defaultDir, defaultConfig);

  // 2. Get the history somewhere plain Claude Code can see it.
  const consolidated = consolidateHistory(defaultDir, store, ours);

  // 3. If any history stayed behind, the dirs holding it are now its only copy —
  //    keep them. The tokens still go: a leftover folder is untidy, a leftover
  //    OAuth token is a credential we promised not to leave lying around.
  if (!consolidated) {
    dropTokens(ours);
    return;
  }

  // Adopted stores stay, fully intact — only their history links follow the move.
  for (const dir of adopted) reaimLinks(dir, store, defaultDir);

  // 4. The history is safe in ~/.claude. A dir holding nothing but copies, caches
  //    and dangling links goes (removeTree never follows a link, so the store's
  //    content is never at risk here). One the user put their own config in
  //    stays, minus its token, with its history links aimed at ~/.claude so it
  //    still works as a Claude Code dir.
  const keep = (dir) => {
    dropTokens([dir]);
    reaimLinks(dir, store, defaultDir);
  };
  for (const dir of ours) {
    if (outOfTime() || !isDisposable(dir)) {
      keep(dir);
      continue;
    }
    try {
      removeTree(dir);
    } catch {
      keep(dir);
    }
  }
  // The store is empty now unless it kept backups of diverged transcripts
  // (`.merge-backup`), which are history too.
  if (isEmptyTree(store)) {
    try {
      removeTree(store);
    } catch {
      /* best-effort */
    }
  }
  for (const file of [path.join(root, 'shell'), manifest, path.join(root, '.installs.json')]) {
    try {
      removeTree(file);
    } catch {
      /* best-effort */
    }
  }
  // The roots go only if nothing is left in them: a store missing from the
  // manifest is not provably ours, and may hold the only copy of something.
  for (const dir of [workRoot, accountsRoot, root]) {
    try {
      fs.rmdirSync(dir);
    } catch {
      /* not empty, or already gone */
    }
  }
}

main();
