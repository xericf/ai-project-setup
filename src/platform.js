/**
 * Cross-platform helpers: home directory, local calendar dates and executable
 * discovery. Everything here is pure apart from read-only `fs` probes, and every
 * entry point accepts injected `env` / `platform` / `home` / `exists` so the tests
 * run identically on Windows, macOS and Linux.
 *
 * Nothing in this module logs environment values, tokens or account identifiers.
 */
import { readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Default, overridable probe: does this absolute path name a readable file? */
export const fileExists = candidate => {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
};

export const homeDir = (env = process.env) => env.AGENT_METERS_HOME || os.homedir();

/**
 * The path flavour for a given platform. Real runs always pass the host platform,
 * so this is the host `path`; tests pass a simulated platform and get the matching
 * separator, delimiter and drive handling on any operating system.
 */
export const pathFor = (platform = process.platform) => (platform === 'win32' ? path.win32 : path.posix);

/* ------------------------------------------------------------------ calendar */

const pad = value => String(value).padStart(2, '0');

/** Local calendar day key, `YYYY-MM-DD`. The ledger filters on local days. */
export function localDateKey(timestamp) {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** UTC calendar day key, `YYYY-MM-DD`. Used by tests and by day-directory slack. */
export function utcDateKey(timestamp) {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

export const todayKey = (now = new Date()) => localDateKey(now);

/** Shift a `YYYY-MM-DD` key by whole days without crossing a DST boundary. */
export function shiftDay(key, days) {
  const date = new Date(`${key}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return key;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/* ---------------------------------------------------------------- PATH lookup */

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const SHIM_EXTENSIONS = new Set(['.cmd', '.bat', '.ps1']);

export const isShim = (candidate, platform = process.platform) =>
  SHIM_EXTENSIONS.has(pathFor(platform).extname(candidate).toLowerCase());

function extensionsFor(platform, env) {
  if (platform !== 'win32') return [''];
  const list = String(env.PATHEXT || DEFAULT_PATHEXT)
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    // Windows paths are case insensitive; lower-casing keeps the reported path and
    // the shim check stable whatever casing PATHEXT happens to use.
    .map(part => (part.startsWith('.') ? part : `.${part}`).toLowerCase());
  return ['', ...list];
}

/**
 * A tiny `which`: walks `PATH` split by `path.delimiter` and honours `PATHEXT` on
 * Windows. No shell is spawned, so a `.cmd` shim is reported as what it is rather
 * than silently executed. Returns every hit, in lookup order.
 */
export function whichAll(name, { env = process.env, platform = process.platform, exists = fileExists } = {}) {
  if (!name) return [];
  const p = pathFor(platform);
  const dirs = String(env.PATH ?? env.Path ?? '')
    .split(p.delimiter)
    .map(dir => dir.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  const extensions = extensionsFor(platform, env);
  const hits = [];
  const seen = new Set();
  for (const dir of dirs) {
    for (const extension of extensions) {
      // On Windows a bare name is not executable on its own; PATHEXT supplies it.
      if (extension === '' && platform === 'win32' && !p.extname(name)) continue;
      const candidate = p.join(dir, `${name}${extension}`);
      const key = platform === 'win32' ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) continue;
      seen.add(key);
      if (exists(candidate)) hits.push(candidate);
    }
  }
  return hits;
}

/** The first real (non-shim) hit, else the first shim, else null. */
export function which(name, options = {}) {
  const { platform = process.platform } = options;
  const hits = whichAll(name, options);
  return hits.find(hit => !isShim(hit, platform)) ?? hits[0] ?? null;
}

/**
 * On Windows a `.cmd` shim can only be spawned with `shell: true`, which this tool
 * refuses. Try the real binary sitting beside the shim before giving up.
 */
export function resolveShim(shim, { exists = fileExists, platform = process.platform } = {}) {
  const p = pathFor(platform);
  const dir = p.dirname(shim);
  const base = p.basename(shim, p.extname(shim));
  for (const extension of ['.exe', '.com']) {
    const candidate = p.join(dir, `${base}${extension}`);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/* ------------------------------------------------------------ known locations */

const EXTENSION_PLATFORMS = ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];

const compareVersions = (a, b) => {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (right[index] ?? 0) - (left[index] ?? 0);
    if (delta) return delta;
  }
  return 0;
};

function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch {
    return [];
  }
}

/**
 * VS Code bundles a native Claude binary inside the extension directory. Newest
 * version first; only tags for the running platform are considered.
 */
export function vscodeClaudeCandidates({
  home = homeDir(), platform = process.platform, readDirs = listDirs,
} = {}) {
  const p = pathFor(platform);
  const extensions = p.join(home, '.vscode', 'extensions');
  const tags = EXTENSION_PLATFORMS.filter(tag => tag.startsWith(`${platform}-`));
  if (!tags.length) return [];
  const pattern = new RegExp(`^anthropic\\.claude-code-([\\d.]+)-(${tags.join('|')})$`);
  return readDirs(extensions)
    .map(name => ({ name, version: pattern.exec(name)?.[1] ?? null }))
    .filter(entry => entry.version)
    .sort((a, b) => compareVersions(a.version, b.version) || b.name.localeCompare(a.name))
    .map(entry => p.join(
      extensions, entry.name, 'resources', 'native-binary', platform === 'win32' ? 'claude.exe' : 'claude',
    ));
}

/** Ordered list of well-known Claude install locations for this platform. */
export function claudeKnownPaths(options = {}) {
  const { platform = process.platform } = options;
  const home = options.home ?? homeDir(options.env ?? process.env);
  const p = pathFor(platform);
  const binary = platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates = [p.join(home, '.local', 'bin', binary)];
  candidates.push(...vscodeClaudeCandidates({ ...options, home, platform }));
  candidates.push(p.join(home, '.npm-global', 'bin', binary));
  if (platform !== 'win32') {
    candidates.push('/usr/local/bin/claude', '/opt/homebrew/bin/claude');
  }
  // `/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js` is a JS entry
  // point, not a native binary, so it is deliberately not offered here.
  return candidates;
}

function codexHashDirCandidates({
  env = process.env, home, platform = process.platform, exists = fileExists, readDirs = listDirs, mtime = file => {
    try {
      return statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  },
} = {}) {
  const p = pathFor(platform);
  const localAppData = env.LOCALAPPDATA || p.join(env.USERPROFILE || home || '', 'AppData', 'Local');
  const bin = p.join(localAppData, 'OpenAI', 'Codex', 'bin');
  return readDirs(bin)
    .map(name => p.join(bin, name, 'codex.exe'))
    .filter(exists)
    .map(file => ({ file, at: mtime(file) }))
    .sort((a, b) => b.at - a.at)
    .map(entry => entry.file);
}

/** Ordered list of well-known Codex install locations for this platform. */
export function codexKnownPaths(options = {}) {
  const { env = process.env, platform = process.platform } = options;
  const home = options.home ?? homeDir(env);
  const p = pathFor(platform);
  if (platform === 'win32') {
    return [
      ...codexHashDirCandidates({ ...options, env, home, platform }),
      p.join(home, '.codex', 'bin', 'codex.exe'),
      p.join(home, '.local', 'bin', 'codex.exe'),
    ];
  }
  return [
    p.join(home, '.codex', 'bin', 'codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
    p.join(home, '.local', 'bin', 'codex'),
  ];
}

export class DiscoveryError extends Error {
  constructor(message, category = 'not-found') {
    super(message);
    this.name = 'DiscoveryError';
    this.category = category;
  }
}

/**
 * Discovery order: the env override, then PATH, then the known locations. A
 * Windows `.cmd` shim is never returned: the real binary beside it is used, or the
 * caller is told to set the override.
 */
export function locateExecutable({
  name,
  envVar,
  knownPaths = [],
  env = process.env,
  platform = process.platform,
  exists = fileExists,
  label = name,
}) {
  const p = pathFor(platform);
  const explicit = env[envVar];
  if (explicit) {
    if (!p.isAbsolute(explicit) || !exists(explicit)) {
      throw new DiscoveryError(`${envVar} must name an existing absolute executable.`, 'config');
    }
    if (isShim(explicit, platform)) {
      const real = resolveShim(explicit, { exists, platform });
      if (!real) {
        throw new DiscoveryError(`${envVar} found a cmd shim; set ${envVar} to the real binary.`, 'config');
      }
      return real;
    }
    return explicit;
  }

  const hits = whichAll(name, { env, platform, exists });
  const direct = hits.find(hit => !isShim(hit, platform));
  if (direct) return direct;

  for (const candidate of knownPaths) {
    if (exists(candidate) && !isShim(candidate, platform)) return candidate;
  }

  if (hits.length) {
    const real = resolveShim(hits[0], { exists, platform });
    if (real) return real;
    throw new DiscoveryError(`${label}: found a cmd shim; set ${envVar} to the real binary.`, 'config');
  }
  throw new DiscoveryError(`${label} not found. Set ${envVar} to the installed binary.`, 'not-found');
}
