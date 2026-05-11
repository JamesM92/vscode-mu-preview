# Micron (.mu) Preview for VSCode

Side-by-side preview for [NomadNet](https://github.com/markqvist/NomadNet) **micron** (`.mu`) pages — both static markup and shebang-driven dynamic scripts. Renders the same output your readers will see on real Reticulum links, without leaving your editor.

![Open Preview to the Side](resources/screenshot-main.png)

## Features

- **Live side-by-side preview** of `.mu` files. Re-renders on save.
- **Executes shebang scripts** (`#!/usr/bin/env python3` etc.) and renders their stdout — the same way NomadNet runs them over a Reticulum link.
- **Faithful rendering** via the [Micron2HTML](https://github.com/JamesM92/Micron2HTML) converter — link colors, headings, fields, and the bundled NomadNet font.
- **In-preview navigation:** Back / Refresh / Raw-source toggle, plus an editable address bar that accepts the same `:/page/...` and `:/page/...\`field=value|...` URL forms NomadNet uses.
- **LXMF identity simulation:** swap between built-in test identities (`Anonymous` / `Tester Alice` / `Tester Bob`) or your own configured set. Sets `link_id` on the spawned script the same way NomadNet would.
- **Fingerprint simulation:** toggle a `remote_identity` hash on/off and switch between identities — useful for testing role/permission flows (admin / mod / user, active / suspended / banned defaults provided).
- **Bandwidth budget readout:** shows the rendered byte size and the estimated transmission time at 3.1 kbps (Reticulum LoRa baseline). Color-coded against a 3 KB target / 5 KB soft cap so you can keep pages snappy on slow links.
- **Form support:** text fields, checkboxes, radios, and submit links all post back to the script with the right `field_<name>` / `var_<name>` env vars. Press <kbd>Enter</kbd> in a text field to submit, just like in MeshChat.

## Requirements

This extension shells out to the [Micron2HTML](https://github.com/JamesM92/Micron2HTML) Python package for the actual micron-to-HTML conversion.

You need **Python 3.9+** and `Micron2HTML` available on the interpreter the extension uses. You have two options:

### Option 1 — Use a system / project Python

```bash
pip install Micron2HTML
```

Then point the extension at that interpreter via the `muPreview.python` setting (full path to `python` / `python.exe`). If left empty, the extension falls back to a bundled venv at `<extension>/.venv/`.

### Option 2 — Bundled venv

Create a `.venv` inside the extension folder:

```bash
cd ~/.vscode/extensions/jamesm92.vscode-mu-preview-<version>
python3 -m venv .venv
.venv/bin/pip install Micron2HTML
```

(Substitute `Scripts\python.exe` on Windows.)

## Usage

1. Open any `.mu` file.
2. Click the **preview icon** in the editor title bar (top right), right-click and choose **Micron: Open Preview to the Side**, or press <kbd>Ctrl</kbd>+<kbd>K</kbd> <kbd>V</kbd>.
3. Edit the source — the preview re-renders on save.

For shebang scripts, mark the file executable first:

```bash
chmod +x your-page.mu
```

### Toolbar

The preview has a two-row toolbar:

| Row | Controls |
|-----|----------|
| Top | Active identity · active fingerprint · bandwidth readout |
| Bottom | Back · Refresh · address bar · Raw toggle · Fingerprint on/off |

Click the identity / fingerprint buttons to switch them. The address bar accepts NomadNet-style URLs (`:/page/foo.mu` or `:/page/foo.mu\`q=hello|page=2`); press <kbd>Enter</kbd> to navigate.

## Configuration

| Setting | Default | What it does |
|---|---|---|
| `muPreview.python` | `""` | Path to a Python interpreter with `Micron2HTML` installed. Empty = use the extension's bundled `.venv`. |
| `muPreview.executeShebang` | `true` | Run executable `.mu` files (those starting with `#!`) and render their stdout. Disable to render the file contents as static micron source instead. |
| `muPreview.executeTimeoutMs` | `15000` | Timeout for executing a `.mu` script before aborting. Cold renders of map-heavy pages can take several seconds the first time. |
| `muPreview.slowRenderWarnMs` | `5000` | Show a warning when a render takes longer than this. Set to `0` to disable. |
| `muPreview.refreshOnSave` | `true` | Re-render the preview whenever the source file is saved. |
| `muPreview.identities` | `[]` | LXMF identities (`{name, linkId}`) the preview can spawn scripts as. Empty uses built-in defaults. |
| `muPreview.fingerprints` | `[]` | LXMF fingerprints (`{nickname, fingerprint}`) the preview can present as. Empty uses built-in defaults. |

Both `linkId` and `fingerprint` are 32-character hex strings.

## How it works

Under the hood, each render:

1. Reads the `.mu` file. If it starts with `#!` and `executeShebang` is on, the file is spawned as a child process; otherwise its contents are used directly.
2. Environment variables matching what NomadNet would set on a real link are injected: `link_id` (from active identity), `remote_identity` (from active fingerprint, when toggled on), and `field_<name>` / `var_<name>` for any form fields or URL extras from the current navigation.
3. The micron source — file contents or script stdout — is piped to `Micron2HTML` for fragment-mode HTML conversion.
4. The HTML is wrapped in a webview shell with the toolbar, address bar, click interceptor, and the bundled NomadNet stylesheet/font.

The webview never executes scripts from the page itself — it only intercepts link clicks and form submits, sends them back to the extension as `navigate` messages, and re-spawns the `.mu` script with the new fields. This matches how NomadNet actually serves pages over a link.

## Known limitations

- **No streaming.** Each navigation fully re-runs the script. Long-running scripts will block the preview until they finish or hit `executeTimeoutMs`.
- **No real Reticulum link.** Identities and fingerprints are *simulated* via env vars — useful for development, but the actual Reticulum stack isn't running.
- **Shebang execution requires the file be marked executable** (`chmod +x`). On Windows, scripts run via the registered handler for the file's `#!` interpreter, so you'll typically want `#!/usr/bin/env python3` and Python on `PATH`.

## Reporting issues

Bugs, feature requests, and questions: <https://github.com/JamesM92/vscode-mu-preview/issues>

## License

MIT — see [LICENSE](LICENSE).
