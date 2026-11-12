// Generates the external-terminal helpers (src/shell.ts) for awkward account
// names and paths, then runs them in real shells: bash and zsh where present,
// PowerShell 7 (pwsh) and Windows PowerShell 5.1 where present.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { load } = require('./load');

function has(cmd) {
  const ps = cmd === 'pwsh' || cmd === 'powershell';
  // The extension offers the bash/zsh helper everywhere but Windows (see extension.ts).
  if (!ps && process.platform === 'win32') return false;
  return spawnSync(cmd, ps ? ['-NoProfile', '-Command', 'exit 0'] : ['-c', 'exit 0']).status === 0;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "cma shell o'brien ё-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const shell = load('shell', home);

// Names and dirs chosen to break naive quoting: a quote, a curly quote, a space,
// and a Cyrillic letter whose UTF-8 bytes (D1 91) read as a quote in cp1252.
const accounts = [
  { name: "o'brien", email: 'ob@x.com', dir: path.join(home, "acc o'brien") },
  { name: 'work', email: 'ё@x.com', dir: path.join(home, 'acc ё work') },
  { name: 'Work', email: 'w2@x.com', dir: path.join(home, 'acc W2') },
  { name: 'curly', email: 'c@x.com', dir: path.join(home, 'acc ’curly’') },
];
shell.writeShellHelpers(accounts);

test('the PowerShell helper starts with a BOM', () => {
  const bytes = fs.readFileSync(shell.powershellScript());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

for (const sh of ['bash', 'zsh']) {
  test(`${sh}: claude-use sets the account's dir`, { skip: !has(sh) }, () => {
    for (const key of ["o'brien", 'ob@x.com', 'ё@x.com', 'curly']) {
      const want = accounts.find((a) => a.name === key || a.email === key).dir;
      const got = execFileSync(sh, ['-c', `${shell.sourceLine('posix')}\nclaude-use "$1" && printf %s "$CLAUDE_CONFIG_DIR"`, sh, key], {
        encoding: 'utf-8',
      });
      assert.equal(got, want, key);
    }
  });

  test(`${sh}: unknown account fails`, { skip: !has(sh) }, () => {
    const r = spawnSync(sh, ['-c', `${shell.sourceLine('posix')}\nclaude-use nobody`]);
    assert.equal(r.status, 1);
  });
}

for (const ps of ['pwsh', 'powershell']) {
  test(`${ps}: claude-use sets the account's dir`, { skip: !has(ps) }, () => {
    const out = path.join(home, `${ps}-out.txt`);
    // Keys go in as ASCII; the dirs they resolve to carry the awkward characters.
    for (const key of ["o'brien", 'work', 'curly']) {
      const want = accounts.find((a) => a.name === key).dir;
      const cmd =
        `$ErrorActionPreference = 'Stop'; ${shell.sourceLine('powershell')}; ` +
        `claude-use '${key.replace(/'/g, "''")}'; ` +
        `[IO.File]::WriteAllText('${out.replace(/'/g, "''")}', $env:CLAUDE_CONFIG_DIR, [Text.UTF8Encoding]::new($false))`;
      execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', cmd], { stdio: 'pipe' });
      assert.equal(fs.readFileSync(out, 'utf-8'), want, key);
    }
  });
}

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
