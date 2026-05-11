import * as fs from 'fs';
import * as path from 'path';

export type ResolvedDestination =
  | { kind: 'local'; path: string }
  | { kind: 'external'; url: string }
  | { kind: 'unsupported'; message: string }
  | { kind: 'error'; message: string };

const LOCAL_PAGE_PREFIX = ':/page/';

export function resolveDestination(dest: string, currentFile: string): ResolvedDestination {
  // External http(s) - hand off to the system browser.
  if (/^https?:\/\//i.test(dest)) {
    return { kind: 'external', url: dest };
  }

  // LXMF address - reserved for the future identity-simulation feature.
  if (dest.startsWith('lxmf@')) {
    return {
      kind: 'unsupported',
      message: `LXMF addresses can't be opened from the preview yet (${dest}). Multi-identity simulation is on the roadmap.`,
    };
  }

  // Local-node link: ":/page/<rel-path>"
  if (dest.startsWith(LOCAL_PAGE_PREFIX)) {
    const root = findPagesRoot(currentFile);
    if (!root) {
      return {
        kind: 'error',
        message: `Directory issue: no "pages" folder found above ${currentFile}. Link "${dest}" cannot be followed.`,
      };
    }
    const rel = dest.slice(LOCAL_PAGE_PREFIX.length);
    const target = path.join(root, rel);
    if (!fs.existsSync(target)) {
      return { kind: 'error', message: `Link target does not exist: ${target}` };
    }
    if (!fs.statSync(target).isFile()) {
      return { kind: 'error', message: `Link target is not a file: ${target}` };
    }
    return { kind: 'local', path: target };
  }

  // Cross-node link "<hex-hash>:/page/..."
  if (/^[0-9a-f]+:\/page\//i.test(dest)) {
    return {
      kind: 'unsupported',
      message: `Cross-node link can't be opened from the preview (${dest}). Multi-node simulation is on the roadmap.`,
    };
  }

  return { kind: 'unsupported', message: `Unrecognized link destination: ${dest}` };
}

/**
 * Walk up from the current file's directory looking for an ancestor
 * literally named "pages". Returns its absolute path, or undefined if
 * no such directory exists in the ancestry.
 *
 * Per project convention, every nomadnet site lives under a `pages/`
 * directory, and ":/page/X" links resolve relative to that root.
 */
function findPagesRoot(filePath: string): string | undefined {
  let dir = path.dirname(path.resolve(filePath));
  while (true) {
    if (path.basename(dir) === 'pages') return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
