import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Account, AccountRegistry, readIdentity, hasCredentials } from './accounts';
import { describeTokenLocation, tokenState } from './credentials';
import { WindowBinding } from './binding';
import { getAuthStatus, AuthStatus } from './cli';
import { snapshotAccount, defaultSourceDir, mirrorToDefault } from './capture';
import { ensureSharedHistory } from './sharedHistory';
import { signOut, interruptSessions, dirsHoldingToken, canListSessions } from './reclaim';
import { refreshStore, allWorkingDirs, materialize, lastRanIn } from './workdir';
import { log } from './log';
import { accountsRoot } from './platform';
import { peakPercent, shortUsage, usageOf } from './usage';
import { defaultAccount, setDefaultAccount, setFolderRule } from './rules';
import { PALETTE, fullName, labelOf, nameFor, setLabel } from './labels';

/**
 * All the user-facing flows.
 *
 * The model, in one paragraph: an ACCOUNT is a store on disk (`~/.claude-<name>`)
 * plus its entry in the registry. A WINDOW never points at a store — it points at
 * a working dir of its own, stocked with a copy of the account it runs (see
 * workdir.ts for why that separation is load-bearing). Signing in inside a window
 * therefore rewrites only that window's working dir, and reconcile() simply
 * follows it: whatever account the window's dir now holds is the account that
 * window runs. Nothing else on disk, and no other window, is affected.
 */

/**
 * A message to show AFTER a window reload. A reload kills any toast raised just
 * before it, so news that has to outlive one goes here.
 */
export const NOTICE_KEY = 'claudeAlts.pendingNotice';

/** workspaceState: when this window last reloaded itself automatically. */
const RELOAD_STAMP_KEY = 'claudeAlts.lastAutoReload';

export class SetupWizard {
  constructor(
    private readonly registry: AccountRegistry,
    private readonly binding: WindowBinding,
    private readonly context: vscode.ExtensionContext
  ) {}

  /**
   * The ONLY way any flow in this extension reloads the window.
   *
   * Auto-reloads are decided from state that SURVIVES the reload (disk,
   * workspaceState), so a bug that leaves the trigger state in place turns
   * "reload to recover" into a reload LOOP — v1.2.1 shipped exactly that.
   * Two lines of defence, both mandatory:
   *
   *   1. Every auto-reload site must change the state it triggered on BEFORE
   *      calling this, so the same condition cannot re-fire after the reload.
   *   2. The circuit breaker here, per window (the stamps live in workspaceState,
   *      so they survive the reload): at most one AUTOMATIC reload of each KIND
   *      per minute, and no more than three different kinds within two minutes. A reload
   *      past either limit degrades to a message with a manual "Reload window"
   *      button — which breaks any loop a future bug could still construct, at
   *      the cost of one extra click.
   *
   *      Metering per kind is what lets two DIFFERENT legitimate reloads follow
   *      each other: the first-run setup reload used to swallow the sign-in that
   *      came right after it, leaving the window on the old account. A loop
   *      repeats one kind, which the per-kind limit still stops at once.
   *
   * `userInitiated` bypasses the breaker (an explicit switch/forget must always
   * act) but still stamps, so a follow-up automatic reload is metered.
   */
  private async requestWindowReload(
    notice: string | undefined,
    opts: { userInitiated?: boolean; kind?: string } = {}
  ): Promise<void> {
    const now = Date.now();
    const kind = opts.userInitiated ? 'user' : opts.kind ?? 'other';
    const stamps = this.context.workspaceState.get<Record<string, number>>(RELOAD_STAMP_KEY);
    // Pre-1.4 stored a single number; it reads as no history at all.
    const recent = Object.fromEntries(
      Object.entries(stamps && typeof stamps === 'object' ? stamps : {}).filter(([, t]) => now - t < 120_000)
    );
    const sameKind = recent[kind] !== undefined && now - recent[kind] < 60_000;
    const tooMany = Object.keys(recent).filter((k) => k !== 'user').length >= 3;
    if (!opts.userInitiated && (sameKind || tooMany)) {
      log(`auto-reload SUPPRESSED (${kind}; recent: ${JSON.stringify(recent)}): ${notice ?? ''}`);
      void vscode.window
        .showWarningMessage(
          `Claude Alts: ${notice ?? 'this window needs a reload to pick up its account.'} ` +
            `The automatic reload was skipped because one just happened.`,
          'Reload window'
        )
        .then((pick) => {
          if (pick === 'Reload window') {
            void vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        });
      return;
    }
    await this.context.workspaceState.update(RELOAD_STAMP_KEY, { ...recent, [kind]: now });
    if (notice) await this.context.globalState.update(NOTICE_KEY, notice);
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  /**
   * "Your account is gone — here's what to do next", with the do-it button
   * attached: a bare "sign in" message when saved accounts exist reads as a
   * dead end, even though switching is one click away.
   */
  private offerAccountPick(reason: string): void {
    const hasAccounts = this.registry.listUniqueByEmail().length > 0;
    void vscode.window
      .showInformationMessage(
        `Claude Alts: ${reason} ${
          hasAccounts
            ? 'Pick another saved account, or sign in with Claude Code (its account menu, or /login).'
            : 'Sign in with Claude Code (its account menu, or /login).'
        }`,
        ...(hasAccounts ? ['Switch account'] : [])
      )
      .then((pick) => {
        if (pick === 'Switch account') {
          void vscode.commands.executeCommand('claudeAlts.switchAccount');
        }
      });
  }

  // ─── Saving the account a window is signed in as ────────────────────────────

  /**
   * Saves the account currently signed in inside `sourceDir` and binds this
   * window to it. The email IS the account's identity — nothing to name, and an
   * account already known by that email is reused rather than copied again, so
   * signing in twice as the same user can never mint a duplicate.
   *
   * `silent` suppresses even the "not signed in" warning: reconcile() calls this
   * on a timer, where a signed-out dir is a normal state and not an error.
   */
  async captureCurrentAccount(
    opts: { quiet?: boolean; sourceDir?: string; silent?: boolean } = {}
  ): Promise<Account | undefined> {
    const sourceDir = opts.sourceDir ?? this.binding.getEnvDir() ?? defaultSourceDir();

    // The identity file already names the account, and the token file next to it
    // says it's signed in — that's everything we need. Asking the CLI instead
    // means spawning a login shell and a 250MB binary, whose cold start is why a
    // freshly signed-in account used to take half a minute to show up. The CLI is
    // still used for the deliberate "Save current account" command, where the user
    // is waiting on an answer and a definitive check is worth the wait.
    const identity = readIdentity(sourceDir);
    const status: AuthStatus | null =
      opts.silent && identity && hasCredentials(sourceDir)
        ? { loggedIn: true, email: identity.email, orgName: identity.organizationName }
        : await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Reading current Claude account…' },
            () => getAuthStatus(sourceDir)
          );

    if (!status?.loggedIn || !status.email) {
      if (!opts.silent) {
        vscode.window.showWarningMessage(
          'No signed-in Claude account detected in this window. Sign in with Claude Code first ' +
            '(Account menu → Login, or /login in a chat).'
        );
      }
      return undefined;
    }

    // Known account? Reuse its store — never a second copy of the same email.
    // Take the opportunity to freshen the store with the token now in use.
    const known = this.registry.savedForEmail(status.email);
    if (known) {
      known.email = status.email;
      await this.registry.add(known);
      refreshStore(known, sourceDir);
      await this.binding.bind(known);
      if (!opts.quiet) {
        vscode.window.showInformationMessage(`${status.email} — this window is bound to it.`);
      }
      return known;
    }

    // Forgotten before? Its store is still on disk (forget signs it out, it never
    // deletes), so restore the entry instead of inventing a second one.
    const restored = await this.registry.restoreForgotten(status.email);
    const target: Account =
      restored ??
      (() => {
        const name = suggestName(
          status.email!,
          (n) => !this.registry.get(n) && !fs.existsSync(path.join(accountsRoot(), n))
        );
        return { name, dir: path.join(accountsRoot(), name), email: status.email, origin: 'created' };
      })();

    try {
      snapshotAccount(sourceDir, target.dir, status);
    } catch (err) {
      vscode.window.showErrorMessage(`Could not save account: ${(err as Error).message}`);
      return undefined;
    }
    ensureSharedHistory([target.dir]);
    target.email = status.email;
    await this.registry.add(target);
    await this.binding.bind(target);
    if (!opts.quiet) {
      vscode.window.showInformationMessage(`Saved ${status.email} — this window is bound to it.`);
    }
    return target;
  }

  // ─── Keeping the window in step with what's on disk ─────────────────────────

  /**
   * Guards against overlapping runs. reconcile() is driven by three independent
   * triggers (activation, the file poll, window focus) and does slow async work,
   * so two runs in flight would save the same account twice.
   */
  private reconciling?: Promise<void>;

  async reconcile(opts: { atActivation?: boolean } = {}): Promise<void> {
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.reconcileOnce(opts).finally(() => {
      this.reconciling = undefined;
    });
    return this.reconciling;
  }

  private async reconcileOnce(opts: { atActivation?: boolean }): Promise<void> {
    // Re-read the account list off disk first. `globalState` is per-extension-host,
    // so an account saved or forgotten in ANOTHER window is invisible here until
    // this one restarts — which is why a newly added account never showed up in the
    // other window's Switch list. The stores on disk are the shared truth, so every
    // window converges on them: discover what appeared, drop what was signed out.
    await this.registry.discoverAndMerge();
    await this.registry.pruneSignedOut();

    // Once bound, this is the window's OWN working dir: no other window writes to
    // it, so everything below concerns this window alone. Before the first bind
    // it is still the default dir — that's where Claude Code is signed in out of
    // the box, and where a brand-new user's account is found.
    const dir = this.binding.getEnvDir() ?? defaultSourceDir();
    const onDefault = path.normalize(dir) === path.normalize(defaultSourceDir());

    // The account this window runs, however it was picked — a rule or the default
    // names an account only while it is saved, so ask the binding what it bound.
    const running = this.binding.getRunningName() ?? this.binding.getActiveName();

    const state = tokenState(dir);
    // A Keychain that can't be asked (locked, timed out) says nothing about this
    // window: concluding "signed out" from it would forget a good account. Wait
    // for the next trigger, by which time it may answer.
    if (state === 'unknown') {
      log(`reconcile: the sign-in of ${dir} can't be checked right now — nothing changed`);
      return;
    }
    if (state === 'absent') {
      const active = running;

      // The account is gone from disk entirely — it was FORGOTTEN, most likely from
      // another window (there is no API to reload someone else's window, so this is
      // how the news reaches us).
      if (active && !this.registry.get(active)) {
        // Release FIRST: the stale name survives a reload (workspaceState, repo
        // map), and reloading with it in place re-enters this branch forever.
        const wasRunningIt = Boolean(this.binding.getEnvDir());
        await this.binding.release();
        if (wasRunningIt) {
          // The window is sitting on a dir we just found emptied, with a dead
          // session and a panel naming an account that no longer exists —
          // nothing here worth keeping, so reload rather than ask.
          await this.requestWindowReload(
            `The account this window was running was forgotten and signed out.`,
            { kind: 'forgotten' }
          );
        } else {
          // The window merely REMEMBERED the forgotten account (it was closed
          // when the forget happened, so applyStored never bound it). Nothing
          // is running on it and a reload would change nothing — just point
          // the user at the way forward.
          this.offerAccountPick(`The account this window last used was forgotten and signed out.`);
        }
        return;
      }

      // Signed out, but the account still exists on disk ⇒ the user ran /logout in
      // THIS window. Careful, though: a dir is ALSO tokenless for the whole time a
      // sign-in is in flight — Claude Code deletes the old credentials before it
      // sends the user to the browser — and at this instant the two are
      // indistinguishable. Treating a sign-in as a logout would sign out a
      // perfectly good account while the user is away authorising.
      //
      // At ACTIVATION there is no ambiguity: an OAuth flow cannot survive a window
      // reload, so a dir still tokenless when the window comes up really is logged
      // out. That is the only moment it is safe to conclude anything.
      if (opts.atActivation) await this.handleLoggedOut(dir);
      return;
    }
    const email = readIdentity(dir)?.email;
    if (!email) return; // token but no identity yet — a sign-in mid-flight

    const active = this.binding.getActiveName();
    const bound = active ? this.registry.get(active) : undefined;
    if (bound?.email && bound.email !== email) {
      // The user signed in as someone else, in THIS window. There is nothing to
      // repair: the dir is this window's alone, so no other window was touched,
      // and the account that was here is safe in its own store — untouched,
      // because a window only ever runs a copy. Just follow the user.
      //
      // This is the payoff of per-window dirs. It used to take a shadow copy, a
      // restore, a guess at which window signed in, and a forced reload.
      log(`sign-in in this window: ${bound.email} → ${email}`);
    }

    const account =
      this.registry.savedForEmail(email) ??
      (await this.captureCurrentAccount({ quiet: true, silent: true, sourceDir: dir }));
    if (!account) return;

    // Keep the store's token from drifting far behind the one actually in use.
    refreshStore(account, dir);
    // And keep Claude Code's own default dir signed in as this account, so that
    // losing the extension — uninstalled, disabled, failed to activate — never
    // leaves the user with a signed-out Claude Code. The uninstall hook cannot
    // cover that: VSCode defers it to the next server start, and it may never run.
    // Only the FOCUSED window does it: with several windows on different accounts,
    // "the account this machine last used" is the one in front of the user, and
    // letting every window mirror its own made them overwrite each other forever.
    if (vscode.window.state.focused) mirrorToDefault(dir, readIdentity(dir));
    const changed = active !== account.name;
    if (changed) await this.binding.bind(account);

    // First run only: the window was still on the shared DEFAULT dir. It is bound
    // now, but Claude Code read the default at activation and won't look again —
    // so until a reload it keeps running there, where another window's sign-in
    // could still reach it. One reload moves it onto its own dir for good.
    if (onDefault) {
      await this.requestWindowReload(
        `${email} is set up. This window now runs it in a directory of its own — signing in to ` +
          `another account here will no longer disturb your other windows.`,
        { kind: 'setup' }
      );
    } else if (changed && active) {
      // The user signed in as a different account INSIDE this window. The bind
      // above only updates our side; Claude Code read this dir at activation and
      // won't look again — its panel still shows, and its running session still
      // bills, the OLD account. Without this reload the window looks switched
      // but isn't, and the Switch list marks the new account as "current" so
      // picking it is a no-op: "switch does nothing until I reload by hand".
      await this.requestWindowReload(
        `Signed in as ${email} — the window was reloaded so Claude Code fully switches to it.`,
        { kind: 'signin' }
      );
    }
  }

  /**
   * The user ran `/logout` in this window. That REVOKES the refresh token on
   * Anthropic's side — not just locally — so every copy of it is now a dead
   * credential, the account's store included. Leaving the account in the list
   * would be a lie: switching to it later would look signed in and fail on the
   * first request. Sign its store out and drop it, exactly as Forget would.
   *
   * Its data dir stays (nothing is deleted), so signing in again brings it back.
   */
  private async handleLoggedOut(dir: string): Promise<void> {
    const active = this.binding.getActiveName();
    const account = active ? this.registry.get(active) : undefined;
    if (!account) return;

    // A REAL logout deletes the token, clears oauthAccount from the dir's
    // config, and leaves that config file in place (Claude Code's own routine).
    // Anything else — identity still present, or no config file at all — is not
    // a logout but a working copy that failed to stock (an interrupted copy, a
    // full disk). The store is intact, so restock it; concluding "logout" here
    // would forget — and sign out — a perfectly good account over an IO hiccup.
    // And it must be a logout of THIS account: a dir emptied while it ran another
    // one (a folder rule now names a different account for the window) says
    // nothing about this one — concluding "logout" would forget an account the
    // user never touched.
    const ran = lastRanIn(dir);
    if (ran !== undefined && ran !== account.name && hasCredentials(account.dir)) {
      log(`working dir ${dir} was signed out of ${ran}, not ${account.name} — stocking it with ${account.name}`);
      materialize(account, dir, true);
      await this.requestWindowReload(
        `Started ${this.registry.emailOf(account) ?? account.name} in this window.`,
        { kind: 'restock' }
      );
      return;
    }
    const looksLikeRealLogout =
      !readIdentity(dir) && fs.existsSync(path.join(dir, '.claude.json'));
    if (!looksLikeRealLogout && hasCredentials(account.dir)) {
      log(`working dir ${dir} lost its token but kept its identity — restocking from ${account.name}`);
      materialize(account, dir, true);
      await this.requestWindowReload(
        `Restored ${this.registry.emailOf(account) ?? account.name} for this window.`,
        { kind: 'restock' }
      );
      return;
    }
    const email = this.registry.emailOf(account) ?? account.name;
    log(`logged out of ${email} in this window — its token is revoked everywhere`);

    await this.registry.forget(account);
    await this.binding.forget(account);
    // Every dir holding this (now revoked) token, not just the account's store:
    // the working copies AND Claude Code's default dir, which mirrorToDefault
    // keeps stocked. Missing the default one would leave the machine looking
    // signed in to an account whose token the server has already killed — it
    // would fail on the first request, with nothing on screen to explain why.
    const dirs = [
      ...dirsHoldingToken(email),
      ...allWorkingDirs().filter((d) => readIdentity(d)?.email === email),
    ];
    const failed = dirs.filter((d) => signOut(d) === 'failed');
    vscode.window.showInformationMessage(
      `Claude Alts: you signed out of ${email}, so it was removed from the list — a logout ` +
        `revokes the account everywhere, not just in this window. Sign in again to bring it back.` +
        (failed.length > 0
          ? ` Its (now revoked) token could not be deleted from: ${failed.map(describeTokenLocation).join(', ')}.`
          : '')
    );
  }

  // ─── Hitting a usage limit ──────────────────────────────────────────────────

  private lastLimitOffer = 0;

  /**
   * This window's account just hit a usage limit (see LimitWatcher). Offers to
   * continue with another saved account — the least used first, and none that
   * is itself at a limit — and does nothing unless the user picks one.
   *
   * Deliberately an OFFER, never an automatic switch: rotating accounts to stay
   * under limits is the user's call to make, each time. What makes the offer
   * cheap is the shared history: after the switch, the very conversation that
   * hit the wall is one click away in Claude Code's session list.
   */
  async offerContinue(refusal: string): Promise<void> {
    if (!vscode.workspace.getConfiguration('claudeAlts').get<boolean>('offerSwitchOnLimit', true)) return;
    // One refusal tends to come with several (retries, subagents); ask once.
    if (Date.now() - this.lastLimitOffer < 15 * 60_000) return;
    this.lastLimitOffer = Date.now();

    const dir = this.binding.getEnvDir() ?? defaultSourceDir();
    const current = readIdentity(dir)?.email;
    const candidates = this.registry
      .listUniqueByEmail()
      .map((a) => ({ account: a, email: this.registry.emailOf(a) }))
      .filter((c) => c.email !== current)
      .map((c) => ({ ...c, peak: peakPercent(usageOf(c.account, c.email)) }))
      .filter((c) => c.peak === undefined || c.peak < 100)
      .sort((x, y) => (x.peak ?? 50) - (y.peak ?? 50));
    log(`limit hit on ${current ?? '(unknown)'}: "${refusal}" — ${candidates.length} other account(s) to offer`);
    if (candidates.length === 0) return;

    const label = (c: (typeof candidates)[number]) =>
      `Continue as ${nameFor(c.email, c.account.name)}${c.peak !== undefined ? ` (${Math.round(c.peak)}% used)` : ''}`;
    const shown = candidates.slice(0, 2);
    const CHOOSE = 'Choose…';
    const NEVER = "Don't ask again";
    const pick = await vscode.window.showWarningMessage(
      `Claude Alts: ${current ?? 'this account'} — ${refusal}. Continue in this window with another ` +
        `account? It reloads the window; your conversations are shared, so reopen this one from ` +
        `Claude Code's session history.`,
      ...shown.map(label),
      ...(candidates.length > shown.length ? [CHOOSE] : []),
      NEVER
    );
    if (!pick) return;
    if (pick === NEVER) {
      await vscode.workspace
        .getConfiguration('claudeAlts')
        .update('offerSwitchOnLimit', false, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        'Claude Alts: you will not be asked again. Turn it back on with the "Offer Switch On Limit" setting.'
      );
      return;
    }
    if (pick === CHOOSE) {
      await this.switchAccountInteractive();
      return;
    }
    const chosen = shown.find((c) => label(c) === pick);
    if (chosen) await this.switchTo(chosen.account);
  }

  // ─── Switching this window's account ────────────────────────────────────────

  async switchAccountInteractive(): Promise<void> {
    const accounts = this.registry.listUniqueByEmail();
    if (accounts.length === 0) {
      vscode.window.showInformationMessage(
        'No accounts yet. Sign in with Claude Code and this window will remember the account automatically.'
      );
      return;
    }

    const activeName = this.binding.getActiveName();
    type Item = vscode.QuickPickItem & { account?: Account };
    const items: Item[] = accounts.map((a) => {
      const email = this.registry.emailOf(a);
      return {
        label: `${a.name === activeName ? '$(check) ' : '$(account) '}${nameFor(email, a.name)}`,
        description: [
          labelOf(email).label ? email : '',
          a.name === activeName ? 'current' : '',
          shortUsage(usageOf(a, email)),
        ]
          .filter(Boolean)
          .join(' · '),
        account: a,
      };
    });

    const picked = await vscode.window.showQuickPick(items, {
      title: 'Switch Claude account for this window (reloads the window)',
      placeHolder: 'Pick the account this window should use',
      // A labelled account shows its email in the description: typing it must still find it.
      matchOnDescription: true,
    });
    if (!picked?.account) return;
    if (picked.account.name === activeName) {
      // Never a silent no-op: to the user a click that does nothing is a bug.
      vscode.window.showInformationMessage(
        `${this.registry.emailOf(picked.account) ?? picked.account.name} is already this window's account.`
      );
      return;
    }
    await this.switchTo(picked.account);
  }

  /**
   * Stocks this window's working dir with the account and reloads.
   *
   * The reload is not a nicety: Claude Code reads CLAUDE_CONFIG_DIR once, when its
   * extension host activates, and keeps a long-lived process — a live swap would
   * be invisible to it, leaving the panel showing one account while every request
   * billed another. On reload this extension activates first (activation event
   * `*`) and the new account is already in place.
   */
  async switchTo(account: Account): Promise<void> {
    // Reloading onto an account whose store can't supply a sign-in would leave the
    // window on its OLD account while the status bar names the new one.
    if (!hasCredentials(account.dir)) {
      throw new Error(
        `the saved sign-in of ${this.registry.emailOf(account) ?? account.name} in ${account.dir} ` +
          `can't be read, so this window was not switched. Sign in to it again in Claude Code.`
      );
    }
    await this.binding.bind(account);
    await this.requestWindowReload(undefined, { userInitiated: true });
  }

  // ─── Rules and the default account ──────────────────────────────────────────

  /** Quick-picks a saved account; `extra` items are offered above them. */
  private async pickAccount(
    title: string,
    extra: Array<vscode.QuickPickItem & { id: string }> = []
  ): Promise<Account | string | undefined> {
    type Item = vscode.QuickPickItem & { account?: Account; id?: string };
    const items: Item[] = [
      ...extra,
      ...this.registry.listUniqueByEmail().map((a) => {
        const email = this.registry.emailOf(a);
        return {
          label: `$(account) ${nameFor(email, a.name)}`,
          description: [labelOf(email).label ? email : '', shortUsage(usageOf(a, email))].filter(Boolean).join(' · '),
          account: a,
        };
      }),
    ];
    if (items.length === extra.length) {
      vscode.window.showInformationMessage('No saved accounts yet. Sign in with Claude Code first.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(items, { title, matchOnDescription: true });
    return picked?.account ?? picked?.id;
  }

  /** "Always use an account for this folder" — writes a folder rule. */
  async addFolderRuleInteractive(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) {
      vscode.window.showInformationMessage('Open a folder first — a rule ties an account to a folder.');
      return;
    }
    const picked = await this.pickAccount(`Always use this account for ${path.basename(folder)}`);
    if (!picked || typeof picked === 'string') return;
    const email = this.registry.emailOf(picked) ?? picked.name;
    await setFolderRule(folder, email);
    log(`rule: ${folder} → ${email}`);
    if (picked.name === this.binding.getActiveName()) {
      vscode.window.showInformationMessage(`${path.basename(folder)} will always open with ${email}.`);
      return;
    }
    const now = await vscode.window.showInformationMessage(
      `${path.basename(folder)} will always open with ${email}. Switch this window to it now?`,
      'Switch now'
    );
    if (now === 'Switch now') await this.switchTo(picked);
  }

  /** The account a brand-new window starts with (instead of the last one used). */
  async setDefaultAccountInteractive(): Promise<void> {
    const current = defaultAccount();
    const picked = await this.pickAccount('Account for new windows', [
      {
        id: '',
        label: '$(history) The last account used',
        description: current ? '' : 'current setting',
        detail: 'A new window starts on whichever account was used most recently, anywhere.',
      },
    ]);
    if (picked === undefined) return;
    const value = typeof picked === 'string' ? undefined : this.registry.emailOf(picked) ?? picked.name;
    await setDefaultAccount(value);
    vscode.window.showInformationMessage(
      value ? `New windows will start with ${value}.` : 'New windows will start with the last account used.'
    );
  }

  /** Gives an account a short display name and a colour. */
  async labelAccountInteractive(): Promise<void> {
    const dir = this.binding.getEnvDir() ?? defaultSourceDir();
    const here = this.registry.savedForEmail(readIdentity(dir)?.email ?? '');
    const picked = here
      ? here
      : await this.pickAccount('Name and colour which account?');
    if (!picked || typeof picked === 'string') return;
    const email = this.registry.emailOf(picked);
    if (!email) return;
    const current = labelOf(email);
    const label = await vscode.window.showInputBox({
      title: `Name for ${email}`,
      prompt: 'Shown in the status bar and the account lists. Leave empty to show the email.',
      value: current.label ?? '',
    });
    if (label === undefined) return;
    const colors = PALETTE.map((c) => ({
      label: c.name,
      description: c.id === current.color ? 'current' : '',
      id: c.id,
    }));
    const color = await vscode.window.showQuickPick(
      [...colors, { label: 'Custom…', description: 'a hex colour like #3b82f6', id: 'custom' }],
      { title: `Colour for ${label || email}` }
    );
    if (!color) return;
    let colorId = color.id;
    if (colorId === 'custom') {
      colorId = await vscode.window.showInputBox({
        title: 'Hex colour',
        value: current.color?.startsWith('#') ? current.color : '#',
        validateInput: (v) => (/^#[0-9a-f]{6}$/i.test(v) ? undefined : 'Like #3b82f6'),
      });
      if (colorId === undefined) return;
    }
    await setLabel(email, { label: label.trim() || undefined, color: colorId });
  }

  // ─── Forgetting an account ──────────────────────────────────────────────────

  async removeAccountInteractive(): Promise<void> {
    const accounts = this.registry.listUniqueByEmail();
    if (accounts.length === 0) {
      vscode.window.showInformationMessage('No accounts to forget.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      accounts.map((a) => ({
        label: fullName(this.registry.emailOf(a), a.name),
        description: a.dir,
        account: a,
      })),
      {
        title: 'Forget a saved account',
        placeHolder: 'Pick an account to sign out and remove from the list',
      }
    );
    if (!picked) return;

    const email = this.registry.emailOf(picked.account) ?? picked.account.name;
    const choice = await vscode.window.showWarningMessage(
      `Forget ${email}?\n\n` +
        `• It's removed from this extension's list.\n` +
        `• Its OAuth token is deleted from every copy on disk — the account is signed out ` +
        `everywhere, including any window running it.\n` +
        (canListSessions()
          ? `• Active Claude Code sessions on it, in ANY window, are interrupted.\n`
          : `• Claude Code chats still running on it keep going until you close them: ` +
            `Windows doesn't let extensions find them.\n`) +
        `• History, settings and its data folder stay on disk; signing in again restores it.`,
      { modal: true },
      'Forget'
    );
    if (choice !== 'Forget') return;

    const copies = this.registry
      .list()
      .filter((a) => this.registry.emailOf(a) === this.registry.emailOf(picked.account));

    // Fail CLOSED. The account's own store goes first — no session runs there, so
    // nothing can write the token back — and if it can't be signed out, stop
    // before anything else changes. Forgetting the entry anyway would leave a live
    // credential on disk under an account the list says is gone.
    const stuck = copies.filter((c) => signOut(c.dir) === 'failed');
    if (stuck.length > 0) {
      throw new Error(
        `could not delete the sign-in of ${email} in ${stuck.map((c) => describeTokenLocation(c.dir)).join(', ')}, ` +
          `so it was not forgotten. Check that it can be changed (an unlocked Keychain, the folder's ` +
          `permissions) and try again.`
      );
    }

    // Was THIS window running it? Decide before the binding is released.
    const usedHere = copies.some((c) => c.name === this.binding.getActiveName());

    for (const copy of copies) {
      await this.registry.forget(copy);
      await this.binding.forget(copy);
    }

    // Sign the account out of EVERY other dir holding it: the default dir (where a
    // sign-in may have left the original), and every window's working copy.
    // Missing any one of them leaves the account still signed in somewhere, and a
    // reloaded window would quietly restore itself from it.
    const dirs = [
      ...dirsHoldingToken(email),
      ...allWorkingDirs().filter((d) => readIdentity(d)?.email === email),
      ...copies.map((c) => c.dir),
    ];
    // Kill live sessions FIRST, and with SIGKILL: on a graceful shutdown Claude
    // Code flushes its in-memory token back to disk, undoing the delete.
    const interrupted = interruptSessions(dirs);
    const failed = [...new Set(dirs)].filter((d) => signOut(d) === 'failed');

    const parts = [`Forgot ${email}.`];
    parts.push(
      failed.length > 0
        ? `Its sign-in could NOT be deleted from: ${failed.map(describeTokenLocation).join(', ')}. ` +
            `Delete it there by hand.`
        : `It is signed out everywhere on this machine; history and settings stay on disk.`
    );
    if (interrupted > 0) {
      parts.push(`Interrupted ${interrupted} active session${interrupted > 1 ? 's' : ''}.`);
    } else if (!canListSessions()) {
      parts.push(`Close any Claude Code chat still running on it: Windows doesn't let extensions find them.`);
    }

    // If this window was running it, reload: Claude Code only reads its account at
    // activation, so otherwise the window sits on a dir we just emptied, with a
    // dead session and a panel still naming an account that no longer exists.
    if (usedHere) {
      await this.requestWindowReload(parts.join(' '), { userInitiated: true });
      return;
    }
    vscode.window.showInformationMessage(parts.join(' '));
  }
}

/**
 * Derives a directory slug from an email. Tries the local part first; if that is
 * taken (same local part, different domain — daniil@gmail.com vs daniil@work.dev)
 * it disambiguates with the domain rather than an opaque counter: `daniil`, then
 * `daniil-work-dev`. A numeric suffix is the last resort only.
 */
function suggestName(email: string, available: (n: string) => boolean): string {
  const slug = (s: string) =>
    s.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'account';
  const [local = 'account', domain = ''] = email.split('@');
  const candidates = [slug(local), domain ? slug(`${local}-${domain}`) : ''].filter(Boolean);
  for (const c of candidates) if (available(c)) return c;
  for (let i = 2; i < 100; i++) if (available(`${candidates[0]}${i}`)) return `${candidates[0]}${i}`;
  return candidates[0];
}
