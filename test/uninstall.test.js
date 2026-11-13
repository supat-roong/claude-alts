// Runs uninstall.js against a throwaway home and checks what it keeps and deletes.
// The hook is the one piece of this extension that deletes things, so every
// "never delete X" promise in it has a case here.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8'));
const EXT_NAME = `${PKG.publisher}.${PKG.name}-${PKG.version}`;
const WIN = process.platform === 'win32';

function write(file, content = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Links an account dir's history entry to the shared store, the way the extension does. */
function linkShared(dir, store, name) {
  const target = path.join(store, name);
  const link = path.join(dir, name);
  if (fs.statSync(target).isDirectory()) fs.symlinkSync(target, link, WIN ? 'junction' : 'dir');
  else if (WIN) fs.linkSync(target, link);
  else fs.symlinkSync(target, link);
}

/** A home with a typical install: two windows, a created store, an adopted one, shared history. */
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-uninstall-'));
  const root = path.join(home, '.claude-alts');
  const store = path.join(root, 'shared');
  write(path.join(store, 'projects', 'p', 'chat.jsonl'), '{"a":1}\n');
  write(path.join(store, 'history.jsonl'), '{"h":1}\n');
  write(path.join(store, '.merge-backup', 'projects', 'p', 'chat.jsonl.1'), 'older\n');

  const account = (dir, email, extra = {}) => {
    write(path.join(dir, '.credentials.json'), '{"token":"t"}');
    write(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email }, ...extra }));
    linkShared(dir, store, 'projects');
    linkShared(dir, store, 'history.jsonl');
  };

  const plain = path.join(root, 'windows', 'w-plain');
  account(plain, 'a@x.com');
  write(path.join(plain, '.claude-alts-ran'), 'work');
  write(path.join(plain, 'ide', '1.lock'), 'x');
  fs.mkdirSync(path.join(plain, 'plugins'));
  const configured = path.join(root, 'windows', 'w-configured');
  account(configured, 'a@x.com');
  write(path.join(configured, 'settings.json'), '{"permissions":{}}');
  const mcp = path.join(root, 'windows', 'w-mcp');
  account(mcp, 'a@x.com', { mcpServers: { db: { command: 'x' } } });

  const created = path.join(root, 'accounts', 'work');
  account(created, 'a@x.com');
  write(path.join(created, '.claude-alts'), 'created');
  const stray = path.join(root, 'accounts', 'stray');
  write(path.join(stray, '.credentials.json'), '{"token":"t"}');

  const adopted = path.join(home, '.claude-mine');
  account(adopted, 'b@x.com');
  write(path.join(adopted, 'settings.json'), '{}');
  // The original extension's dirs, which must never be touched.
  write(path.join(home, '.claude-windows', 'x', '.credentials.json'), '{"token":"t"}');

  write(path.join(root, '.manifest.json'), JSON.stringify({ stores: [created], adopted: [adopted] }));
  write(path.join(root, 'shell', 'claude-accounts.sh'), '');

  const extDir = path.join(home, '.vscode', 'extensions');
  const me = path.join(extDir, EXT_NAME);
  fs.mkdirSync(me, { recursive: true });
  fs.copyFileSync(path.join(REPO, 'uninstall.js'), path.join(me, 'uninstall.js'));
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(me, 'package.json'));
  return { home, root, store, plain, configured, mcp, created, stray, adopted, extDir, me };
}

function runHook(h, env = {}) {
  execFileSync(process.execPath, [path.join(h.me, 'uninstall.js')], {
    // Tokens as files unless a test says otherwise: never the real macOS Keychain.
    env: { ...process.env, HOME: h.home, USERPROFILE: h.home, CLAUDE_ALTS_TOKEN_STORE: 'file', ...env },
    stdio: 'inherit',
  });
}

// ─── The Keychain, through the stand-in for /usr/bin/security ────────────────

const service = (dir) =>
  `Claude Code-credentials-${crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;
const DEFAULT_SERVICE = 'Claude Code-credentials';

/** Moves every token file under `dirs` into a fake Keychain, `mdat` from the file's mtime. */
function intoKeychain(h, dirs) {
  const db = {};
  for (const dir of dirs) {
    const file = path.join(dir, '.credentials.json');
    if (!exists(file)) continue;
    db[`tester\u0000${service(dir)}`] = {
      hex: fs.readFileSync(file).toString('hex'),
      mdat: fs.statSync(file).mtimeMs,
    };
    fs.rmSync(file);
  }
  const file = path.join(h.home, 'keychain.json');
  fs.writeFileSync(file, JSON.stringify(db));
  return {
    file,
    env: {
      CLAUDE_ALTS_TOKEN_STORE: 'keychain',
      CLAUDE_ALTS_SECURITY_BIN: path.join(__dirname, 'fake-security.js'),
      FAKE_SECURITY_DB: file,
      USER: 'tester',
    },
    item: (svc) => JSON.parse(fs.readFileSync(file, 'utf-8'))[`tester\u0000${svc}`],
  };
}

const exists = (p) => fs.existsSync(p);
const read = (p) => fs.readFileSync(p, 'utf-8');

test('moves history home and deletes only what is disposable', () => {
  const h = makeHome();
  try {
    runHook(h);
    const def = path.join(h.home, '.claude');
    // Claude Code is handed an account and every conversation.
    assert.ok(exists(path.join(def, '.credentials.json')), 'account restored');
    assert.equal(read(path.join(def, 'projects', 'p', 'chat.jsonl')), '{"a":1}\n');
    assert.match(read(path.join(def, 'history.jsonl')), /"h":1/);
    // Copies and caches go.
    assert.ok(!exists(h.plain), 'disposable working dir deleted');
    assert.ok(!exists(h.created), 'created store deleted');
    assert.ok(!exists(path.join(h.root, 'shell')), 'shell helpers deleted');
    // User config stays, without its token.
    assert.ok(exists(path.join(h.configured, 'settings.json')), 'settings.json kept');
    assert.ok(!exists(path.join(h.configured, '.credentials.json')), 'token dropped');
    assert.equal(
      fs.realpathSync(path.join(h.configured, 'projects')),
      fs.realpathSync(path.join(def, 'projects')),
      "a kept dir's history links follow the history to ~/.claude"
    );
    assert.ok(exists(path.join(h.mcp, '.claude.json')), 'user MCP servers kept');
    assert.ok(!exists(path.join(h.mcp, '.credentials.json')), 'token dropped');
    // Backups of diverged transcripts are history too.
    assert.ok(exists(path.join(h.store, '.merge-backup', 'projects', 'p', 'chat.jsonl.1')), 'merge backups kept');
    // Not provably ours: untouched.
    assert.ok(exists(path.join(h.stray, '.credentials.json')), 'unlisted store untouched');
    assert.ok(exists(path.join(h.home, '.claude-windows', 'x', '.credentials.json')), "original's dirs untouched");
    // Adopted store keeps everything, and its history now comes from ~/.claude.
    assert.ok(exists(path.join(h.adopted, 'settings.json')));
    assert.ok(exists(path.join(h.adopted, '.credentials.json')), 'adopted token kept');
    assert.equal(read(path.join(h.adopted, 'projects', 'p', 'chat.jsonl')), '{"a":1}\n');
  } finally {
    fs.rmSync(h.home, { recursive: true, force: true });
  }
});

test('removes the data root when nothing of the user is left', () => {
  const h = makeHome();
  try {
    for (const d of [h.configured, h.mcp, h.stray]) fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(path.join(h.store, '.merge-backup'), { recursive: true, force: true });
    runHook(h);
    assert.ok(!exists(h.root), 'data root removed');
  } finally {
    fs.rmSync(h.home, { recursive: true, force: true });
  }
});

/** Asserts the hook left everything as it was. */
function assertUntouched(h) {
  assert.ok(exists(path.join(h.plain, '.credentials.json')));
  assert.ok(exists(path.join(h.created, '.credentials.json')));
  assert.ok(!exists(path.join(h.home, '.claude')), 'no account handed back');
}

test('does nothing while a copy is installed in another editor', () => {
  const h = makeHome();
  try {
    fs.mkdirSync(path.join(h.home, '.cursor', 'extensions', EXT_NAME), { recursive: true });
    runHook(h);
    assertUntouched(h);
  } finally {
    fs.rmSync(h.home, { recursive: true, force: true });
  }
});

test('does nothing while a copy is installed in a recorded extensions dir', () => {
  const h = makeHome();
  try {
    const custom = path.join(h.home, 'portable', 'extensions');
    fs.mkdirSync(path.join(custom, EXT_NAME), { recursive: true });
    write(path.join(h.root, '.installs.json'), JSON.stringify([h.extDir, custom]));
    runHook(h);
    assertUntouched(h);
  } finally {
    fs.rmSync(h.home, { recursive: true, force: true });
  }
});

test('does nothing while a newer copy sits next to it', () => {
  const h = makeHome();
  try {
    fs.mkdirSync(path.join(h.extDir, `${PKG.publisher}.${PKG.name}-99.0.0`));
    runHook(h);
    assertUntouched(h);
  } finally {
    fs.rmSync(h.home, { recursive: true, force: true });
  }
});

test('ignores a copy pending removal', () => {
  const h = makeHome();
  try {
    const old = `${PKG.publisher}.${PKG.name}-0.9.0`;
    fs.mkdirSync(path.join(h.extDir, old));
    write(path.join(h.extDir, '.obsolete'), JSON.stringify({ [old]: true }));
    runHook(h);
    assert.ok(!exists(h.plain), 'cleanup ran');
  } finally {
    fs.rmSync(h.home, { recursive: true, force: true });
  }
});

test('Keychain: hands the freshest account back and deletes only our items', { skip: WIN }, () => {
  const h = makeHome();
  try {
    // The configured window ran last: its token is the freshest.
    write(path.join(h.configured, '.credentials.json'), '{"token":"freshest"}');
    const old = new Date(Date.now() - 3600_000);
    for (const d of [h.plain, h.mcp, h.created]) fs.utimesSync(path.join(d, '.credentials.json'), old, old);
    const kc = intoKeychain(h, [h.plain, h.configured, h.mcp, h.created, h.adopted]);
    runHook(h, kc.env);

    const def = path.join(h.home, '.claude');
    const handed = kc.item(DEFAULT_SERVICE);
    assert.ok(handed, 'account handed back to Claude Code-credentials');
    assert.equal(Buffer.from(handed.hex, 'hex').toString(), '{"token":"freshest"}');
    assert.ok(!exists(path.join(def, '.credentials.json')), 'as an item, not a plaintext file');
    for (const d of [h.plain, h.configured, h.mcp, h.created]) assert.equal(kc.item(service(d)), undefined, `${d} item deleted`);
    assert.ok(kc.item(service(h.adopted)), "an adopted store's item is the user's: kept");
    assert.ok(!exists(h.plain), 'disposable working dir deleted');
    assert.ok(exists(path.join(h.configured, 'settings.json')), 'settings.json kept');
  } finally {
    fs.rmSync(h.home, { recursive: true, force: true });
  }
});

test('Keychain: a dir whose item could not be deleted is kept', { skip: WIN }, () => {
  const h = makeHome();
  try {
    const kc = intoKeychain(h, [h.plain, h.configured, h.mcp, h.created, h.adopted]);
    runHook(h, { ...kc.env, FAKE_SECURITY_LOCKED: '1' });
    // Its path is the only record of the item's name, so the dir stays.
    assert.ok(exists(h.plain), 'working dir kept');
    assert.ok(exists(h.created), 'created store kept');
    assert.ok(kc.item(service(h.plain)), 'nothing was deleted');
    // The history still made it home.
    assert.equal(read(path.join(h.home, '.claude', 'projects', 'p', 'chat.jsonl')), '{"a":1}\n');
  } finally {
    fs.rmSync(h.home, { recursive: true, force: true });
  }
});
