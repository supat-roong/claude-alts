// Loads a src/*.ts module for tests: bundled by esbuild, with a stand-in for
// the `vscode` module, which only exists inside the editor.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');

const REPO = path.join(__dirname, '..');
const STUB = `
const config = { get: (_k, d) => d, update: async () => {} };
exports.window = { createOutputChannel: () => ({ appendLine() {}, show() {} }) };
exports.workspace = { getConfiguration: () => config, workspaceFolders: undefined };
exports.EventEmitter = class { fire() {} event() {} dispose() {} };
exports.ConfigurationTarget = { Global: 1 };
`;

function load(module, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-load-'))) {
  const stub = path.join(dir, 'node_modules', 'vscode');
  fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(path.join(stub, 'index.js'), STUB);
  const out = path.join(dir, `${module}.js`);
  esbuild.buildSync({
    entryPoints: [path.join(REPO, 'src', `${module}.ts`)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    outfile: out,
    logLevel: 'silent',
  });
  return require(out);
}

module.exports = { load };
