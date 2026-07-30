# Changelog

All notable changes to the **Micron (.mu) Preview** extension are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] - 2026-07-28

### Fixed
- Documented a minimum required `Micron2HTML` version of 1.1.0. That release fixes a tag-nesting bug where `` `b ``/`` `f ``/`` `! ``/`` `_ ``/`` `* `` reset/toggle tokens closed a non-innermost open span in the wrong stream position, leaving a background or foreground color applied further into a line than the source specifies whenever another color/style token was still open. vscode-mu-preview doesn't pin or bundle a `Micron2HTML` version, so this is a documentation-only change here — see the [README](README.md#requirements) for upgrade instructions.

## [0.2.1] - 2026-07-28

### Fixed
- Link field-specs now resolve bare field-name references (e.g. `url=abc123|images`), not just literal `key=value` pairs. Previously only wildcard (`*`) submit links picked these up via `collectFormValues()`; ordinary content links silently dropped them, matching neither NomadNet's Guide (which documents mixing both forms in one spec) nor its `Browser.py` implementation.
- Multiple checked checkboxes sharing the same field name are now joined with a comma instead of the last one silently overwriting the rest, matching NomadNet's documented and implemented behavior for grouped multi-select checkboxes.

## [0.2.0] - 2026-07-28

### Added
- `muPreview.useProjectVenv` setting (default `true`): before executing a shebang `.mu` script, the extension now searches upward from the script's folder (bounded to its workspace folder) for a `.venv`/`venv` and prepends its `bin`/`Scripts` to `PATH`, so the script's own project dependencies are importable via `#!/usr/bin/env python3`.

## [0.1.0] - 2026-05-11

Initial public release.

### Added
- Side-by-side preview for `.mu` files, with re-render on save.
- Shebang execution: executable `.mu` scripts are spawned and their stdout is rendered, matching how NomadNet runs them over a Reticulum link.
- In-preview toolbar: Back, Refresh, Raw-source toggle, editable address bar.
- LXMF identity simulation with built-in test identities (Anonymous / Tester Alice / Tester Bob) and user-configurable list (`muPreview.identities`).
- LXMF fingerprint (`remote_identity`) simulation with built-in admin / mod / user defaults across active / suspended / banned states, plus user-configurable list (`muPreview.fingerprints`).
- Bandwidth-budget readout: rendered byte count + estimated transmission time at 3.1 kbps, color-coded against a 3 KB target / 5 KB soft cap.
- Form support: text fields, checkboxes, radios; `Enter` in a text field submits; values flow back to scripts as `field_<name>` and `var_<name>` env vars.
- Configuration surface: `muPreview.python`, `muPreview.executeShebang`, `muPreview.executeTimeoutMs`, `muPreview.slowRenderWarnMs`, `muPreview.refreshOnSave`.
- Keybinding: <kbd>Ctrl</kbd>+<kbd>K</kbd> <kbd>V</kbd> opens the preview for the active `.mu` file.
