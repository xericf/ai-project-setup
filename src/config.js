/**
 * Configuration loading.
 *
 * `agent-meters.config.json` is searched for from the working directory upward to
 * the filesystem root, and merged over the built-in defaults. `--config <path>`
 * overrides the search entirely and must name an existing file.
 *
 * The file is data only: it names log locations and the pacing bands. It never
 * carries credentials, and nothing here reads or prints environment values.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const CONFIG_FILENAME = 'agent-meters.config.json';

export const DEFAULT_CONFIG = Object.freeze({
  claudeProjectDirGlob: '*',
  reviewSummaryDirs: [],
  claudeAgentDefsDir: '.claude/agents',
  claudeSettingsFile: '.claude/settings.json',
  pacing: {
    scarceProvider: 'claude',
    bands: [
      { gapBelow: -10, slots: 2 },
      { gapBelow: 10, inclusive: true, slots: 1 },
      { slots: 0 },
    ],
    sessionBlockUsedPct: 80,
    weeklyReserveUsedPct: 90,
    tierAdvice: {
      perModelMeter: 'Current week (Fable)',
      allModelMeter: 'Current week (all models)',
    },
    sessionMeter: 'Current session',
  },
});

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.category = 'config';
  }
}

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Shallow-per-key deep merge: objects merge, arrays and scalars replace wholesale. */
export function mergeConfig(base, override) {
  if (!isPlainObject(override)) return structuredClone(base);
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    merged[key] = isPlainObject(value) && isPlainObject(merged[key])
      ? mergeConfig(merged[key], value)
      : structuredClone(value);
  }
  return merged;
}

function readJson(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(`Config file could not be read: ${file}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ConfigError(`Config file is not valid JSON: ${file}`);
  }
}

const isFile = candidate => {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
};

/** Walks from `start` to the filesystem root looking for the config file. */
export function findConfigFile(start = process.cwd(), { exists = isFile } = {}) {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (exists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function validate(config, source) {
  const where = source ? ` (${source})` : '';
  const bands = config.pacing?.bands;
  if (!Array.isArray(bands) || !bands.length) {
    throw new ConfigError(`pacing.bands must be a non-empty array${where}.`);
  }
  for (const band of bands) {
    if (!isPlainObject(band) || !Number.isInteger(band.slots) || band.slots < 0) {
      throw new ConfigError(`each pacing band needs an integer slots >= 0${where}.`);
    }
    if (band.gapBelow !== undefined && !Number.isFinite(band.gapBelow)) {
      throw new ConfigError(`pacing band gapBelow must be a number${where}.`);
    }
  }
  if (bands.at(-1).gapBelow !== undefined) {
    throw new ConfigError(`the last pacing band is the fallback and must omit gapBelow${where}.`);
  }
  for (const key of ['sessionBlockUsedPct', 'weeklyReserveUsedPct']) {
    const value = config.pacing[key];
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new ConfigError(`pacing.${key} must be a percentage between 0 and 100${where}.`);
    }
  }
  if (!Array.isArray(config.reviewSummaryDirs)) {
    throw new ConfigError(`reviewSummaryDirs must be an array${where}.`);
  }
  if (typeof config.claudeProjectDirGlob !== 'string' || !config.claudeProjectDirGlob) {
    throw new ConfigError(`claudeProjectDirGlob must be a non-empty string${where}.`);
  }
  return config;
}

/**
 * Resolves the effective config. Returns `{ config, source, root }` where `root` is
 * the directory the config was found in (relative paths resolve against it), and
 * `source` is null when only the defaults apply.
 */
export function loadConfig({ configPath = null, cwd = process.cwd() } = {}) {
  if (configPath) {
    const resolved = path.resolve(cwd, configPath);
    if (!isFile(resolved)) throw new ConfigError(`Config file not found: ${resolved}`);
    const config = mergeConfig(DEFAULT_CONFIG, readJson(resolved));
    return { config: validate(config, resolved), source: resolved, root: path.dirname(resolved) };
  }
  const found = findConfigFile(cwd);
  if (!found) {
    return { config: structuredClone(DEFAULT_CONFIG), source: null, root: path.resolve(cwd) };
  }
  const config = mergeConfig(DEFAULT_CONFIG, readJson(found));
  return { config: validate(config, found), source: found, root: path.dirname(found) };
}

/** Pulls `--config <path>` out of an argv array, returning the rest untouched. */
export function extractConfigFlag(argv) {
  const rest = [];
  let configPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') {
      configPath = argv[index + 1];
      if (!configPath || configPath.startsWith('--')) throw new ConfigError('--config needs a file path.');
      index += 1;
    } else if (arg.startsWith('--config=')) {
      configPath = arg.slice('--config='.length);
      if (!configPath) throw new ConfigError('--config needs a file path.');
    } else {
      rest.push(arg);
    }
  }
  return { configPath, rest };
}
