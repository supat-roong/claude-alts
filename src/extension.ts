import * as vscode from 'vscode';
import { AccountRegistry, importFromOriginal } from './accounts';
import { WindowBinding } from './binding';
import { StatusBarManager } from './statusBar';
import { SetupWizard, NOTICE_KEY } from './setupWizard';
import { ensureSharedHistory } from './sharedHistory';
import { defaultSourceDir } from './capture';
import { AccountWatcher } from './accountWatcher';
import { LimitWatcher } from './limitWatcher';
import { defaultAccount, ruleAccountFor } from './rules';
import { posixScript, powershellScript, sourceLine, writeShellHelpers } from './shell';
import { allWorkingDirs, workingRoot } from './workdir';
import { log, showLog } from './log';
import {
  credentialsInKeychain,
  installedInAnyEditor,
  isSupportedPlatform,
  ORIGINAL,
  recordInstall,
  SECURE_ENV_VAR,
} from './platform';

/**
 * Everything this extension does rests on semantics we verified: Claude Code
 * keeping credentials as files, and links for shared history. On any other OS —
 * or on a Mac whose Claude Code keeps its sign-in in the Keychain — those
 * assumptions silently break, up to destructive misbehaviour (e.g. the registry
 * pruning every account because it sees no credential files). So there the
 * extension must not guess: it activates into an INERT mode that touches nothing
 * and says why.
 *
 * The check runs where the extension actually executes — in a WSL/SSH/container
 * window that's the REMOTE side (extensionKind "workspace"), so a Windows
 * desktop driving a Linux remote is fully supported and never lands here.
 */
function activateUnsupported(context: vscode.ExtensionContext, original: boolean): void {
  const keychain = !original && credentialsInKeychain();
  const msg = original
    ? `Claude Parallel Accounts is installed. Both extensions link Claude Code's history to their own ` +
      `store, so only one can run. Uninstall Claude Parallel Accounts (in every editor on this machine) ` +
      `and reload: your saved accounts have been copied over, and your conversations follow. Until ` +
      `then Claude Alts stays inactive and changes nothing else.`
    : keychain
    ? `Claude Code on this Mac keeps its sign-in in the Keychain, which Claude Alts doesn't ` +
      `support: it only works where Claude Code keeps it in ~/.claude/.credentials.json. It stays ` +
      `inactive here: no files are read or written, no accounts are touched.`
    : `Claude Alts supports Linux, macOS and Windows — including WSL, Remote-SSH and dev ` +
      `containers. On ${process.platform} it stays inactive: no files are read or written, no accounts ` +
      `are touched.`;
  // Its uninstall deletes the accounts it saved, and may run before this
  // extension next activates for real, so copy them now (see importFromOriginal).
  if (original) importFromOriginal();
  log(
    `${original ? 'Claude Parallel Accounts is installed' : keychain ? 'Keychain-backed Mac is unsupported' : `platform ${process.platform} is unsupported`} — inert mode, nothing will be touched`
  );

  const item = vscode.window.createStatusBarItem(
    'claudeAlts.status',
    vscode.StatusBarAlignment.Right,
    90
  );
  item.name = 'Claude Account';
  item.text = `$(account) Claude: ${original ? 'two account extensions' : keychain ? 'Keychain not supported' : 'unsupported OS'}`;
  const tooltip = new vscode.MarkdownString(`$(account) **Claude Alts**\n\n${msg}`);
  tooltip.supportThemeIcons = true;
  item.tooltip = tooltip;
  item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  item.command = 'claudeAlts.showStatus';
  item.show();

  // The commands stay registered so palette entries and keybindings don't die
  // with a cryptic "command not found" — they all explain the same thing.
  const explain = () => {
    if (!original) return void vscode.window.showInformationMessage(msg);
    void vscode.window.showWarningMessage(msg, 'Show it').then((pick) => {
      if (pick) void vscode.commands.executeCommand('workbench.extensions.search', `@installed ${ORIGINAL.id}`);
    });
  };
  context.subscriptions.push(
    item,
    vscode.commands.registerCommand('claudeAlts.switchAccount', explain),
    vscode.commands.registerCommand('claudeAlts.captureAccount', explain),
    vscode.commands.registerCommand('claudeAlts.removeProfile', explain),
    vscode.commands.registerCommand('claudeAlts.showStatus', explain),
    vscode.commands.registerCommand('claudeAlts.showLog', () => showLog()),
    vscode.commands.registerCommand('claudeAlts.addFolderRule', explain),
    vscode.commands.registerCommand('claudeAlts.setDefaultAccount', explain),
    vscode.commands.registerCommand('claudeAlts.labelAccount', explain),
    vscode.commands.registerCommand('claudeAlts.setupShell', explain)
  );
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Checked first: the original's mere presence is reason enough, on any platform.
  const original =
    isSupportedPlatform() && (!!vscode.extensions.getExtension(ORIGINAL.id) || installedInAnyEditor(ORIGINAL.id));
  if (original || !isSupportedPlatform() || credentialsInKeychain()) {
    activateUnsupported(context, original);
    return;
  }
  // A credential slot inherited from whatever launched VSCode (a shell that had
  // it exported) would pin EVERY window's Claude Code to one token, whatever
  // account the window is bound to. Only this extension may set it, per window.
  if (process.env[SECURE_ENV_VAR] !== undefined) {
    log(`dropped inherited ${SECURE_ENV_VAR}=${process.env[SECURE_ENV_VAR]}`);
    delete process.env[SECURE_ENV_VAR];
  }
  recordInstall(context.extensionPath);

  const registry = new AccountRegistry(context);
  const binding = new WindowBinding(context);
  const wizard = new SetupWizard(registry, binding, context);
  const statusBar = new StatusBarManager(registry, binding);

  // A forgotten account no longer resolves, so a window that remembered one
  // comes up signed out on its own working dir (see applyStored). The user then
  // either picks another account from the list, or signs in to a new one in
  // Claude Code and we capture it.
  const resolveAccount = (name: string) => registry.get(name);
  // Settings name accounts by email (or saved name); the binding works in names.
  const nameOf = (id: string | undefined) => (id ? (registry.get(id) ?? registry.savedForEmail(id))?.name : undefined);
  binding.setPolicy({
    ruleName: () => nameOf(ruleAccountFor(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)),
    defaultName: () => nameOf(defaultAccount()),
  });

  // Bind this window to its remembered account FIRST and synchronously, so
  // process.env.CLAUDE_CONFIG_DIR is set before Claude Code spawns `claude`
  // (both extensions activate on startup — minimise the race window).
  let bound = binding.applyStored(resolveAccount);

  // ── The critical fix ───────────────────────────────────────────────────────
  // The machine-scoped `claudeCode.environmentVariables` setting is shared by
  // every window on this host; if it defines CLAUDE_CONFIG_DIR it overrides our
  // per-window process.env and forces all windows onto one account. Clear it so
  // isolation flows through process.env instead.
  const cleared = await binding.clearMachineOverride();

  // Keep the external-terminal helpers (shell.ts) in step with the account list.
  const writeHelpers = () =>
    writeShellHelpers(
      registry.listUniqueByEmail().map((a) => ({ name: a.name, email: registry.emailOf(a), dir: a.dir }))
    );
  context.subscriptions.push(registry.onDidChange.event(writeHelpers));

  // Pick up any accounts already logged in on disk, then retry binding in case
  // the remembered account was only discovered just now.
  await registry.discoverAndMerge();
  if (!bound) bound = binding.applyStored(resolveAccount);

  // One history, in one store, symlinked from every dir — the same single history
  // vanilla Claude Code has. Do this BEFORE Claude Code reads the dir, otherwise
  // the first paint of the panel would show empty history.
  //
  // This is not a "share between accounts" feature, it is what keeps history from
  // being LOST: a window runs on its own working dir, which starts out empty, so
  // without the links every conversation the user ever had (they live in the
  // default ~/.claude) would simply disappear from the panel the moment this
  // extension was installed. Hence no setting to turn it off — an off switch only
  // ever meant "fragment my history across N directories", which is why it also
  // used to copy the entire store into each of them.
  //
  // Forgotten accounts' dirs are included: they stay on disk and their history is
  // the user's. Working dirs MUST be in here — a window's conversations live in
  // the dir it actually runs on.
  const allDirs = (): string[] => [
    defaultSourceDir(),
    ...registry.list().map((a) => a.dir),
    ...registry.listForgotten().map((a) => a.dir),
    ...allWorkingDirs(),
  ];
  const warnings = ensureSharedHistory(allDirs());
  if (warnings.length > 0) {
    vscode.window.showWarningMessage(
      `Claude Alts: shared history migration hit ${warnings.length} issue(s); ` +
        `will retry on next reload. First: ${warnings[0]}`
    );
  }

  log(
    `activated: env=${process.env.CLAUDE_CONFIG_DIR ?? '(default)'} ` +
      `active=${binding.getRunningName() ?? binding.getActiveName() ?? '(none)'} ` +
      `accounts=${registry.list().length} forgotten=${registry.listForgotten().length} ` +
      `clearedSettingsOverride=${cleared}`
  );

  // A command that dies silently reads as "the button does nothing" — every
  // handler logs and SHOWS its errors instead. Registration itself is also
  // guarded: a duplicate copy of this extension (e.g. the same code published
  // under another publisher) registering the same command IDs used to crash
  // activation halfway and leave a dead status bar button.
  const conflicts: string[] = [];
  const cmd = (id: string, fn: () => Promise<unknown> | unknown): vscode.Disposable => {
    try {
      return vscode.commands.registerCommand(id, async () => {
        log(`command: ${id}`);
        try {
          await fn();
        } catch (err) {
          // A flow that ends in a window reload is torn down mid-await, and VSCode
          // rejects the pending call with "Canceled". The command did its job —
          // logging it as an ERROR made every successful switch look like a failure.
          if ((err as Error).name === 'Canceled' || err instanceof vscode.CancellationError) {
            log(`${id}: interrupted by the window reload`);
            return;
          }
          log(`ERROR in ${id}: ${(err as Error).stack ?? String(err)}`);
          const pick = await vscode.window.showErrorMessage(
            `Claude Alts: ${(err as Error).message}`,
            'Show log'
          );
          if (pick === 'Show log') showLog();
        }
      });
    } catch (err) {
      conflicts.push(id);
      log(`FAILED to register ${id}: ${(err as Error).message}`);
      return new vscode.Disposable(() => undefined);
    }
  };

  context.subscriptions.push(
    cmd('claudeAlts.switchAccount', () => wizard.switchAccountInteractive()),
    cmd('claudeAlts.captureAccount', () => wizard.captureCurrentAccount()),
    cmd('claudeAlts.removeProfile', () => wizard.removeAccountInteractive()),
    cmd('claudeAlts.showStatus', () => statusBar.onClick()),
    cmd('claudeAlts.showLog', () => showLog()),
    cmd('claudeAlts.addFolderRule', () => wizard.addFolderRuleInteractive()),
    cmd('claudeAlts.setDefaultAccount', () => wizard.setDefaultAccountInteractive()),
    cmd('claudeAlts.labelAccount', () => wizard.labelAccountInteractive()),
    cmd('claudeAlts.setupShell', () => setupShellInteractive()),
    // Only the focused window repairs a dir whose account was replaced by a
    // sign-in (it's the window the user signed in from). So a window that was
    // unfocused while that happened must reconcile when focus comes back —
    // otherwise a handoff nobody was around to finish would sit unrepaired.
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) void wizard.reconcile().finally(() => statusBar.reconfirm());
    }),
    statusBar
  );

  statusBar.initialize();

  // When this window's account state changes on disk (a /login or /logout inside
  // this window, or a forget from another one), reconcile: mirror the token into
  // its shadow copy, save a newly-seen account, and — if a sign-in landed on top
  // of the account this dir held — move the new account into a dir of its own and
  // restore the displaced one. Then repaint the bar so it never lags behind.
  const watcher = new AccountWatcher(binding, () => {
    void wizard.reconcile().finally(() => statusBar.reconfirm());
  });
  watcher.start();
  context.subscriptions.push(watcher);

  // A usage limit hit in this window → offer (never force) another account.
  const limits = new LimitWatcher(binding, (refusal) => void wizard.offerContinue(refusal));
  limits.start();
  context.subscriptions.push(limits);

  if (conflicts.length > 0) {
    void vscode.window
      .showErrorMessage(
        `Claude Alts: another extension already owns ${conflicts.length} of this extension's ` +
          `commands — most likely a duplicate copy under a different publisher. ` +
          `Uninstall the duplicate and reload the window.`,
        'Show extensions'
      )
      .then((pick) => {
        if (pick === 'Show extensions') {
          void vscode.commands.executeCommand('workbench.extensions.search', 'claude alts');
        }
      });
  }

  if (cleared) {
    vscode.window.showInformationMessage(
      'Claude Alts: removed CLAUDE_CONFIG_DIR from the shared machine setting. ' +
        'Isolation now works per-window. Pick this window\'s account from the status bar.'
    );
  }

  // Bring this window in step with what's on disk: save the account it's signed
  // in as (no "Save" click), and follow a sign-in that changed which account its
  // dir holds. Runs after the synchronous env binding above, so it never delays
  // the critical activation race with Claude Code.
  await wizard.reconcile({ atActivation: true });
  // reconcile() may have just bound this window to a freshly-saved account.
  if (!bound) bound = binding.applyStored(resolveAccount);

  // An account handoff finishes with a reload, which kills any toast raised
  // before it — so the news of what happened is delivered here instead.
  const notice = context.globalState.get<string>(NOTICE_KEY);
  if (notice) {
    await context.globalState.update(NOTICE_KEY, undefined);
    // A notice typically reports an account handoff. If this window came out of
    // it with NO account while saved ones exist (forget reloaded it into limbo),
    // the news must come with the way out attached, not read as a dead end.
    const canSwitch = !binding.getActiveName() && registry.listUniqueByEmail().length > 0;
    void vscode.window
      .showInformationMessage(`Claude Alts: ${notice}`, ...(canSwitch ? ['Switch account'] : []))
      .then((pick) => {
        if (pick === 'Switch account') {
          void vscode.commands.executeCommand('claudeAlts.switchAccount');
        }
      });
  }

  // First-run guidance only when there's genuinely nothing to work with: no
  // saved accounts and this window isn't signed in anywhere (so auto-save had
  // nothing to capture). Otherwise the status bar already shows the account.
  if (!bound && registry.list().length === 0) {
    const key = 'claudeAlts.introShown';
    if (!context.globalState.get<boolean>(key, false)) {
      await context.globalState.update(key, true);
      vscode.window.showInformationMessage(
        'Claude Alts: no accounts detected yet. Sign in with Claude Code (Account menu → Login, ' +
          'or /login in a chat) and this window will remember the account automatically.'
      );
    }
  }
}

/** Shows the one line that brings the accounts into an external terminal. */
async function setupShellInteractive(): Promise<void> {
  const kind = process.platform === 'win32' ? 'powershell' : 'posix';
  const line = sourceLine(kind);
  const pick = await vscode.window.showInformationMessage(
    `Use your Claude accounts in any terminal: add this line to your ${
      kind === 'powershell' ? 'PowerShell $PROFILE' : 'shell profile (~/.zshrc or ~/.bashrc)'
    }, then run \`claude-as <account>\` (or \`claude-use <account>\`, \`claude-accounts\`).${
      kind === 'powershell'
        ? // Windows ships with PowerShell scripts disabled, $PROFILE included: the
          // line would silently never run. Changing that is the user's call.
          '\n\nIf PowerShell says running scripts is disabled, allow your own scripts first: ' +
          '`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`'
        : ''
    }\n\n${line}`,
    { modal: true },
    'Copy line',
    'Open script'
  );
  if (pick === 'Copy line') {
    await vscode.env.clipboard.writeText(line);
    vscode.window.showInformationMessage('Copied. Paste it into your shell profile and open a new terminal.');
  } else if (pick === 'Open script') {
    await vscode.window.showTextDocument(
      vscode.Uri.file(kind === 'powershell' ? powershellScript() : posixScript())
    );
  }
}

export function deactivate(): void {
  /* nothing to clean up */
}
