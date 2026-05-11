import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Identity } from './identity';

const SHEBANG = '#!';

export interface MicronRender {
  fragment: string;     // body HTML from `micron2html --fragment`
  assetsDir: string;    // directory containing micron-meshchat.css + the bundled TTF
  micronBytes: number;  // byte length of the micron source the script emitted (UTF-8).
                        // What would actually be transmitted over the wire on real
                        // nomadnet — used by the toolbar bandwidth readout.
}

export async function renderMuToFragment(
  filePath: string,
  context: vscode.ExtensionContext,
  identity?: Identity,
  fingerprint?: string,
  fields?: Record<string, string>,
): Promise<MicronRender> {
  const micronSource = await getMicronSource(filePath, identity, fingerprint, fields);
  const python = resolvePython(context);
  const fragment = await convertWithMicron2Html(micronSource, python, context);
  const assetsDir = locateAssets(python);
  const micronBytes = Buffer.byteLength(micronSource, 'utf8');
  return { fragment, assetsDir, micronBytes };
}

/** Return the micron source bytes that would be sent to the viewer:
 *  the script's stdout when it has a shebang and execution is enabled,
 *  otherwise the file contents verbatim. This is what the bandwidth
 *  readout measures and what the raw-view toolbar button shows. */
export async function getMicronSource(
  filePath: string,
  identity?: Identity,
  fingerprint?: string,
  fields?: Record<string, string>,
): Promise<string> {
  const cfg = vscode.workspace.getConfiguration('muPreview');
  const executeShebang = cfg.get<boolean>('executeShebang', true);
  const timeoutMs = cfg.get<number>('executeTimeoutMs', 5000);
  const raw = await fs.readFile(filePath, 'utf8');
  const hasShebang = raw.startsWith(SHEBANG);
  return hasShebang && executeShebang
    ? executeMu(filePath, timeoutMs, identity, fingerprint, fields)
    : raw;
}

export function getAssetsDir(context: vscode.ExtensionContext): string {
  return locateAssets(resolvePython(context));
}

function executeMu(
  filePath: string,
  timeoutMs: number,
  identity?: Identity,
  fingerprint?: string,
  fields?: Record<string, string>,
): Promise<string> {
  // Inject env vars that nomadnet would normally provide to a .mu
  // script over a Reticulum link. nomadForum (and anything else that
  // calls handle_ids() / inspects os.environ) reads link_id and
  // remote_identity from here.
  //
  // - identity → link_id (per-session ID, owned by IdentityManager)
  // - fingerprint → remote_identity (persistent ID hash, owned by
  //   FingerprintManager and only set when its toggle is on)
  // - fields → field_<name> AND var_<name> for every entry. Forms in
  //   nomadnet expose values as field_<name>; URL-style query params
  //   come through as var_<name>; .mu pages typically check both, so
  //   we just set both and let the page do whichever lookup it likes.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (identity)    env.link_id         = identity.linkId;
  if (fingerprint) env.remote_identity = fingerprint;
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      env[`field_${k}`] = v;
      env[`var_${k}`]   = v;
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(filePath, [], {
      cwd: path.dirname(filePath),
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      clearTimeout(timer);
      reject(new Error(`Could not execute ${filePath}: ${err.message}\n\nIs the file marked executable (chmod +x)?`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(new Error(`Script timed out after ${timeoutMs}ms.\n\nstderr:\n${stderr}`));
      }
      if (code !== 0) {
        return reject(new Error(`Script exited with code ${code}.\n\nstderr:\n${stderr}`));
      }
      resolve(stdout);
    });
  });
}

function convertWithMicron2Html(
  micron: string,
  python: string,
  context: vscode.ExtensionContext,
): Promise<string> {
  // Our own wrapper at python/render.py uses a passthrough URL resolver,
  // so :/page/... destinations survive into the emitted <a href> instead
  // of being rewritten to "#" by micron2html's default resolver.
  const script = path.join(context.extensionPath, 'python', 'render.py');
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => reject(new Error(installHint(python, err.message))));
    child.on('close', code => {
      if (code !== 0) {
        return reject(new Error(installHint(python, `micron2html exited with code ${code}.\n\nstderr:\n${stderr}`)));
      }
      resolve(stdout);
    });
    child.stdin.write(micron);
    child.stdin.end();
  });
}

let assetsCache: { python: string; dir: string } | null = null;

function locateAssets(python: string): string {
  if (assetsCache && assetsCache.python === python) return assetsCache.dir;
  const result = spawnSync(
    python,
    ['-c', 'import micron2html, os; print(os.path.dirname(os.path.abspath(micron2html.__file__)))'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(installHint(python, `Could not locate micron2html package directory.\n\nstderr:\n${result.stderr}`));
  }
  const dir = result.stdout.trim();
  assetsCache = { python, dir };
  return dir;
}

function resolvePython(context: vscode.ExtensionContext): string {
  const cfg = vscode.workspace.getConfiguration('muPreview');
  const configured = cfg.get<string>('python', '').trim();
  if (configured) return configured;
  const venv = path.join(context.extensionPath, '.venv');
  return os.platform() === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python');
}

function installHint(python: string, detail: string): string {
  return [
    detail,
    '',
    `Python tried: ${python}`,
    '',
    'To set up the bundled venv (run from the extension folder):',
    '  python3 -m venv .venv',
    '  .venv/bin/pip install -e ../Micron2HTML',
    '',
    'Or point muPreview.python at a Python that already has micron2html installed.',
  ].join('\n');
}
