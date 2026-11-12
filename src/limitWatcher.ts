import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WindowBinding } from './binding';
import { defaultSourceDir } from './capture';
import { log } from './log';

/**
 * Notices when THIS window's account hits a usage limit, so the user can be
 * offered to continue with another account (see SetupWizard.offerContinue).
 *
 * The signal is Claude Code's own: when a request is refused for a limit, it
 * records the refusal in the conversation transcript as an assistant entry with
 * `"error":"rate_limit"` and the text it showed ("You've hit your session limit ·
 * resets 11pm"). Transcripts live in `<config dir>/projects/<sanitized cwd>/`,
 * and a workspace folder can be open in only one window, so the folder's own
 * transcript dir is this window's alone. Only top-level session files are
 * watched — a subagent's refusal also surfaces in its parent session.
 *
 * Only what is APPENDED after the watch starts counts: an old refusal in history
 * must never prompt anyone.
 */
export class LimitWatcher implements vscode.Disposable {
  private watcher?: fs.FSWatcher;
  private retry?: NodeJS.Timeout;
  private health?: NodeJS.Timeout;
  /** Bytes already seen per transcript file. */
  private readonly seen = new Map<string, number>();
  private readonly startedAt = Date.now();
  private baselined = false;

  constructor(
    private readonly binding: WindowBinding,
    private readonly onLimit: (message: string) => void
  ) {}

  start(): void {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) return; // no cwd → Claude Code keeps no per-project transcripts here
    const dir = path.join(
      this.binding.getEnvDir() ?? defaultSourceDir(),
      'projects',
      // Claude Code's own naming: every non-alphanumeric character becomes '-'.
      folder.replace(/[^a-zA-Z0-9]/g, '-')
    );
    this.watch(dir);
  }

  private watch(dir: string): void {
    let ino: number;
    try {
      ino = fs.statSync(dir).ino;
    } catch {
      // No conversation in this folder yet; check back now and then.
      this.retry = setTimeout(() => this.watch(dir), 30_000);
      return;
    }
    // Baseline, once: everything on disk when the window started is history,
    // not news. A folder that comes back later (Claude Code prunes empty project
    // folders) is read from the start — refusals older than the window are
    // still ignored by their timestamp.
    if (!this.baselined) {
      this.baselined = true;
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.jsonl')) this.seen.set(f, fs.statSync(path.join(dir, f)).size);
        }
      } catch {
        /* unreadable — every file starts from zero below, filtered by timestamp */
      }
    }
    try {
      this.watcher = fs.watch(dir, (_event, name) => {
        if (name && name.toString().endsWith('.jsonl')) this.scan(dir, name.toString());
      });
      this.watcher.on('error', () => this.rewatch(dir));
      log(`limit watcher: ${dir}`);
    } catch (err) {
      log(`limit watcher: cannot watch ${dir}: ${(err as Error).message}`);
      return;
    }
    // A watch on a deleted folder stays silent forever, even once the folder is
    // recreated. So check now and then that it's still the same folder.
    this.health = setInterval(() => {
      let now: number | undefined;
      try {
        now = fs.statSync(dir).ino;
      } catch {
        now = undefined;
      }
      if (now !== ino) this.rewatch(dir);
    }, 15_000);
  }

  private rewatch(dir: string): void {
    if (this.health) clearInterval(this.health);
    this.watcher?.close();
    this.watcher = undefined;
    // Same file names in a recreated folder are new files.
    this.seen.clear();
    this.watch(dir);
  }

  private scan(dir: string, name: string): void {
    const file = path.join(dir, name);
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    const from = this.seen.get(name) ?? 0;
    this.seen.set(name, size);
    if (size <= from) return;
    let fd: number | undefined;
    try {
      // Read only what was appended — transcripts grow to many megabytes.
      const len = Math.min(size - from, 256 * 1024);
      const buf = Buffer.alloc(len);
      fd = fs.openSync(file, 'r');
      fs.readSync(fd, buf, 0, len, size - len);
      for (const line of buf.toString('utf-8').split('\n')) {
        if (!line.includes('"rate_limit"')) continue;
        const msg = parseRefusal(line, this.startedAt);
        if (msg) this.onLimit(msg);
      }
    } catch {
      /* mid-write or gone — the next change event reads it */
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  dispose(): void {
    if (this.retry) clearTimeout(this.retry);
    if (this.health) clearInterval(this.health);
    this.watcher?.close();
  }
}

/** The text of a limit refusal recorded after `since`, or undefined. */
export function parseRefusal(line: string, since: number): string | undefined {
  try {
    const e = JSON.parse(line) as {
      type?: string;
      error?: string;
      timestamp?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    if (e.type !== 'assistant' || e.error !== 'rate_limit') return undefined;
    if (e.timestamp && Date.parse(e.timestamp) < since) return undefined;
    return e.message?.content?.find((c) => c.text)?.text ?? 'You hit a usage limit.';
  } catch {
    return undefined; // a partial line
  }
}
