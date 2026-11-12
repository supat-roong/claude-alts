import * as vscode from 'vscode';

/**
 * Display names and colours for accounts — `claudeAlts.accountLabels`,
 * keyed by email: `{ "me@work.com": { "label": "Work", "color": "charts.blue" } }`
 * (a bare string is a label alone). Purely cosmetic: an account is still its
 * email everywhere it matters, and is shown next to the label.
 */

export interface AccountLabel {
  label?: string;
  /** A theme colour id (`charts.blue`) or a hex colour (`#3b82f6`). */
  color?: string;
}

const SECTION = 'claudeAlts';

function all(): Record<string, AccountLabel | string> {
  const v = vscode.workspace.getConfiguration(SECTION).get<Record<string, AccountLabel | string>>('accountLabels', {});
  return v && typeof v === 'object' ? v : {};
}

export function labelOf(email: string | undefined): AccountLabel {
  if (!email) return {};
  const v = all()[email];
  if (typeof v === 'string') return { label: v.trim() || undefined };
  return { label: v?.label?.trim() || undefined, color: v?.color?.trim() || undefined };
}

/** The label if one is set, else the email. */
export function nameFor(email: string | undefined, fallback = ''): string {
  return labelOf(email).label ?? email ?? fallback;
}

/** "Work (me@work.com)" — or just the email when there is no label. */
export function fullName(email: string | undefined, fallback = ''): string {
  const { label } = labelOf(email);
  return label && email ? `${label} (${email})` : email ?? fallback;
}

export function colorOf(email: string | undefined): string | vscode.ThemeColor | undefined {
  const { color } = labelOf(email);
  if (!color) return undefined;
  return color.startsWith('#') ? color : new vscode.ThemeColor(color);
}

export async function setLabel(email: string, label: AccountLabel): Promise<void> {
  // A deep copy, not a spread: VSCode hands out settings objects as read-only
  // proxies whose spread comes out EMPTY — saving one label wiped all the others.
  const next = JSON.parse(JSON.stringify(all())) as Record<string, AccountLabel | string>;
  if (!label.label && !label.color) delete next[email];
  else next[email] = label;
  await vscode.workspace
    .getConfiguration(SECTION)
    .update('accountLabels', Object.keys(next).length ? next : undefined, vscode.ConfigurationTarget.Global);
}

/** Colours offered by the picker: theme colours, so they suit every theme. */
export const PALETTE: Array<{ name: string; id?: string }> = [
  { name: 'No colour' },
  { name: 'Red', id: 'charts.red' },
  { name: 'Orange', id: 'charts.orange' },
  { name: 'Yellow', id: 'charts.yellow' },
  { name: 'Green', id: 'charts.green' },
  { name: 'Blue', id: 'charts.blue' },
  { name: 'Purple', id: 'charts.purple' },
];
