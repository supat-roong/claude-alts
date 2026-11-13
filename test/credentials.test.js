// The credential layer: where a dir's OAuth token lives (a file, or a macOS
// Keychain item named after the dir) and how a Keychain that can't be asked is
// kept apart from one that says "signed out".
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load } = require('./load');

const WIN = process.platform === 'win32';
const FAKE = path.join(__dirname, 'fake-security.js');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-creds-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.USER = 'tester';
const db = path.join(home, 'keychain.json');
process.env.FAKE_SECURITY_DB = db;
process.env.CLAUDE_ALTS_SECURITY_BIN = FAKE;
const creds = load('credentials', path.join(home, 'build'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const items = () => (fs.existsSync(db) ? JSON.parse(fs.readFileSync(db, 'utf-8')) : {});
const item = (service) => items()[`tester\u0000${service}`];
const token = (s) => Buffer.from(JSON.stringify({ claudeAiOauth: { accessToken: s } }));

function keychain() {
  process.env.CLAUDE_ALTS_TOKEN_STORE = 'keychain';
  delete process.env.FAKE_SECURITY_LOCKED;
  fs.rmSync(db, { force: true });
  creds.forgetCachedTokenStates();
}

test('names Keychain items the way Claude Code does', () => {
  assert.equal(creds.keychainService(path.join(home, '.claude')), 'Claude Code-credentials');
  assert.equal(creds.keychainService(path.join(home, '.claude') + path.sep), 'Claude Code-credentials');
  const dir = '/Users/supat/.claude-pimtwilight';
  // Matches the item Claude Code created on a real Mac for this CLAUDE_CONFIG_DIR.
  assert.equal(creds.keychainService(dir), 'Claude Code-credentials-d478b97f');
  const hash = crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8);
  assert.equal(creds.keychainService(dir), `Claude Code-credentials-${hash}`);
});

test('the Keychain account is $USER, unless it has characters Claude Code rejects', () => {
  assert.equal(creds.keychainAccount(), 'tester');
  process.env.USER = 'a b';
  try {
    assert.equal(creds.keychainAccount(), 'claude-code-user');
  } finally {
    process.env.USER = 'tester';
  }
});

test('file store: write, read, state and delete', () => {
  process.env.CLAUDE_ALTS_TOKEN_STORE = 'file';
  const dir = path.join(home, 'file-store');
  assert.equal(creds.tokenState(dir), 'absent');
  assert.equal(creds.readToken(dir), null);
  assert.ok(creds.writeToken(dir, token('f')));
  assert.equal(creds.tokenState(dir), 'present');
  assert.deepEqual(creds.readToken(dir), token('f'));
  if (!WIN) assert.equal(fs.statSync(path.join(dir, '.credentials.json')).mode & 0o777, 0o600);
  assert.equal(creds.deleteToken(dir), 'removed');
  assert.equal(creds.deleteToken(dir), 'none');
  assert.equal(creds.tokenState(dir), 'absent');
});

test('Keychain store: a token round-trips through its own item', { skip: WIN }, () => {
  keychain();
  const a = path.join(home, 'a');
  const b = path.join(home, 'b');
  assert.equal(creds.tokenState(a), 'absent');
  assert.ok(creds.writeToken(a, token('A')));
  assert.ok(creds.writeToken(b, token('B')));
  assert.deepEqual(creds.readToken(a), token('A'));
  assert.deepEqual(creds.readToken(b), token('B'));
  assert.ok(item(creds.keychainService(a)), 'one item per dir');
  assert.ok(!fs.existsSync(path.join(a, '.credentials.json')), 'no file is written');
  assert.ok(creds.writeToken(a, token('A2')), 'an existing item is updated in place');
  assert.deepEqual(creds.readToken(a), token('A2'));
  assert.equal(creds.deleteToken(a), 'removed');
  assert.equal(creds.tokenState(a), 'absent');
  assert.deepEqual(creds.readToken(b), token('B'), 'the other dir is untouched');
});

test('Keychain store: a token too long for one stdin line goes through argv', { skip: WIN }, () => {
  keychain();
  const dir = path.join(home, 'big');
  const big = token('x'.repeat(5000));
  assert.ok(creds.writeToken(dir, big));
  assert.deepEqual(creds.readToken(dir), big);
});

test("Keychain store: Claude Code's fallback file counts when there is no item", { skip: WIN }, () => {
  keychain();
  const dir = path.join(home, 'fallback');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), token('F'));
  assert.equal(creds.tokenState(dir), 'present');
  assert.deepEqual(creds.readToken(dir), token('F'));
  // Writing moves it into the Keychain and drops the stale file.
  assert.ok(creds.writeToken(dir, token('K')));
  assert.ok(!fs.existsSync(path.join(dir, '.credentials.json')));
  assert.deepEqual(creds.readToken(dir), token('K'));
  // Deleting clears both places.
  fs.writeFileSync(path.join(dir, '.credentials.json'), token('F'));
  assert.equal(creds.deleteToken(dir), 'removed');
  assert.ok(!fs.existsSync(path.join(dir, '.credentials.json')));
  assert.equal(creds.tokenState(dir), 'absent');
});

test('Keychain store: a locked Keychain is unknown, never signed out', { skip: WIN }, () => {
  keychain();
  const dir = path.join(home, 'locked');
  assert.ok(creds.writeToken(dir, token('L')));
  process.env.FAKE_SECURITY_LOCKED = '1';
  creds.forgetCachedTokenStates();
  assert.equal(creds.tokenState(dir), 'unknown');
  assert.equal(creds.readToken(dir), undefined);
  assert.equal(creds.tokenFingerprint(dir), undefined);
  assert.equal(creds.writeToken(dir, token('L2')), false, 'no plaintext fallback over a locked Keychain');
  assert.ok(!fs.existsSync(path.join(dir, '.credentials.json')));
  assert.equal(creds.deleteToken(dir), 'failed');
  delete process.env.FAKE_SECURITY_LOCKED;
  creds.forgetCachedTokenStates();
  assert.deepEqual(creds.readToken(dir), token('L'), 'nothing changed while locked');
});

test('Keychain store: modification time and fingerprint come from attributes', { skip: WIN }, () => {
  keychain();
  const dir = path.join(home, 'stamp');
  assert.equal(creds.tokenModifiedAt(dir), undefined);
  assert.equal(creds.tokenFingerprint(dir), 'absent');
  process.env.FAKE_SECURITY_NOW = String(Date.UTC(2026, 10, 13, 14, 28, 13));
  try {
    assert.ok(creds.writeToken(dir, token('S')));
  } finally {
    delete process.env.FAKE_SECURITY_NOW;
  }
  assert.equal(creds.tokenModifiedAt(dir), Date.UTC(2026, 10, 13, 14, 28, 13));
  assert.match(creds.tokenFingerprint(dir), /^k:\d+$/);
});
