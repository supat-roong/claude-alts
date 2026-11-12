import * as fs from 'fs';
import * as path from 'path';
import { Account } from './accounts';
import { allWorkingDirs, configFileOf } from './workdir';

/**
 * Per-account usage meters — read, never fetched.
 *
 * Claude Code caches the plan's usage in the config it already keeps per dir
 * (`cachedUsageUtilization` in `.claude.json`): utilization of the 5-hour session
 * window and the weekly one, with their reset times. Every dir an account runs in
 * (its store, each working copy) holds its own snapshot, so the freshest one
 * wins. This extension makes no network call of its own to get it: the numbers
 * are as fresh as Claude Code last left them, and say so.
 */

export interface Meter {
  /** 0–100 (can exceed 100 when over the limit). */
  percent: number;
  /** When the window resets, if known. */
  resetsAt?: Date;
}

export interface Usage {
  session?: Meter;
  weekly?: Meter;
  /** When Claude Code fetched these numbers. */
  fetchedAt: Date;
}

interface RawWindow {
  utilization?: number | null;
  resets_at?: string | null;
}
interface RawLimit {
  kind?: string;
  percent?: number | null;
  resets_at?: string | null;
}
interface RawUsage {
  fetchedAtMs?: number;
  accountUuid?: string;
  utilization?: {
    five_hour?: RawWindow | null;
    seven_day?: RawWindow | null;
    limits?: RawLimit[] | null;
  };
}

/** mtime-keyed cache: .claude.json can be large and the status bar repaints often. */
const cache = new Map<string, { mtimeMs: number; raw: RawUsage | null; email?: string; uuid?: string }>();

function readSnapshot(file: string): { raw: RawUsage | null; email?: string; uuid?: string } {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return { raw: null };
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit;
  let entry: { mtimeMs: number; raw: RawUsage | null; email?: string; uuid?: string } = { mtimeMs, raw: null };
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      cachedUsageUtilization?: RawUsage;
      oauthAccount?: { emailAddress?: string; accountUuid?: string };
    };
    entry = {
      mtimeMs,
      raw: cfg.cachedUsageUtilization ?? null,
      email: cfg.oauthAccount?.emailAddress,
      uuid: cfg.oauthAccount?.accountUuid,
    };
  } catch {
    /* unreadable or mid-write — no snapshot */
  }
  cache.set(file, entry);
  return entry;
}

function meter(percent: number | null | undefined, resetsAt: string | null | undefined): Meter | undefined {
  if (typeof percent !== 'number') return undefined;
  const at = resetsAt ? new Date(resetsAt) : undefined;
  // A window that has reset since the snapshot was taken is empty now.
  if (at && !Number.isNaN(at.getTime()) && at.getTime() <= Date.now()) return { percent: 0 };
  return { percent, resetsAt: at && !Number.isNaN(at.getTime()) ? at : undefined };
}

function parse(raw: RawUsage): Usage | undefined {
  if (!raw.utilization || typeof raw.fetchedAtMs !== 'number') return undefined;
  const u = raw.utilization;
  // Newer versions summarise the windows in `limits`; older ones only have the
  // named windows. Prefer the summary, fall back to the names.
  const limit = (kind: string) => u.limits?.find((l) => l.kind === kind);
  const s = limit('session');
  const w = limit('weekly_all');
  const session = s ? meter(s.percent, s.resets_at) : meter(u.five_hour?.utilization, u.five_hour?.resets_at);
  const weekly = w ? meter(w.percent, w.resets_at) : meter(u.seven_day?.utilization, u.seven_day?.resets_at);
  if (!session && !weekly) return undefined;
  return { session, weekly, fetchedAt: new Date(raw.fetchedAtMs) };
}

/** The freshest usage snapshot any dir running this account holds, if any. */
export function usageOf(account: Account, email: string | undefined): Usage | undefined {
  // Without an email nothing ties a working dir's snapshot to this account.
  const working = email ? allWorkingDirs().map((d) => path.join(d, '.claude.json')) : [];
  const files = [configFileOf(account.dir), ...working];
  let best: { raw: RawUsage; at: number } | undefined;
  for (const file of files) {
    const snap = readSnapshot(file);
    if (!snap.raw || typeof snap.raw.fetchedAtMs !== 'number') continue;
    // A working dir counts only while it runs this account — and when the
    // snapshot names an account, it must be this one.
    if (email && snap.email !== email) continue;
    if (snap.raw.accountUuid && snap.uuid && snap.raw.accountUuid !== snap.uuid) continue;
    if (!best || snap.raw.fetchedAtMs > best.at) best = { raw: snap.raw, at: snap.raw.fetchedAtMs };
  }
  return best ? parse(best.raw) : undefined;
}

/** The higher of the two meters — "how close is this account to a wall". */
export function peakPercent(u: Usage | undefined): number | undefined {
  if (!u) return undefined;
  const values = [u.session?.percent, u.weekly?.percent].filter((v): v is number => typeof v === 'number');
  return values.length ? Math.max(...values) : undefined;
}

function when(d: Date): string {
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function ago(d: Date): string {
  const min = Math.round((Date.now() - d.getTime()) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** "session 12% · weekly 40%" — for pickers. */
export function shortUsage(u: Usage | undefined): string {
  if (!u) return '';
  return [
    u.session ? `session ${Math.round(u.session.percent)}%` : '',
    u.weekly ? `weekly ${Math.round(u.weekly.percent)}%` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Markdown lines for the hover card, with reset times and the snapshot's age. */
export function usageMarkdown(u: Usage | undefined): string {
  if (!u) return '';
  const row = (name: string, m?: Meter) =>
    m ? `${name} **${Math.round(m.percent)}%**${m.resetsAt ? ` (resets ${when(m.resetsAt)})` : ''}` : '';
  const rows = [row('Session', u.session), row('Weekly', u.weekly)].filter(Boolean).join(' · ');
  return `$(pulse) ${rows}  \n_Usage as Claude Code last saw it, ${ago(u.fetchedAt)}._`;
}
