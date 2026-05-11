import * as vscode from 'vscode';
import { MicronPreview } from './preview';
import { IdentityManager } from './identity';
import { FingerprintManager } from './fingerprint';

export function activate(context: vscode.ExtensionContext) {
  const identity    = new IdentityManager(context);
  const fingerprint = new FingerprintManager(context);
  const preview     = new MicronPreview(context, identity, fingerprint);

  context.subscriptions.push(
    vscode.commands.registerCommand('muPreview.open',              (uri?: vscode.Uri) => preview.open(uri)),
    vscode.commands.registerCommand('muPreview.refresh',           () => preview.render()),
    vscode.commands.registerCommand('muPreview.back',              () => preview.back()),
    vscode.commands.registerCommand('muPreview.toggleRaw',         () => preview.toggleRaw()),
    vscode.commands.registerCommand('muPreview.switchIdentity',    () => identity.switchIdentity()),
    vscode.commands.registerCommand('muPreview.fingerprintAction', () => fingerprint.openAction()),
    vscode.commands.registerCommand('muPreview.toggleFingerprint', () => fingerprint.toggleEnabled()),
    vscode.commands.registerCommand('muPreview.switchFingerprint', () => fingerprint.switchActive()),
    vscode.workspace.onDidSaveTextDocument(doc => {
      const cfg = vscode.workspace.getConfiguration('muPreview');
      if (!cfg.get<boolean>('refreshOnSave', true)) return;
      if (isMicron(doc)) preview.refresh(doc.uri);
    }),
    preview,
  );
}

export function deactivate() {}

function isMicron(doc: vscode.TextDocument): boolean {
  return doc.languageId === 'micron' || doc.fileName.endsWith('.mu');
}
