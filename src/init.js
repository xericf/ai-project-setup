/**
 * Project bootstrap: copies the policy skeleton, prompt templates, guidance folder and
 * config into a repository without overwriting anything that already exists. Prints what
 * it wrote and what it left alone.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILENAME } from './config.js';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Destination (relative to the project) → source (relative to the package templates). */
export const INIT_FILES = Object.freeze({
  'AGENTS.md': 'AGENTS.md',
  'templates/WAVE_PROMPT.md': 'WAVE_PROMPT.md',
  'templates/WATCHER_GOAL.md': 'WATCHER_GOAL.md',
  'templates/TASK_PROMPT.md': 'TASK_PROMPT.md',
  'templates/REVIEW_PROMPT.md': 'REVIEW_PROMPT.md',
  'execution/guidance/PRIORITY.md': 'PRIORITY.md',
  'execution/guidance/README.md': 'GUIDANCE_README.md',
  'execution/RESUME_STATUS.md': 'RESUME_STATUS.md',
});

export const GITIGNORE_LINES = Object.freeze([
  '# agent-wave state and raw evidence stay local',
  '.agent-waves/',
  'docs/evidence/**/*.png', 'docs/evidence/**/*.jpg', 'docs/evidence/**/*.json', 'docs/evidence/**/*.txt', 'docs/evidence/**/*.log',
  'docs/evidence/**/*.mp4', 'docs/evidence/**/*.wav', 'docs/evidence/**/*.zip',
  '!docs/evidence/**/manifest.json', '!docs/evidence/**/samples/**',
]);

export function initProject({ target, templatesDir = path.join(PACKAGE_ROOT, 'templates'), force = false } = {}) {
  const written = [];
  const kept = [];
  for (const [dest, src] of Object.entries(INIT_FILES)) {
    const to = path.join(target, dest);
    if (existsSync(to) && !force) { kept.push(dest); continue; }
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(path.join(templatesDir, src), to);
    written.push(dest);
  }
  const configPath = path.join(target, CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    const sample = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, CONFIG_FILENAME), 'utf8'));
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);
    written.push(CONFIG_FILENAME);
  } else kept.push(CONFIG_FILENAME);
  const gitignore = path.join(target, '.gitignore');
  const existing = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  const missing = GITIGNORE_LINES.filter(line => !existing.split(/\r?\n/).includes(line));
  if (missing.length) {
    writeFileSync(gitignore, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
    written.push('.gitignore (appended)');
  }
  return { written, kept };
}

export const INIT_USAGE = `Usage: agent-init [<project-dir>] [--force]

Copies AGENTS.md, the prompt templates, execution/guidance/ and a starter
agent-meters.config.json into the project, and appends the local-state gitignore lines.
Existing files are kept unless --force is given.
`;
