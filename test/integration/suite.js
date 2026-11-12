// Runs inside the VS Code extension host started by run.js.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

async function run() {
  const pkg = require('../../package.json');
  const ext = vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`);
  assert.ok(ext, 'extension is installed in the host');
  await ext.activate();
  assert.ok(ext.isActive, 'extension activated');

  const commands = await vscode.commands.getCommands(true);
  for (const c of pkg.contributes.commands) {
    assert.ok(commands.includes(c.command), `command registered: ${c.command}`);
  }

  const root = path.join(process.env.CMA_TEST_HOME, '.claude-alts');
  if (process.env.CMA_SCENARIO === 'beside_original') {
    // Inert, apart from copying the original's account into its own root.
    assert.ok(fs.existsSync(path.join(root, 'accounts', 'work', '.credentials.json')), 'account imported');
    assert.ok(fs.existsSync(path.join(root, 'accounts', 'work', '.claude-alts')), 'marked as ours');
    assert.ok(!fs.existsSync(path.join(root, '.installs.json')), 'nothing else written');
    assert.ok(!fs.existsSync(path.join(root, 'windows')), 'no working dir');
  } else {
    // A supported platform with nothing signed in: it runs for real, records its
    // install and keeps its data under its own root in the (throwaway) home.
    assert.ok(fs.existsSync(path.join(root, '.installs.json')), 'install recorded');
    const installs = JSON.parse(fs.readFileSync(path.join(root, '.installs.json'), 'utf-8'));
    // Windows hands out paths with either drive-letter case.
    const key = (p) => (process.platform === 'win32' ? path.normalize(p).toLowerCase() : path.normalize(p));
    const mine = key(path.dirname(ext.extensionPath));
    assert.ok(installs.some((d) => key(d) === mine), 'its extensions dir is listed');
  }

  // Commands that only show UI must not throw.
  await vscode.commands.executeCommand('claudeAlts.showLog');
  console.log(`integration (${process.env.CMA_SCENARIO}): activated, ${pkg.contributes.commands.length} commands registered`);
}

module.exports = { run };
