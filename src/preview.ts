import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { renderMuToFragment, getAssetsDir, getMicronSource } from './render';
import { resolveDestination } from './nav';
import { IdentityManager } from './identity';
import { FingerprintManager } from './fingerprint';

interface WebviewMessage {
  type?: string;
  dest?: string;
  action?: string;
  fields?: Record<string, string>;
}

// A navigation: a URI plus the form fields / link extras that were
// used to fetch it. Stored so Refresh and Back can REPLAY the exact
// request that produced the current view (a form post-back lands on
// the same URI as the form page, but with different fields - the
// URI alone isn't enough to reconstruct the page).
interface NavEntry {
  uri: vscode.Uri;
  fields?: Record<string, string>;
}

export class MicronPreview implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  // The navigation that produced the current view. Render reads its
  // URI + fields; Refresh re-runs render with the same NavEntry.
  private currentNav: NavEntry | undefined;
  private assetsDir: string | undefined;
  private identitySub: vscode.Disposable | undefined;
  private fingerprintSub: vscode.Disposable | undefined;
  // Past navigations, most recent last. Each link click / open() into
  // a new view pushes the OLD currentNav before swapping to the new
  // one, so Back can pop and re-render with the previous nav's
  // fields - even when the previous URI is the same (post-back flow).
  private history: NavEntry[] = [];
  private static readonly HISTORY_CAP = 50;
  // Raw-view toggle. When on, render() shows the file's verbatim
  // source text (backtick directives visible) instead of executing
  // the script + parsing micron. Useful for debugging unexpected
  // output or just reading what the .mu source actually contains.
  private rawView = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly identity: IdentityManager,
    private readonly fingerprint: FingerprintManager,
  ) {}

  async open(uri?: vscode.Uri): Promise<void> {
    let target: vscode.Uri | undefined;
    if (uri && uri.fsPath.endsWith('.mu')) {
      target = uri;
    } else {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.fileName.endsWith('.mu')) {
        target = editor.document.uri;
      }
    }
    if (!target) {
      vscode.window.showWarningMessage('Open or right-click a .mu file before launching the Micron preview.');
      return;
    }

    if (!this.panel) {
      try {
        this.assetsDir = getAssetsDir(this.context);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Micron preview: ${msg.split('\n')[0]}`);
        return;
      }

      this.panel = vscode.window.createWebviewPanel(
        'muPreview',
        this.titleFor(target),
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.file(this.assetsDir)],
        },
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.currentNav = undefined;
        this.history = [];
        this.identity.setVisible(false);
        this.fingerprint.setVisible(false);
        this.identitySub?.dispose();
        this.fingerprintSub?.dispose();
        this.identitySub = undefined;
        this.fingerprintSub = undefined;
        void vscode.commands.executeCommand('setContext', 'muPreview.active', false);
      });
      this.panel.webview.onDidReceiveMessage((m: WebviewMessage) => this.handleMessage(m));
      // Re-render whenever identity or fingerprint changes so the new
      // env vars take effect immediately.
      this.identitySub    = this.identity.onDidChangeActive(() => void this.render());
      this.fingerprintSub = this.fingerprint.onDidChange(()    => void this.render());
      this.identity.setVisible(true);
      this.fingerprint.setVisible(true);
      await vscode.commands.executeCommand('setContext', 'muPreview.active', true);
    } else {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
    }

    // Opening a (possibly different) file from outside the preview -
    // a fresh navigation with no fields. Push the previous nav onto
    // history so Back can return to it.
    if (this.currentNav) {
      this.pushHistory(this.currentNav);
    }
    this.currentNav = { uri: target, fields: undefined };
    this.panel.title = this.titleFor(target);
    await this.render();
  }

  /** Save-handler hook: re-render when the source file on disk
   *  changes. Replays the SAME nav (same fields) so a form-submitted
   *  view stays consistent across edits. */
  async refresh(uri: vscode.Uri): Promise<void> {
    if (!this.panel || !this.currentNav) return;
    if (uri.fsPath !== this.currentNav.uri.fsPath) return;
    await this.render();
  }

  async render(): Promise<void> {
    if (!this.panel || !this.currentNav) return;
    const filePath = this.currentNav.uri.fsPath;
    // Read fields fresh on every render so Refresh and Back replay
    // the original navigation - the user's intent is "redo what got
    // me here," not "redo with whatever fields happened to be in
    // memory at navigation time."
    const fields   = this.currentNav.fields;
    const startedAt = Date.now();
    if (this.rawView) {
      // Skip the micron2html parse step but still EXECUTE the script
      // (when it has a shebang) - raw view shows the bytes that would
      // be sent to the micron viewer, not the .mu source code. For a
      // pure-static .mu file with no shebang this is just the file
      // contents; for a Python-driven page it's whatever stdout the
      // script produced.
      try {
        const id = this.identity.getActive();
        const fp = this.fingerprint.getEffective();
        const source = await getMicronSource(filePath, id, fp, fields);
        this.panel.webview.html = this.buildRawPage(source);
        this.maybeWarnSlow(filePath, Date.now() - startedAt);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.panel.webview.html = this.buildErrorPage(filePath, msg);
      }
      return;
    }
    try {
      const id = this.identity.getActive();
      const fp = this.fingerprint.getEffective();
      const { fragment, assetsDir, micronBytes } = await renderMuToFragment(filePath, this.context, id, fp, fields);
      this.panel.webview.html = this.buildPage(fragment, assetsDir, micronBytes);
      this.maybeWarnSlow(filePath, Date.now() - startedAt);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.panel.webview.html = this.buildErrorPage(filePath, msg);
    }
  }

  /** Pop a non-modal warning when a render took longer than the
   *  configured threshold. Cold renders of shapefile-heavy pages
   *  can take 10+ seconds the first time a tile is drawn; this nudge
   *  sets expectations and points at the cause. Setting the threshold
   *  to 0 disables the warning. */
  private maybeWarnSlow(filePath: string, elapsedMs: number): void {
    const cfg = vscode.workspace.getConfiguration('muPreview');
    const threshold = cfg.get<number>('slowRenderWarnMs', 5000);
    if (threshold <= 0 || elapsedMs <= threshold) return;
    const seconds = (elapsedMs / 1000).toFixed(1);
    vscode.window.showWarningMessage(
      `Micron preview took ${seconds}s to render ${path.basename(filePath)}. ` +
      `Subsequent renders should be faster (cached).`,
    );
  }

  /** Pop the most recent navigation from history and re-render with
   *  its URI AND fields - so a form-submitted prior page comes back
   *  exactly as it was, not as a fresh GET-style fetch of the same
   *  URI. No-op when history is empty. Intentionally does NOT push
   *  the current nav back (that would create oscillation). */
  async back(): Promise<void> {
    if (!this.panel || this.history.length === 0) return;
    const previous = this.history.pop()!;
    this.currentNav = previous;
    this.panel.title = this.titleFor(previous.uri);
    await this.render();
  }

  /** Toggle raw source view on/off and re-render. Replays the
   *  current navigation's fields. */
  async toggleRaw(): Promise<void> {
    this.rawView = !this.rawView;
    await this.render();
  }

  private pushHistory(entry: NavEntry): void {
    this.history.push(entry);
    if (this.history.length > MicronPreview.HISTORY_CAP) {
      this.history.shift();
    }
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    if (msg?.type === 'navigate' && typeof msg.dest === 'string') {
      await this.navigateTo(msg.dest, msg.fields);
    } else if (msg?.type === 'toolbar' && typeof msg.action === 'string') {
      await this.toolbarAction(msg.action);
    }
  }

  private async toolbarAction(action: string): Promise<void> {
    switch (action) {
      case 'switchIdentity':    await this.identity.switchIdentity();    return;
      case 'toggleFingerprint': await this.fingerprint.toggleEnabled();  return;
      case 'switchFingerprint': await this.fingerprint.switchActive();   return;
      case 'refresh':           await this.render();                     return;
      case 'back':              await this.back();                       return;
      case 'toggleRaw':         await this.toggleRaw();                  return;
    }
  }

  private async navigateTo(dest: string, fields?: Record<string, string>): Promise<void> {
    if (!this.currentNav) return;
    const resolved = resolveDestination(dest, this.currentNav.uri.fsPath);
    switch (resolved.kind) {
      case 'local':
        // Always push the current nav onto history - even when the
        // target URI matches. A form post-back to the same page is
        // still a navigation, and Back should restore the previous
        // form state rather than skip over the post-back.
        this.pushHistory(this.currentNav);
        this.currentNav = {
          uri: vscode.Uri.file(resolved.path),
          fields,
        };
        if (this.panel) this.panel.title = this.titleFor(this.currentNav.uri);
        await this.render();
        return;
      case 'external':
        await vscode.env.openExternal(vscode.Uri.parse(resolved.url));
        return;
      case 'unsupported':
        vscode.window.showInformationMessage(resolved.message);
        return;
      case 'error':
        vscode.window.showWarningMessage(resolved.message);
        return;
    }
  }

  private titleFor(uri: vscode.Uri): string {
    return `Preview: ${path.basename(uri.fsPath)}`;
  }

  /** Render the read-only address bar HTML for the current
   *  navigation: the FULL micron-style URL that was routed to the
   *  page - `:/page/<relpath>` for the file part, followed by
   *  `\``key=value|key=value` for any URL params + form-field values.
   *  Mirrors the format a `\`[link\`:URL]` directive would carry, so
   *  what shows in the bar matches what would appear in a hand-typed
   *  link. */
  private buildAddressBarHtml(): string {
    if (!this.currentNav) return '';
    const pagePath = this.toPagePath(this.currentNav.uri.fsPath);
    const fields = this.currentNav.fields ?? {};
    const keys = Object.keys(fields);
    let url = pagePath;
    if (keys.length > 0) {
      // Single backtick before the field-spec - the format the page
      // actually receives. Field values from a form submit and URL
      // extras both flatten into this same list (the page receives
      // both as `var_<name>` and `field_<name>` env vars).
      const params = keys.map(k => `${k}=${fields[k] ?? ''}`).join('|');
      url = `${pagePath}\`${params}`;
    }
    // Editable input so the user can paste / hand-edit a URL and
    // hit Enter to navigate. The webview script wires the keydown
    // handler that parses the value and posts a navigate message.
    return `<input type="text" class="mu-tb-addr-input" ` +
           `value="${escapeHtml(url)}" spellcheck="false" ` +
           `aria-label="Address bar - edit URL and press Enter to navigate" />`;
  }

  /** Translate an absolute disk path into the micron-style page
   *  path (`/page/<rel>`). Walks up looking for a `pages` ancestor;
   *  falls back to the bare filename when no `pages` dir is found. */
  private toPagePath(fsPath: string): string {
    let dir = path.dirname(path.resolve(fsPath));
    let pagesRoot: string | undefined;
    while (true) {
      if (path.basename(dir) === 'pages') { pagesRoot = dir; break; }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!pagesRoot) return `:/page/${path.basename(fsPath)}`;
    const rel = path.relative(pagesRoot, fsPath).split(path.sep).join('/');
    return `:/page/${rel}`;
  }


  private buildPage(fragment: string, assetsDir: string, micronBytes: number): string {
    const webview = this.panel!.webview;
    const cssUri = webview.asWebviewUri(vscode.Uri.file(path.join(assetsDir, 'micron-meshchat.css')));
    const nonce = crypto.randomBytes(16).toString('hex');
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    // Toolbar state - shown above the rendered page so identity and
    // fingerprint can be flipped without leaving the preview.
    const idName    = escapeHtml(this.identity.getActive().name);
    const fpEnabled = this.fingerprint.isEnabled();
    const fpName    = escapeHtml(this.fingerprint.getActive().nickname);
    const bw        = bandwidthReadout(micronBytes);

    const backDisabled = this.history.length === 0;
    const addrBar      = this.buildAddressBarHtml();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${cssUri}">
  <style>
    /* Body becomes a flex column: toolbar at top (natural height),
     * mu-page fills the rest and scrolls if needed. */
    html, body { margin: 0; padding: 0; height: 100%; background: #000; }
    body { display: flex; flex-direction: column; }
    .mu-page { flex: 1 1 auto; min-height: 0; overflow: auto; }
    .mu-tb-btn[disabled] { opacity: 0.4; cursor: default; }
    .mu-tb-btn[disabled]:hover { background: transparent; }

    /* Permanently underline links, matching how nomadnet's terminal
     * renderer styles them. The bundled stylesheet only underlines on
     * hover. cursor:pointer makes our intercepted clicks feel native. */
    .mu-link { text-decoration: underline; cursor: pointer; }

    /* Override the bundled .mu-field styling so inputs are actually
     * usable in the preview. Bundled CSS sets color:#bababa on white,
     * which is unreadable; we make text dark and the field obviously
     * focusable. */
    .mu-field { color: #111 !important; cursor: text !important; }
    .mu-field:focus { outline: 2px solid #5ba3c9; }
    input[type="checkbox"], input[type="radio"] { cursor: pointer; }

    /* Brand-tinted heading bars. Bundled .mu-h1/2/3 use #bbbbbb /
     * #999999 / #777777 grays, which look stock-micron rather than
     * "your site". Tinted dark-blue ramp keeps hierarchy readable and
     * matches the royal-blue palette used by the brand hero / navbars.
     * NOTE: these styles only affect the preview - nomadnet's terminal
     * renderer would still display the default grays. */
    .mu-h1 { background: #2c4d7a !important; color: #ffffff !important; }
    .mu-h2 { background: #1e3a5e !important; color: #ffffff !important; }
    .mu-h3 { background: #142a45 !important; color: #ffffff !important; }

    /* Preview toolbar - intentionally uses VSCode's neutral title-bar
     * styling so the user can tell it apart from the rendered page.
     * Two stacked rows:
     *   row 1 = identity + bandwidth (high-level status)
     *   row 2 = back/refresh, address bar, raw + fingerprint
     *           (browser-like navigation context)
     */
    .mu-toolbar {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      background: var(--vscode-titleBar-activeBackground, #2d2d30);
      color: var(--vscode-titleBar-activeForeground, #cccccc);
      border-bottom: 1px solid var(--vscode-panel-border, #1e1e1e);
      font-family: var(--vscode-font-family);
      font-size: 12px;
      user-select: none;
    }
    .mu-toolbar.row2 { padding-top: 0; }
    .mu-tb-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: transparent;
      border: 1px solid transparent;
      color: inherit;
      padding: 2px 8px;
      border-radius: 3px;
      cursor: pointer;
      font: inherit;
    }
    .mu-tb-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08));
    }
    .mu-tb-btn .caret { opacity: 0.5; font-size: 10px; }
    .mu-tb-btn.fp-on  { color: var(--vscode-charts-green,  #89d185); }
    .mu-tb-btn.fp-off { opacity: 0.65; }
    .mu-tb-sep {
      opacity: 0.35;
      padding: 0 4px;
      user-select: none;
    }
    /* Bandwidth readout - rendered micron bytes + transmission estimate.
     * Right-aligned via margin-left:auto, color tracks the budget tier:
     * green ≤3KB target, yellow ≤5KB soft cap, red over. */
    .mu-tb-bw {
      margin-left: auto;
      padding: 2px 8px;
      border-radius: 3px;
      font-variant-numeric: tabular-nums;
    }
    .mu-tb-bw.bw-good { color: var(--vscode-charts-green,  #89d185); }
    .mu-tb-bw.bw-warn { color: var(--vscode-charts-yellow, #e2c08d); }
    .mu-tb-bw.bw-bad  { color: var(--vscode-charts-red,    #f48771); }
    /* Address bar - read-only display of the current file + the
     * URL params / form fields that produced this view. Sits in the
     * middle of row 2, takes whatever horizontal space is left. */
    .mu-tb-addr {
      flex: 1 1 auto;
      min-width: 0;            /* lets the bar shrink in narrow panels */
      margin: 0 6px;
      padding: 3px 8px;
      background: var(--vscode-input-background, #1e1e1e);
      color: var(--vscode-input-foreground, #cccccc);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      white-space: nowrap;
      overflow-x: auto;
      text-overflow: clip;
    }
    /* Editable address bar: a borderless input that fills the wrapper.
     * The user can select / copy / paste / hand-edit the URL and
     * press Enter to navigate. */
    .mu-tb-addr-input {
      width: 100%;
      box-sizing: border-box;
      background: transparent;
      color: var(--vscode-input-foreground, #cccccc);
      border: none;
      outline: none;
      padding: 0;
      margin: 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
    }
    .mu-tb-addr-input:focus {
      outline: 1px solid var(--vscode-focusBorder, #007acc);
      outline-offset: 1px;
    }
  </style>
</head>
<body>
  <div class="mu-toolbar" role="toolbar">
    <button class="mu-tb-btn" data-action="switchIdentity"
            title="Switch active LXMF identity (link_id)">
      <span>👤</span><span>${idName}</span><span class="caret">▾</span>
    </button>
    <span class="mu-tb-sep">·</span>
    <button class="mu-tb-btn ${fpEnabled ? '' : 'fp-off'}" data-action="switchFingerprint"
            title="Switch which fingerprint is active">
      <span>🔑</span><span>${fpName}</span><span class="caret">▾</span>
    </button>
    <span class="mu-tb-bw ${bw.cssClass}" title="${bw.tooltip}">${bw.label}</span>
  </div>
  <div class="mu-toolbar row2" role="toolbar">
    <button class="mu-tb-btn" data-action="back" ${backDisabled ? 'disabled' : ''}
            title="Go back to the previously-previewed file">
      <span>←</span><span>Back</span>
    </button>
    <button class="mu-tb-btn" data-action="refresh"
            title="Re-render the current file">
      <span>⟳</span><span>Refresh</span>
    </button>
    <div class="mu-tb-addr" title="Edit URL and press Enter to navigate">${addrBar}</div>
    <button class="mu-tb-btn ${this.rawView ? 'fp-on' : ''}" data-action="toggleRaw"
            title="Toggle raw source view (show .mu file bytes verbatim)">
      <span>${this.rawView ? '◉' : '○'}</span><span>Raw</span>
    </button>
    <span class="mu-tb-sep">·</span>
    <button class="mu-tb-btn ${fpEnabled ? 'fp-on' : 'fp-off'}" data-action="toggleFingerprint"
            title="Toggle whether the active fingerprint (remote_identity) is sent">
      <span>${fpEnabled ? '●' : '○'}</span><span>Fingerprint ${fpEnabled ? 'On' : 'Off'}</span>
    </button>
  </div>
  <div class="mu-page">${fragment}</div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // Collect every named form field's current value. Text/password
    // inputs use the typed value; checkboxes and radios are only
    // included when checked, and use their value attribute.
    function collectFormValues() {
      const out = {};
      document.querySelectorAll('input.mu-field').forEach(el => {
        if (el.name) out[el.name] = el.value;
      });
      document.querySelectorAll('input[type="checkbox"], input[type="radio"]').forEach(el => {
        if (el.name && el.checked) out[el.name] = el.value;
      });
      return out;
    }

    // Parse the data-field-spec attribute into key=value extras.
    // Format examples (after the leading '*' is stripped):
    //   ""                          - submit, no extras
    //   "key=val"                   - one extra
    //   "k=v|k2=v2"                 - several extras
    //
    // Values are decodeURIComponent'd so .mu pages can URL-encode
    // arbitrary content (e.g. with >, |, backticks) and round-trip it
    // safely through field-spec without breaking link/field parsing.
    function parseExtras(fspec) {
      const extras = {};
      for (const part of fspec.split('|')) {
        if (!part || part === '*') continue;
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        const key = part.slice(0, eq);
        let value = part.slice(eq + 1);
        try { value = decodeURIComponent(value); } catch (_) { /* keep raw on failure */ }
        extras[key] = value;
      }
      return extras;
    }

    document.addEventListener('click', (e) => {
      // Toolbar buttons - send action to the extension.
      const btn = e.target.closest('button.mu-tb-btn');
      if (btn) {
        e.preventDefault();
        vscode.postMessage({ type: 'toolbar', action: btn.dataset.action });
        return;
      }
      // Rendered-page links - intercept and route through the extension.
      const link = e.target.closest('a.mu-link');
      if (!link) return;
      e.preventDefault();
      const dest  = link.getAttribute('href') || '';
      const fspec = link.dataset.fieldSpec || '';
      const isSubmit = fspec.startsWith('*');
      const extras = parseExtras(fspec);
      // For submit links: form values + extras (extras win on conflict).
      // For non-submit links: just the extras (URL-style query params).
      const fields = isSubmit
        ? Object.assign(collectFormValues(), extras)
        : extras;
      vscode.postMessage({ type: 'navigate', dest, fields });
    });

    // Hitting Enter inside a text field clicks the first submit link on
    // the page - matches what users expect from web forms.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const target = e.target;
      if (!(target && target.classList)) return;
      // Address bar Enter: parse the URL value and navigate. Lets
      // the user paste / hand-edit a URL and jump there directly.
      if (target.classList.contains('mu-tb-addr-input')) {
        e.preventDefault();
        const raw = target.value.trim();
        if (!raw) return;
        const tickIdx = raw.indexOf('\`');
        let dest, fields = {};
        if (tickIdx === -1) {
          dest = raw;
        } else {
          dest = raw.slice(0, tickIdx);
          for (const part of raw.slice(tickIdx + 1).split('|')) {
            if (!part) continue;
            const eq = part.indexOf('=');
            if (eq === -1) continue;
            fields[part.slice(0, eq)] = part.slice(eq + 1);
          }
        }
        vscode.postMessage({ type: 'navigate', dest, fields });
        return;
      }
      // Form field Enter: behave like clicking the page's first submit.
      if (!target.classList.contains('mu-field')) return;
      const submit = document.querySelector('a.mu-link[data-field-spec^="*"]');
      if (submit) { e.preventDefault(); submit.click(); }
    });
  </script>
</body>
</html>`;
  }

  private buildRawPage(source: string): string {
    // Raw view shares the same toolbar as the rendered page so the
    // user can toggle back without leaving the preview. The body is
    // the verbatim source - escaped + monospaced, with backtick
    // directives visible. Bandwidth readout reflects the raw source
    // bytes (not "rendered output bytes" - the script isn't run in
    // raw mode), which is still a useful "how big is this file"
    // proxy.
    const webview = this.panel!.webview;
    const nonce   = crypto.randomBytes(16).toString('hex');
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    const idName    = escapeHtml(this.identity.getActive().name);
    const fpEnabled = this.fingerprint.isEnabled();
    const fpName    = escapeHtml(this.fingerprint.getActive().nickname);
    const bw        = bandwidthReadout(Buffer.byteLength(source, 'utf8'));
    const backDisabled = this.history.length === 0;
    const addrBar      = this.buildAddressBarHtml();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <style>
    html, body { margin: 0; padding: 0; height: 100%;
                 background: var(--vscode-editor-background, #1e1e1e);
                 color: var(--vscode-editor-foreground, #d4d4d4); }
    body { display: flex; flex-direction: column; }
    .mu-raw { flex: 1 1 auto; min-height: 0; overflow: auto; margin: 0;
              padding: 12px; white-space: pre;
              font-family: var(--vscode-editor-font-family, monospace);
              font-size: var(--vscode-editor-font-size, 13px);
              tab-size: 4; }
    .mu-toolbar { flex: 0 0 auto; display: flex; align-items: center; gap: 6px;
                  padding: 4px 10px;
                  background: var(--vscode-titleBar-activeBackground, #2d2d30);
                  color: var(--vscode-titleBar-activeForeground, #cccccc);
                  border-bottom: 1px solid var(--vscode-panel-border, #1e1e1e);
                  font-family: var(--vscode-font-family); font-size: 12px;
                  user-select: none; }
    .mu-toolbar.row2 { padding-top: 0; }
    .mu-tb-btn { display: inline-flex; align-items: center; gap: 4px;
                 background: transparent; border: 1px solid transparent;
                 color: inherit; padding: 2px 8px; border-radius: 3px;
                 cursor: pointer; font: inherit; }
    .mu-tb-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08)); }
    .mu-tb-btn[disabled] { opacity: 0.4; cursor: default; }
    .mu-tb-btn[disabled]:hover { background: transparent; }
    .mu-tb-btn .caret { opacity: 0.5; font-size: 10px; }
    .mu-tb-btn.fp-on  { color: var(--vscode-charts-green,  #89d185); }
    .mu-tb-btn.fp-off { opacity: 0.65; }
    .mu-tb-sep { opacity: 0.35; padding: 0 4px; user-select: none; }
    .mu-tb-bw  { margin-left: auto; padding: 2px 8px; border-radius: 3px;
                 font-variant-numeric: tabular-nums; }
    .mu-tb-bw.bw-good { color: var(--vscode-charts-green,  #89d185); }
    .mu-tb-bw.bw-warn { color: var(--vscode-charts-yellow, #e2c08d); }
    .mu-tb-bw.bw-bad  { color: var(--vscode-charts-red,    #f48771); }
    .mu-tb-addr { flex: 1 1 auto; min-width: 0; margin: 0 6px;
                  padding: 3px 8px;
                  background: var(--vscode-input-background, #1e1e1e);
                  color: var(--vscode-input-foreground, #cccccc);
                  border: 1px solid var(--vscode-input-border, transparent);
                  border-radius: 3px;
                  font-family: var(--vscode-editor-font-family, monospace);
                  font-size: 11px; white-space: nowrap;
                  overflow-x: auto; text-overflow: clip; }
    /* Editable address bar: a borderless input that fills the wrapper.
     * The user can select / copy / paste / hand-edit the URL and
     * press Enter to navigate. */
    .mu-tb-addr-input {
      width: 100%;
      box-sizing: border-box;
      background: transparent;
      color: var(--vscode-input-foreground, #cccccc);
      border: none;
      outline: none;
      padding: 0;
      margin: 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
    }
    .mu-tb-addr-input:focus {
      outline: 1px solid var(--vscode-focusBorder, #007acc);
      outline-offset: 1px;
    }
  </style>
</head>
<body>
  <div class="mu-toolbar" role="toolbar">
    <button class="mu-tb-btn" data-action="switchIdentity"
            title="Switch active LXMF identity (link_id)">
      <span>👤</span><span>${idName}</span><span class="caret">▾</span>
    </button>
    <span class="mu-tb-sep">·</span>
    <button class="mu-tb-btn ${fpEnabled ? '' : 'fp-off'}" data-action="switchFingerprint">
      <span>🔑</span><span>${fpName}</span><span class="caret">▾</span>
    </button>
    <span class="mu-tb-bw ${bw.cssClass}" title="${bw.tooltip}">${bw.label}</span>
  </div>
  <div class="mu-toolbar row2" role="toolbar">
    <button class="mu-tb-btn" data-action="back" ${backDisabled ? 'disabled' : ''}
            title="Go back to the previously-previewed file">
      <span>←</span><span>Back</span>
    </button>
    <button class="mu-tb-btn" data-action="refresh"
            title="Re-read the file from disk">
      <span>⟳</span><span>Refresh</span>
    </button>
    <div class="mu-tb-addr" title="Edit URL and press Enter to navigate">${addrBar}</div>
    <button class="mu-tb-btn fp-on" data-action="toggleRaw"
            title="Toggle raw source view - return to rendered preview">
      <span>◉</span><span>Raw</span>
    </button>
    <span class="mu-tb-sep">·</span>
    <button class="mu-tb-btn ${fpEnabled ? 'fp-on' : 'fp-off'}" data-action="toggleFingerprint">
      <span>${fpEnabled ? '●' : '○'}</span><span>Fingerprint ${fpEnabled ? 'On' : 'Off'}</span>
    </button>
  </div>
  <pre class="mu-raw">${escapeHtml(source)}</pre>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('button.mu-tb-btn');
      if (!btn || btn.disabled) return;
      e.preventDefault();
      vscode.postMessage({ type: 'toolbar', action: btn.dataset.action });
    });
  </script>
</body>
</html>`;
  }

  private buildErrorPage(filePath: string, message: string): string {
    // Same toolbar + chrome as the rendered / raw pages so the user
    // can hit Back, Refresh, or Raw without touching the command
    // palette - critical when the page itself is broken (a syntax
    // error in a .mu script, a Python timeout, etc.) and the only
    // way out would otherwise be closing the panel.
    const webview = this.panel!.webview;
    const nonce   = crypto.randomBytes(16).toString('hex');
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    const idName    = escapeHtml(this.identity.getActive().name);
    const fpEnabled = this.fingerprint.isEnabled();
    const fpName    = escapeHtml(this.fingerprint.getActive().nickname);
    const backDisabled = this.history.length === 0;
    const escapedMsg  = escapeHtml(message);
    const escapedPath = escapeHtml(filePath);
    const addrBar     = this.buildAddressBarHtml();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <style>
    html, body { margin: 0; padding: 0; height: 100%;
                 background: var(--vscode-editor-background, #1e1e1e);
                 color: var(--vscode-foreground, #d4d4d4); }
    body { display: flex; flex-direction: column; }
    .mu-err { flex: 1 1 auto; min-height: 0; overflow: auto;
              padding: 1rem;
              font-family: var(--vscode-editor-font-family, monospace); }
    .mu-err h2 { color: var(--vscode-errorForeground, #f48771);
                 margin: 0 0 0.75rem 0; font-size: 1rem; }
    .mu-err code { color: var(--vscode-textPreformat-foreground); }
    .mu-err pre { white-space: pre-wrap; word-break: break-word;
                  background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.1));
                  padding: 0.75rem;
                  border-left: 3px solid var(--vscode-errorForeground, #f48771); }
    .mu-toolbar { flex: 0 0 auto; display: flex; align-items: center; gap: 6px;
                  padding: 4px 10px;
                  background: var(--vscode-titleBar-activeBackground, #2d2d30);
                  color: var(--vscode-titleBar-activeForeground, #cccccc);
                  border-bottom: 1px solid var(--vscode-panel-border, #1e1e1e);
                  font-family: var(--vscode-font-family); font-size: 12px;
                  user-select: none; }
    .mu-toolbar.row2 { padding-top: 0; }
    .mu-tb-btn { display: inline-flex; align-items: center; gap: 4px;
                 background: transparent; border: 1px solid transparent;
                 color: inherit; padding: 2px 8px; border-radius: 3px;
                 cursor: pointer; font: inherit; }
    .mu-tb-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08)); }
    .mu-tb-btn[disabled] { opacity: 0.4; cursor: default; }
    .mu-tb-btn[disabled]:hover { background: transparent; }
    .mu-tb-btn .caret { opacity: 0.5; font-size: 10px; }
    .mu-tb-btn.fp-on  { color: var(--vscode-charts-green,  #89d185); }
    .mu-tb-btn.fp-off { opacity: 0.65; }
    .mu-tb-sep { opacity: 0.35; padding: 0 4px; user-select: none; }
    .mu-tb-addr { flex: 1 1 auto; min-width: 0; margin: 0 6px;
                  padding: 3px 8px;
                  background: var(--vscode-input-background, #1e1e1e);
                  color: var(--vscode-input-foreground, #cccccc);
                  border: 1px solid var(--vscode-input-border, transparent);
                  border-radius: 3px;
                  font-family: var(--vscode-editor-font-family, monospace);
                  font-size: 11px; white-space: nowrap;
                  overflow-x: auto; text-overflow: clip; }
    /* Editable address bar: a borderless input that fills the wrapper.
     * The user can select / copy / paste / hand-edit the URL and
     * press Enter to navigate. */
    .mu-tb-addr-input {
      width: 100%;
      box-sizing: border-box;
      background: transparent;
      color: var(--vscode-input-foreground, #cccccc);
      border: none;
      outline: none;
      padding: 0;
      margin: 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
    }
    .mu-tb-addr-input:focus {
      outline: 1px solid var(--vscode-focusBorder, #007acc);
      outline-offset: 1px;
    }
  </style>
</head>
<body>
  <div class="mu-toolbar" role="toolbar">
    <button class="mu-tb-btn" data-action="switchIdentity">
      <span>👤</span><span>${idName}</span><span class="caret">▾</span>
    </button>
    <span class="mu-tb-sep">·</span>
    <button class="mu-tb-btn ${fpEnabled ? '' : 'fp-off'}" data-action="switchFingerprint">
      <span>🔑</span><span>${fpName}</span><span class="caret">▾</span>
    </button>
  </div>
  <div class="mu-toolbar row2" role="toolbar">
    <button class="mu-tb-btn" data-action="back" ${backDisabled ? 'disabled' : ''}
            title="Go back to the previously-previewed file">
      <span>←</span><span>Back</span>
    </button>
    <button class="mu-tb-btn" data-action="refresh"
            title="Try the render again">
      <span>⟳</span><span>Refresh</span>
    </button>
    <div class="mu-tb-addr" title="Edit URL and press Enter to navigate">${addrBar}</div>
    <button class="mu-tb-btn ${this.rawView ? 'fp-on' : ''}" data-action="toggleRaw"
            title="Toggle raw source view">
      <span>${this.rawView ? '◉' : '○'}</span><span>Raw</span>
    </button>
    <span class="mu-tb-sep">·</span>
    <button class="mu-tb-btn ${fpEnabled ? 'fp-on' : 'fp-off'}" data-action="toggleFingerprint">
      <span>${fpEnabled ? '●' : '○'}</span><span>Fingerprint ${fpEnabled ? 'On' : 'Off'}</span>
    </button>
  </div>
  <div class="mu-err">
    <h2>Micron preview failed</h2>
    <p><code>${escapedPath}</code></p>
    <pre>${escapedMsg}</pre>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('button.mu-tb-btn');
      if (!btn || btn.disabled) return;
      e.preventDefault();
      vscode.postMessage({ type: 'toolbar', action: btn.dataset.action });
    });
  </script>
</body>
</html>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}

// Budget thresholds match feedback_bandwidth_budget.md:
// 3KB target for hot reader pages, 5KB soft cap before pages get noticeably slow.
const BW_TARGET_BYTES = 3 * 1024;
const BW_CAP_BYTES    = 5 * 1024;
// 3.1 kbps = 3100 bits/sec ÷ 8 = 387.5 bytes/sec
const BW_BYTES_PER_SEC = 387.5;

function bandwidthReadout(bytes: number): { label: string; cssClass: string; tooltip: string } {
  const sizeStr = bytes < 1024
    ? `${bytes} B`
    : `${(bytes / 1024).toFixed(1)} KB`;
  const secs = bytes / BW_BYTES_PER_SEC;
  const timeStr = secs < 60
    ? `${Math.ceil(secs)}s`
    : `${(secs / 60).toFixed(1)}m`;
  let cssClass = 'bw-good';
  if (bytes > BW_CAP_BYTES)         cssClass = 'bw-bad';
  else if (bytes > BW_TARGET_BYTES) cssClass = 'bw-warn';
  const tooltip =
    `Rendered micron output: ${bytes} bytes\n` +
    `Estimated transmission @ 3.1 kbps: ~${secs.toFixed(0)}s\n` +
    `Target: ≤3KB (green) · soft cap: ≤5KB (yellow) · over cap: >5KB (red)`;
  return { label: `📦 ${sizeStr} · ⏱ ${timeStr} @ 3.1 kbps`, cssClass, tooltip };
}
