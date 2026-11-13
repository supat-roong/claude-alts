#!/usr/bin/env node
// A stand-in for macOS's /usr/bin/security, covering the subcommands the
// extension uses. Items live in the JSON file named by FAKE_SECURITY_DB, so the
// Keychain code path runs on any OS without touching a real Keychain.
// FAKE_SECURITY_LOCKED=1 makes every call answer like a locked Keychain (36).
'use strict';

const fs = require('fs');

const DB = process.env.FAKE_SECURITY_DB;
const load = () => {
  try {
    return JSON.parse(fs.readFileSync(DB, 'utf-8'));
  } catch {
    return {};
  }
};
const save = (db) => fs.writeFileSync(DB, JSON.stringify(db, null, 2));
const key = (a, s) => `${a}\u0000${s}`;

/** `-a A -s S -w -X H -U` → { a, s, w, X, U }. */
function flags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const f = args[i].replace(/^-/, '');
    if (['w', 'U'].includes(f)) out[f] = true;
    else out[f] = args[++i];
  }
  return out;
}

/** Splits one `security -i` line the way its shell-like parser does (double quotes only). */
function words(line) {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]));
}

function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function run(cmd, args) {
  if (process.env.FAKE_SECURITY_LOCKED === '1') return 36;
  const f = flags(args);
  const db = load();
  const k = key(f.a, f.s);
  switch (cmd) {
    case 'find-generic-password': {
      const item = db[k];
      if (!item) return 44;
      if (f.w) process.stdout.write(`${Buffer.from(item.hex, 'hex').toString('utf-8')}\n`);
      else
        process.stdout.write(
          `keychain: "fake"\nattributes:\n    "acct"<blob>="${f.a}"\n` +
            `    "mdat"<timedate>=0x00  "${stamp(item.mdat)}\\000"\n    "svce"<blob>="${f.s}"\n`
        );
      return 0;
    }
    case 'add-generic-password': {
      if (db[k] && !f.U) return 45; // errSecDuplicateItem
      db[k] = { hex: f.X, mdat: Number(process.env.FAKE_SECURITY_NOW) || Date.now() };
      save(db);
      return 0;
    }
    case 'delete-generic-password': {
      if (!db[k]) return 44;
      delete db[k];
      save(db);
      return 0;
    }
    default:
      return 1;
  }
}

const argv = process.argv.slice(2);
if (argv[0] === '-i') {
  const [cmd, ...rest] = words(fs.readFileSync(0, 'utf-8').trim());
  process.exit(run(cmd, rest));
}
process.exit(run(argv[0], argv.slice(1)));
