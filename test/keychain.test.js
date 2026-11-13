// The account flows on a Mac whose Claude Code keeps its tokens in the Keychain,
// run against a stand-in for /usr/bin/security (test/fake-security.js): every
// window and store gets its own item, and a Keychain that can't be asked never
// drops an account.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load } = require('./load');

const WIN = process.platform === 'win32';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-keychain-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.USER = 'tester';
process.env.CLAUDE_ALTS_TOKEN_STORE = 'keychain';
process.env.CLAUDE_ALTS_SECURITY_BIN = path.join(__dirname, 'fake-security.js');
const db = path.join(home, 'keychain.json');
process.env.FAKE_SECURITY_DB = db;
const creds = load('credentials', path.join(home, 'build-creds'));
const accounts = load('accounts', path.join(home, 'build-accounts'));
const workdir = load('workdir', path.join(home, 'build-workdir'));
const reclaim = load('reclaim', path.join(home, 'build-reclaim'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Past the credential layer's presence cache, which each bundle keeps on its own. */
const settle = () => sleep(1600);

function write(file, content = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const token = (s) => JSON.stringify({ claudeAiOauth: { accessToken: s } });
const read = (dir) => creds.readToken(dir)?.toString('utf-8');

/** A signed-in dir: identity in its config, token in the Keychain. */
function account(dir, email, tok, at) {
  write(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }));
  if (at) process.env.FAKE_SECURITY_NOW = String(at);
  try {
    assert.ok(creds.writeToken(dir, Buffer.from(tok)));
  } finally {
    delete process.env.FAKE_SECURITY_NOW;
  }
}

function context() {
  const state = new Map();
  return {
    globalState: {
      get: (k, d) => (state.has(k) ? JSON.parse(JSON.stringify(state.get(k))) : d),
      update: async (k, v) => void state.set(k, v),
    },
  };
}

test("the original's Keychain accounts are imported with their freshest token", { skip: WIN }, async () => {
  const store = path.join(home, '.claude-work');
  account(store, 'work@x.com', token('stale'), Date.now() - 3600_000);
  const working = path.join(home, '.claude-windows', 'abc123');
  account(working, 'work@x.com', token('fresh'), Date.now());
  write(path.join(home, '.claude-windows', '.manifest.json'), JSON.stringify({ stores: [store] }));

  const registry = new accounts.AccountRegistry(context());
  const list = await registry.discoverAndMerge();
  const imported = path.join(home, '.claude-alts', 'accounts', 'work');
  assert.deepEqual(
    list.map((a) => path.normalize(a.dir)),
    [imported]
  );
  assert.equal(read(imported), token('fresh'));
  assert.ok(!fs.existsSync(path.join(imported, '.credentials.json')), 'kept in the Keychain, not a file');
  assert.equal(read(store), token('stale'), "the original's item is untouched");
});

test('a window runs its own Keychain copy of the account, synced back to the store', { skip: WIN }, () => {
  const store = path.join(home, '.claude-alts', 'accounts', 'solo');
  account(store, 'solo@x.com', token('s1'));
  const win = path.join(home, '.claude-alts', 'windows', 'w1');
  const acc = { name: 'solo', dir: store, email: 'solo@x.com', origin: 'created' };

  assert.ok(workdir.materialize(acc, win, true));
  assert.equal(read(win), token('s1'));
  assert.notEqual(creds.keychainService(win), creds.keychainService(store), 'an item of its own');

  // Claude Code refreshes the window's token; the store follows.
  assert.ok(creds.writeToken(win, Buffer.from(token('s2'))));
  workdir.refreshStore(acc, win);
  assert.equal(read(store), token('s2'));
});

test('signing out deletes the item and clears the identity', { skip: WIN }, async () => {
  const dir = path.join(home, '.claude-alts', 'windows', 'w-out');
  account(dir, 'out@x.com', token('o'));
  await settle();
  assert.equal(reclaim.signOut(dir), 'removed');
  assert.equal(creds.tokenState(dir), 'absent');
  assert.equal(accounts.readIdentity(dir), null);
});

test('a locked Keychain drops no account and signs nothing out', { skip: WIN }, async () => {
  const store = path.join(home, '.claude-alts', 'accounts', 'kept');
  account(store, 'kept@x.com', token('k'));
  const registry = new accounts.AccountRegistry(context());
  await registry.add({ name: 'kept', dir: store, email: 'kept@x.com', origin: 'created' });
  await settle();

  process.env.FAKE_SECURITY_LOCKED = '1';
  try {
    assert.deepEqual(await registry.pruneSignedOut(), []);
    assert.ok(registry.get('kept'), 'still listed');
    assert.equal(reclaim.signOut(store), 'failed');
    assert.equal(accounts.readIdentity(store)?.email, 'kept@x.com', 'identity kept with the live token');
    const win = path.join(home, '.claude-alts', 'windows', 'w-locked');
    fs.mkdirSync(win, { recursive: true });
    const acc = registry.get('kept');
    assert.equal(workdir.materialize(acc, win), false, 'a dir it cannot see into is left alone');
  } finally {
    delete process.env.FAKE_SECURITY_LOCKED;
  }
  await settle();
  assert.equal(read(store), token('k'));
});
