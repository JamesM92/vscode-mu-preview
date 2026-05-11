import * as vscode from 'vscode';

export interface Fingerprint {
  nickname: string;
  fingerprint: string;
}

/**
 * Built-in fingerprints used when the user has not configured any in
 * `muPreview.fingerprints`. These mirror the demo seed populated by
 * the forum project (forum/main.py _SEED_USERS) so previewing forum
 * pages immediately works against a representative cross-section:
 * every role × every status combination is reachable from the
 * dropdown without setup.
 *
 * Fingerprints are 32 repeated-hex-char patterns so they're
 * recognisable in logs (alice = "aa…", bob = "bb…", etc.).
 */
const DEFAULT_FINGERPRINTS: Fingerprint[] = [
  // Admins
  { nickname: 'Admin: alice - Active',     fingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  { nickname: 'Admin: kevin - Suspended',  fingerprint: '44444444444444444444444444444444' },
  { nickname: 'Admin: lina - Banned',      fingerprint: '55555555555555555555555555555555' },
  // Moderators
  { nickname: 'Mod: grace - Active',       fingerprint: '00000000000000000000000000000000' },
  { nickname: 'Mod: henry - Active',       fingerprint: '11111111111111111111111111111111' },
  { nickname: 'Mod: isaac - Suspended',    fingerprint: '22222222222222222222222222222222' },
  { nickname: 'Mod: julia - Banned',       fingerprint: '33333333333333333333333333333333' },
  // Regular users
  { nickname: 'User: bob - Active',        fingerprint: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
  { nickname: 'User: carol - Active',      fingerprint: 'cccccccccccccccccccccccccccccccc' },
  { nickname: 'User: dana - Active',       fingerprint: 'dddddddddddddddddddddddddddddddd' },
  { nickname: 'User: emma - Suspended',    fingerprint: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
  { nickname: 'User: frank - Banned',      fingerprint: 'ffffffffffffffffffffffffffffffff' },
  // Unregistered sentinel - a fingerprint that isn't in the seed, for
  // testing the "remote identity but no account yet" flow.
  { nickname: 'Unregistered (no account)', fingerprint: '99999999999999999999999999999999' },
];

const ACTIVE_KEY  = 'muPreview.activeFingerprintNickname';
const ENABLED_KEY = 'muPreview.fingerprintEnabled';

export class FingerprintManager {
  private statusItem: vscode.StatusBarItem;
  private onChangeEmitter = new vscode.EventEmitter<void>();

  /** Fires whenever the toggle state or active fingerprint changes. */
  readonly onDidChange = this.onChangeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.statusItem.command = 'muPreview.fingerprintAction';
    this.statusItem.tooltip = 'Click to toggle the fingerprint or switch which one is active. When on, sets the remote_identity env var on spawned .mu scripts.';
    this.refreshLabel();
    context.subscriptions.push(this.statusItem, this.onChangeEmitter);
  }

  /** All fingerprints the user can pick from (configured or defaults). */
  list(): Fingerprint[] {
    const cfg = vscode.workspace.getConfiguration('muPreview');
    const configured = cfg.get<Fingerprint[]>('fingerprints', []);
    return configured && configured.length > 0 ? configured : DEFAULT_FINGERPRINTS;
  }

  /** Currently active fingerprint (falls back to the first if state is stale). */
  getActive(): Fingerprint {
    const nick = this.context.workspaceState.get<string>(ACTIVE_KEY);
    const all = this.list();
    return all.find(f => f.nickname === nick) ?? all[0];
  }

  /** Toggle state - whether the active fingerprint is currently being injected. */
  isEnabled(): boolean {
    return this.context.workspaceState.get<boolean>(ENABLED_KEY, false);
  }

  /**
   * The hash to set as remote_identity on the next render, or undefined
   * if the fingerprint is currently disabled. Render code calls this
   * once per render and forwards the result.
   */
  getEffective(): string | undefined {
    return this.isEnabled() ? this.getActive().fingerprint : undefined;
  }

  async toggleEnabled(): Promise<boolean> {
    const next = !this.isEnabled();
    await this.context.workspaceState.update(ENABLED_KEY, next);
    this.refreshLabel();
    this.onChangeEmitter.fire();
    return next;
  }

  async switchActive(): Promise<Fingerprint | undefined> {
    const all = this.list();
    const active = this.getActive();
    const items: (vscode.QuickPickItem & { fingerprint: Fingerprint })[] = all.map(f => ({
      label: `${f.nickname === active.nickname ? '$(check) ' : '$(blank) '}${f.nickname}`,
      description: f.fingerprint,
      fingerprint: f,
    }));
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select the LXMF fingerprint to expose as remote_identity',
    });
    if (!pick) return undefined;
    await this.context.workspaceState.update(ACTIVE_KEY, pick.fingerprint.nickname);
    this.refreshLabel();
    this.onChangeEmitter.fire();
    return pick.fingerprint;
  }

  /**
   * Unified action invoked from clicking the status-bar item: a
   * QuickPick whose first item is the toggle, followed by a separator,
   * followed by the fingerprint list. Picking the toggle flips the
   * enabled state; picking a fingerprint sets it as active (and also
   * turns the toggle ON if it was off, since the user clearly wants to
   * use that fingerprint).
   */
  async openAction(): Promise<void> {
    const enabled = this.isEnabled();
    const all = this.list();
    const active = this.getActive();
    type Item = vscode.QuickPickItem & { action?: 'toggle'; fingerprint?: Fingerprint };
    const items: Item[] = [
      {
        label: enabled
          ? '$(circle-large-filled) Turn fingerprint OFF'
          : '$(circle-large-outline) Turn fingerprint ON',
        description: enabled
          ? 'remote_identity will be unset on next render'
          : `remote_identity will be set to "${active.nickname}"`,
        action: 'toggle',
      },
      { label: 'Switch active fingerprint', kind: vscode.QuickPickItemKind.Separator },
      ...all.map<Item>(f => ({
        label: `${f.nickname === active.nickname ? '$(check) ' : '$(blank) '}${f.nickname}`,
        description: f.fingerprint,
        fingerprint: f,
      })),
    ];
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Toggle the fingerprint, or switch which one is active',
    });
    if (!pick) return;
    if (pick.action === 'toggle') {
      await this.toggleEnabled();
    } else if (pick.fingerprint) {
      await this.context.workspaceState.update(ACTIVE_KEY, pick.fingerprint.nickname);
      // Picking a specific fingerprint also turns the feature on - the
      // user clearly wanted to use this one.
      if (!this.isEnabled()) {
        await this.context.workspaceState.update(ENABLED_KEY, true);
      }
      this.refreshLabel();
      this.onChangeEmitter.fire();
    }
  }

  /** Show / hide the status-bar item alongside the preview lifecycle. */
  setVisible(visible: boolean): void {
    if (visible) this.statusItem.show();
    else this.statusItem.hide();
  }

  private refreshLabel(): void {
    if (this.isEnabled()) {
      this.statusItem.text = `$(key) ${this.getActive().nickname}`;
    } else {
      this.statusItem.text = `$(key) Off`;
    }
  }
}
