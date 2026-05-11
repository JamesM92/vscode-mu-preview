import * as vscode from 'vscode';

export interface Identity {
  name: string;
  linkId: string;
}

/**
 * Built-in identities used when the user has not configured any in
 * `muPreview.identities`. Two predictable testers makes
 * "log in as a different user" workflows trivial without forcing the
 * user to hand-roll 32-hex-char strings before previewing anything.
 */
const DEFAULT_IDENTITIES: Identity[] = [
  { name: 'Anonymous',    linkId: '00000000000000000000000000000000' },
  { name: 'Tester Alice', linkId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  { name: 'Tester Bob',   linkId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
];

const ACTIVE_KEY = 'muPreview.activeIdentityName';

export class IdentityManager {
  private statusItem: vscode.StatusBarItem;
  private onChangeEmitter = new vscode.EventEmitter<Identity>();

  /** Fires whenever the active identity is changed via switchIdentity(). */
  readonly onDidChangeActive = this.onChangeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusItem.command = 'muPreview.switchIdentity';
    this.statusItem.tooltip = 'Click to switch the LXMF identity used when spawning .mu scripts in the preview';
    this.refreshLabel();
    context.subscriptions.push(this.statusItem, this.onChangeEmitter);
  }

  /** All identities the user can pick from (configured or defaults). */
  list(): Identity[] {
    const cfg = vscode.workspace.getConfiguration('muPreview');
    const configured = cfg.get<Identity[]>('identities', []);
    return configured && configured.length > 0 ? configured : DEFAULT_IDENTITIES;
  }

  /** Currently active identity (falls back to the first one if state is stale). */
  getActive(): Identity {
    const name = this.context.workspaceState.get<string>(ACTIVE_KEY);
    const all = this.list();
    return all.find(i => i.name === name) ?? all[0];
  }

  /** Show a QuickPick for the user to choose a new active identity. */
  async switchIdentity(): Promise<Identity | undefined> {
    const all = this.list();
    const active = this.getActive();
    const items: (vscode.QuickPickItem & { identity: Identity })[] = all.map(i => ({
      label: `${i.name === active.name ? '$(check) ' : '$(blank) '}${i.name}`,
      description: i.linkId,
      identity: i,
    }));
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select the LXMF identity to spawn .mu scripts as',
    });
    if (!pick) return undefined;
    await this.context.workspaceState.update(ACTIVE_KEY, pick.identity.name);
    this.refreshLabel();
    this.onChangeEmitter.fire(pick.identity);
    return pick.identity;
  }

  /** Show / hide the status-bar item (we only want it visible while a preview is open). */
  setVisible(visible: boolean): void {
    if (visible) this.statusItem.show();
    else this.statusItem.hide();
  }

  private refreshLabel(): void {
    const active = this.getActive();
    this.statusItem.text = `$(person) ${active.name}`;
  }
}
