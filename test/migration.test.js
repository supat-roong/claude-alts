// Moving over from Claude Parallel Accounts, the extension this one was forked
// from: its history and accounts must carry over, and nothing of the user's may
// be hidden or deleted on the way.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load } = require('./load');

const WIN = process.platform === 'win32';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-migrate-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const history = load('sharedHistory', path.join(home, 'build-history'));
const accounts = load('accounts', path.join(home, 'build-accounts'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function write(file, content = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function linkDir(target, link) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, WIN ? 'junction' : 'dir');
}

function linkFile(target, link) {
  if (WIN) fs.linkSync(target, link); // as both extensions do on Windows
  else fs.symlinkSync(target, link);
}

/** An ExtensionContext whose globalState is a plain map. */
function context() {
  const state = new Map();
  return {
    globalState: {
      get: (k, d) => (state.has(k) ? JSON.parse(JSON.stringify(state.get(k))) : d),
      update: async (k, v) => void state.set(k, v),
    },
  };
}

test("the original's history comes along when ~/.claude is relinked", () => {
  const theirs = path.join(home, '.claude-shared');
  write(path.join(theirs, 'projects', 'repo', 'chat.jsonl'), '{"a":1}\n');
  write(path.join(theirs, 'history.jsonl'), '{"h":1}\n');
  const def = path.join(home, '.claude');
  linkDir(path.join(theirs, 'projects'), path.join(def, 'projects'));
  linkFile(path.join(theirs, 'history.jsonl'), path.join(def, 'history.jsonl'));

  const warnings = history.ensureSharedHistory([def]);
  assert.deepEqual(warnings, []);
  const ours = history.sharedStoreDir();
  assert.equal(fs.readFileSync(path.join(def, 'projects', 'repo', 'chat.jsonl'), 'utf-8'), '{"a":1}\n');
  assert.equal(fs.realpathSync(path.join(def, 'projects')), fs.realpathSync(path.join(ours, 'projects')));
  assert.match(fs.readFileSync(path.join(ours, 'history.jsonl'), 'utf-8'), /"h":1/);
  assert.match(fs.readFileSync(path.join(def, 'history.jsonl'), 'utf-8'), /"h":1/);
});

test('a link that reaches the store through ~/.claude is relinked, quietly', () => {
  // What the uninstall step leaves in an adopted dir: a link to ~/.claude/projects.
  const dir = path.join(home, '.claude-reaimed');
  linkDir(path.join(home, '.claude', 'projects'), path.join(dir, 'projects'));
  const ours = path.join(history.sharedStoreDir(), 'projects');

  assert.deepEqual(history.ensureSharedHistory([path.join(home, '.claude'), dir]), []);
  assert.equal(fs.realpathSync(path.join(dir, 'projects')), fs.realpathSync(ours));
  const target = fs.readlinkSync(path.join(dir, 'projects')).replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '');
  assert.equal(path.normalize(target).toLowerCase(), path.normalize(ours).toLowerCase(), 'linked directly');
});

test("a link of the user's own is left alone, with a warning", () => {
  const mine = path.join(home, 'Dropbox', 'claude-projects');
  write(path.join(mine, 'chat.jsonl'), 'x\n');
  const dir = path.join(home, '.claude-custom');
  linkDir(mine, path.join(dir, 'projects'));

  const warnings = history.ensureSharedHistory([dir]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /left as it is/);
  assert.equal(fs.realpathSync(path.join(dir, 'projects')), fs.realpathSync(mine));
  assert.ok(fs.existsSync(path.join(mine, 'chat.jsonl')));
});

test("the original's accounts are imported as copies; the user's own are adopted", async () => {
  const account = (dir, email) => {
    write(path.join(dir, '.credentials.json'), `{"token":"${email}"}`);
    write(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }));
  };
  const listed = path.join(home, '.claude-work');
  const marked = path.join(home, '.claude-side');
  const own = path.join(home, '.claude-mine');
  account(listed, 'work@x.com');
  account(marked, 'side@x.com');
  write(path.join(marked, '.claude-parallel-accounts'), 'created');
  account(own, 'me@x.com');
  // Listed, but with no config: nothing to pair the token with, so not imported.
  const bare = path.join(home, '.claude-bare');
  write(path.join(bare, '.credentials.json'), '{"token":"bare"}');
  write(path.join(home, '.claude-windows', '.manifest.json'), JSON.stringify({ stores: [listed, bare] }));
  // A working dir of the original running work@x.com, with a fresher token.
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(path.join(listed, '.credentials.json'), old, old);
  const working = path.join(home, '.claude-windows', 'abc123');
  account(working, 'work@x.com');
  write(path.join(working, '.credentials.json'), '{"token":"fresh"}');

  const registry = new accounts.AccountRegistry(context());
  const list = await registry.discoverAndMerge();
  const byEmail = Object.fromEntries(list.map((a) => [registry.emailOf(a), a]));
  const root = path.join(home, '.claude-alts', 'accounts');

  for (const [email, name] of [['work@x.com', 'work'], ['side@x.com', 'side']]) {
    const a = byEmail[email];
    assert.ok(a, `${email} saved`);
    assert.equal(path.normalize(a.dir), path.join(root, name));
    assert.equal(a.origin, 'created');
    assert.ok(fs.existsSync(path.join(a.dir, '.claude-alts')), 'marked as ours');
  }
  assert.equal(fs.readFileSync(path.join(root, 'work', '.credentials.json'), 'utf-8'), '{"token":"fresh"}');
  assert.ok(!fs.existsSync(path.join(root, 'bare')), 'a store without config is not imported');
  assert.equal(path.normalize(byEmail['me@x.com'].dir), own);
  assert.equal(byEmail['me@x.com'].origin, 'adopted');
  // The originals stay where they are, untouched.
  assert.ok(fs.existsSync(path.join(listed, '.credentials.json')));
  assert.equal(list.length, 3, 'no duplicate entries for the originals');
});
