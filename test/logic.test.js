'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load } = require('./load');

// Tokens as files on every OS: a test must never reach the real macOS Keychain.
process.env.CLAUDE_ALTS_TOKEN_STORE = 'file';

const rules = load('rules');
const reclaim = load('reclaim');

test('gitRemotes reads remotes, not submodules', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-git-'));
  try {
    fs.mkdirSync(path.join(repo, '.git'));
    fs.writeFileSync(
      path.join(repo, '.git', 'config'),
      [
        '[core]',
        '\tbare = false',
        '[remote "origin"]',
        '\turl = git@github.com:me/app.git',
        '[submodule "lib"]',
        '\turl = https://github.com/other-org/lib.git',
        '[remote "upstream"]',
        '\turl = https://github.com/org/app',
      ].join('\n')
    );
    assert.deepEqual(rules.gitRemotes(repo), ['git@github.com:me/app.git', 'https://github.com/org/app']);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('gitRemotes is empty outside a repo', () => {
  assert.deepEqual(rules.gitRemotes(os.tmpdir()), []);
});

test('isClaudeExecutable knows both the bundled binary and the native install', () => {
  assert.ok(reclaim.isClaudeExecutable('/x/anthropic.claude-code-2.1.3/resources/native-binary/claude'));
  assert.ok(reclaim.isClaudeExecutable('/Users/a/.local/share/claude/versions/2.1.283'));
  assert.ok(!reclaim.isClaudeExecutable('/Applications/Claude.app/Contents/MacOS/Claude'));
  assert.ok(!reclaim.isClaudeExecutable('/usr/bin/versions'));
});
