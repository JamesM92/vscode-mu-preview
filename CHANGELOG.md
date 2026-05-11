# Changelog

All notable changes to the **Micron (.mu) Preview** extension are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
