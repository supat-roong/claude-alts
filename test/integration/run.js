// Starts a real VS Code with this extension and runs suite.js inside it. The
// editor gets a throwaway home, user data and extensions dir, so nothing of the
// machine's own Claude setup is read or touched.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

// Run from inside an editor (a VS Code terminal, a Claude Code session) this
// process inherits ELECTRON_RUN_AS_NODE, which starts VS Code as plain Node, and
// that window's CLAUDE_CONFIG_DIR, which would point the extension at a real
// account. Drop them all.
for (const k of Object.keys(process.env)) {
  if (/^(ELECTRON|VSCODE|CLAUDE|ANTHROPIC)_/.test(k)) delete process.env[k];
}

/** Each scenario starts its own editor on its own throwaway home. */
const SCENARIOS = {
  // Nothing signed in: the extension runs for real.
  fresh: () => {},
  // Claude Parallel Accounts installed with a saved account: the extension
  // stays inert, but copies the account first.
  beside_original: (home) => {
    fs.mkdirSync(path.join(home, '.vscode', 'extensions', 'dercasdrol.claude-parallel-accounts-1.3.2'), {
      recursive: true,
    });
    const store = path.join(home, '.claude-work');
    fs.mkdirSync(store);
    fs.writeFileSync(path.join(store, '.credentials.json'), '{}');
    fs.writeFileSync(path.join(store, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'w@x.com' } }));
    fs.mkdirSync(path.join(home, '.claude-windows'));
    fs.writeFileSync(path.join(home, '.claude-windows', '.manifest.json'), JSON.stringify({ stores: [store] }));
  },
};

async function scenario(name, setup) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-int-'));
  const home = path.join(tmp, 'home');
  const workspace = path.join(tmp, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  setup(home);
  try {
    await runTests({
      extensionDevelopmentPath: path.join(__dirname, '..', '..'),
      extensionTestsPath: path.join(__dirname, 'suite.js'),
      launchArgs: [
        workspace,
        '--disable-extensions',
        '--disable-workspace-trust',
        // macOS looks for the login Keychain under $HOME, and the fake home has
        // none: without this VS Code stops at a modal "keychain not found".
        '--use-mock-keychain',
        '--user-data-dir',
        path.join(tmp, 'data'),
        '--extensions-dir',
        path.join(tmp, 'ext'),
      ],
      // Tokens as files: the fake home has no Keychain, and a test must never
      // reach the real one. The Keychain path has its own tests (test/keychain.test.js).
      extensionTestsEnv: {
        HOME: home,
        USERPROFILE: home,
        CMA_TEST_HOME: home,
        CMA_SCENARIO: name,
        CLAUDE_ALTS_TOKEN_STORE: 'file',
      },
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  for (const [name, setup] of Object.entries(SCENARIOS)) await scenario(name, setup);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
