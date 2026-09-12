import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DiscoveryError, claudeKnownPaths, codexKnownPaths, fileExists, isShim, localDateKey,
  locateExecutable, resolveShim, shiftDay, utcDateKey, vscodeClaudeCandidates, which, whichAll,
} from '../src/platform.js';

// No real login, binary or home directory is touched: `exists`, `env` and `platform`
// are injected. Simulated Windows paths are built with `path.win32` and POSIX ones
// with `path.posix`, so these assertions hold identically on every host OS.
const win = path.win32;
const posix = path.posix;
const winEnv = (dirs, extra = {}) => ({ PATH: dirs.join(win.delimiter), PATHEXT: '.COM;.EXE;.BAT;.CMD', ...extra });
const posixEnv = (dirs, extra = {}) => ({ PATH: dirs.join(posix.delimiter), ...extra });
const existsIn = set => candidate => set.has(candidate);
const C = `C:${win.sep}`;

test('local and UTC date keys are zero padded and reject nonsense', () => {
  assert.equal(utcDateKey('2026-09-12T23:30:00.000Z'), '2026-09-12');
  assert.equal(utcDateKey('not a date'), null);
  assert.equal(localDateKey(new Date(2026, 0, 5, 12, 0, 0)), '2026-01-05');
  assert.equal(localDateKey('nope'), null);
});

test('shiftDay moves whole calendar days in both directions', () => {
  assert.equal(shiftDay('2026-09-12', -7), '2026-09-05');
  assert.equal(shiftDay('2026-09-12', -30), '2026-08-13');
  assert.equal(shiftDay('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDay('2026-02-28', 1), '2026-03-01');
});

test('which walks PATH and applies PATHEXT on win32 only', () => {
  const dirA = win.join(C, 'tools');
  const dirB = win.join(C, 'other');
  const hits = new Set([win.join(dirB, 'codex.exe')]);
  assert.equal(
    which('codex', { env: winEnv([dirA, dirB]), platform: 'win32', exists: existsIn(hits) }),
    win.join(dirB, 'codex.exe'),
  );
  // The same lookup on POSIX never appends an extension.
  const posixHits = new Set(['/usr/local/bin/codex']);
  assert.equal(
    which('codex', { env: posixEnv(['/usr/bin', '/usr/local/bin']), platform: 'linux', exists: existsIn(posixHits) }),
    '/usr/local/bin/codex',
  );
  assert.equal(which('codex', { env: posixEnv(['/usr/bin']), platform: 'linux', exists: () => false }), null);
  assert.deepEqual(whichAll('claude', { env: { PATH: '' }, platform: 'linux', exists: () => true }), []);
});

test('PATH entries are trimmed, de-duplicated and unquoted', () => {
  const dir = win.join(C, 'tools');
  const env = winEnv([`"${dir}"`, ` ${dir} `, '']);
  const hits = new Set([win.join(dir, 'claude.exe')]);
  assert.deepEqual(
    whichAll('claude', { env, platform: 'win32', exists: existsIn(hits) }),
    [win.join(dir, 'claude.exe')],
  );
});

test('a real binary beats a cmd shim wherever it sits on PATH', () => {
  const shimDir = win.join(C, 'npm');
  const realDir = win.join(C, 'native');
  const hits = new Set([win.join(shimDir, 'codex.cmd'), win.join(realDir, 'codex.exe')]);
  assert.ok(isShim(win.join(shimDir, 'codex.cmd'), 'win32'));
  assert.ok(!isShim(win.join(realDir, 'codex.exe'), 'win32'));
  assert.equal(
    locateExecutable({
      name: 'codex', envVar: 'AGENT_METERS_CODEX_EXE', platform: 'win32',
      env: winEnv([shimDir, realDir]), exists: existsIn(hits),
    }),
    win.join(realDir, 'codex.exe'),
  );
});

test('a lone cmd shim resolves to the binary beside it, or reports the shim', () => {
  const dir = win.join(C, 'npm');
  const shim = win.join(dir, 'codex.cmd');
  const withReal = new Set([shim, win.join(dir, 'codex.exe')]);
  assert.equal(
    resolveShim(shim, { exists: existsIn(withReal), platform: 'win32' }),
    win.join(dir, 'codex.exe'),
  );

  const onlyShim = new Set([shim]);
  assert.equal(resolveShim(shim, { exists: existsIn(onlyShim), platform: 'win32' }), null);
  assert.throws(
    () => locateExecutable({
      name: 'codex', envVar: 'AGENT_METERS_CODEX_EXE', platform: 'win32',
      env: winEnv([dir]), exists: existsIn(onlyShim), label: 'Codex CLI',
    }),
    error => error instanceof DiscoveryError
      && /found a cmd shim; set AGENT_METERS_CODEX_EXE to the real binary/.test(error.message)
      && error.category === 'config',
  );
});

test('the env override wins, and must be an existing absolute path', () => {
  const real = win.join(C, 'custom', 'claude.exe');
  const hits = new Set([real, win.join(C, 'tools', 'claude.exe')]);
  assert.equal(
    locateExecutable({
      name: 'claude', envVar: 'AGENT_METERS_CLAUDE_EXE', platform: 'win32',
      env: winEnv([win.join(C, 'tools')], { AGENT_METERS_CLAUDE_EXE: real }), exists: existsIn(hits),
    }),
    real,
  );
  assert.throws(() => locateExecutable({
    name: 'claude', envVar: 'AGENT_METERS_CLAUDE_EXE', platform: 'win32',
    env: winEnv([], { AGENT_METERS_CLAUDE_EXE: 'claude.exe' }), exists: () => true,
  }), /must name an existing absolute executable/);
  assert.throws(() => locateExecutable({
    name: 'claude', envVar: 'AGENT_METERS_CLAUDE_EXE', platform: 'win32',
    env: winEnv([], { AGENT_METERS_CLAUDE_EXE: real }), exists: () => false,
  }), /must name an existing absolute executable/);
});

test('known locations are consulted after PATH, in order', () => {
  const known = [win.join(C, 'a', 'claude.exe'), win.join(C, 'b', 'claude.exe')];
  const hits = new Set(known);
  assert.equal(
    locateExecutable({
      name: 'claude', envVar: 'AGENT_METERS_CLAUDE_EXE', platform: 'win32',
      env: winEnv([win.join(C, 'empty')]), exists: existsIn(hits), knownPaths: known,
    }),
    known[0],
  );
  assert.throws(
    () => locateExecutable({
      name: 'claude', envVar: 'AGENT_METERS_CLAUDE_EXE', platform: 'linux',
      env: posixEnv(['/usr/bin']), exists: () => false, knownPaths: ['/opt/nope'], label: 'Claude CLI',
    }),
    error => error.category === 'not-found' && /Set AGENT_METERS_CLAUDE_EXE/.test(error.message),
  );
});

test('the VS Code extension bundle is picked by platform tag and newest version', () => {
  const readDirs = () => [
    'anthropic.claude-code-2.10.0-win32-x64',
    'anthropic.claude-code-2.9.9-win32-x64',
    'anthropic.claude-code-2.11.0-darwin-arm64',
    'ms-python.python-2026.1.0',
  ];
  const windows = vscodeClaudeCandidates({ home: win.join(C, 'Users', 'x'), platform: 'win32', readDirs });
  assert.equal(windows.length, 2);
  assert.ok(windows[0].endsWith(win.join('anthropic.claude-code-2.10.0-win32-x64', 'resources', 'native-binary', 'claude.exe')));
  assert.ok(windows[1].includes('2.9.9'), '2.10.0 sorts above 2.9.9 numerically, not lexically');

  const mac = vscodeClaudeCandidates({ home: '/Users/x', platform: 'darwin', readDirs });
  assert.equal(mac.length, 1);
  assert.ok(mac[0].endsWith(posix.join('resources', 'native-binary', 'claude')), 'no .exe off Windows');

  assert.deepEqual(vscodeClaudeCandidates({ home: '/home/x', platform: 'sunos', readDirs }), []);
});

test('the known-path lists match the documented per-platform order', () => {
  const linux = claudeKnownPaths({ home: '/home/x', platform: 'linux', readDirs: () => [] });
  assert.deepEqual(linux, [
    posix.join('/home/x', '.local', 'bin', 'claude'),
    posix.join('/home/x', '.npm-global', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ]);
  assert.ok(!linux.some(candidate => candidate.endsWith('cli.js')), 'the npm cli.js entry point is not a native binary');

  const mac = codexKnownPaths({ home: '/Users/x', platform: 'darwin', env: {} });
  assert.deepEqual(mac, [
    posix.join('/Users/x', '.codex', 'bin', 'codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
    posix.join('/Users/x', '.local', 'bin', 'codex'),
  ]);
});

test('the newest Codex hash directory wins and directories without the exe are skipped', () => {
  const localAppData = win.join(C, 'Users', 'x', 'AppData', 'Local');
  const bin = win.join(localAppData, 'OpenAI', 'Codex', 'bin');
  const older = win.join(bin, 'aaa', 'codex.exe');
  const newer = win.join(bin, 'bbb', 'codex.exe');
  const candidates = codexKnownPaths({
    home: win.join(C, 'Users', 'x'),
    platform: 'win32',
    env: { LOCALAPPDATA: localAppData },
    readDirs: dir => (dir === bin ? ['aaa', 'bbb', 'ccc-empty'] : []),
    exists: candidate => candidate === older || candidate === newer,
    mtime: candidate => (candidate === newer ? 2000 : 1000),
  });
  assert.equal(candidates[0], newer);
  assert.equal(candidates[1], older);
  assert.ok(!candidates.some(candidate => candidate.includes('ccc-empty')));
  assert.ok(candidates.includes(win.join(C, 'Users', 'x', '.codex', 'bin', 'codex.exe')));
});

test('fileExists reports files, not directories, against a real tmpdir', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'agent-meters-exe-'));
  const dir = path.join(base, 'bin');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex');
  writeFileSync(file, '#!/bin/sh\n');
  assert.equal(fileExists(file), true);
  assert.equal(fileExists(dir), false);
  assert.equal(fileExists(path.join(dir, 'missing')), false);
  // Host defaults: this exercises the real PATHEXT branch on Windows and the bare
  // name on macOS and Linux, from one assertion.
  assert.equal(which('codex', { env: { PATH: dir } }), file);
});
