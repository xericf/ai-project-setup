/**
 * Codex account rate-limit reading.
 *
 * The installed Codex CLI already holds the account rate-limit snapshot. This
 * module spawns `codex app-server`, performs one newline-delimited JSON-RPC
 * handshake over stdio, reads `account/rateLimits/read` and stops the child it
 * owns. No model turn is spent and no network socket is opened by this process.
 *
 * Protocol shape (experimental, so field names are read defensively):
 *   initialize -> initialized -> account/rateLimits/read
 *   result: { rateLimits: { primary, secondary, limitId, planType, ... },
 *             rateLimitsByLimitId: { <limitId>: <same shape> } }
 *   window:  { usedPercent:int, windowDurationMins:int|null, resetsAt:int|null }
 *            where resetsAt is UNIX SECONDS.
 *
 * Window meaning is derived from the duration rather than assumed: a window of at
 * least seven days is the weekly meter and one of at most six hours is the session
 * meter. Plans that report neither are normal; an absent window is null, not zero.
 *
 * The provider payload is never echoed: it carries account identifiers.
 */
import { spawn } from 'node:child_process';
import { classify } from './claude-usage.js';
import { codexKnownPaths, locateExecutable } from './platform.js';

export const CODEX_EXE_ENV = 'AGENT_METERS_CODEX_EXE';

const WEEKLY_MIN_MINS = 7 * 24 * 60;
const SESSION_MAX_MINS = 6 * 60;

const isPct = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

/** Locate the Codex CLI: env override, then PATH, then the known install paths. */
export function locateCodex(options = {}) {
  return locateExecutable({
    name: 'codex',
    envVar: CODEX_EXE_ENV,
    knownPaths: codexKnownPaths(options),
    label: 'Codex CLI',
    ...options,
  });
}

/** Human label for a rate-limit window, derived only from its duration. */
export function windowLabel(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'unknown';
  if (minutes >= WEEKLY_MIN_MINS) return 'weekly';
  if (minutes <= SESSION_MAX_MINS) return 'session';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

const windowMinutes = window => Number(window?.windowDurationMins ?? window?.window_duration_mins ?? Number.NaN);

export function normalizeWindow(window) {
  if (!window || typeof window !== 'object') return null;
  const rawPercent = window.usedPercent ?? window.used_percent;
  const usedPercent = typeof rawPercent === 'string' ? Number(rawPercent) : rawPercent;
  if (!isPct(usedPercent)) return null;
  const minutes = windowMinutes(window);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;

  const raw = window.resetsAt ?? window.resets_at ?? null;
  let resetsAt = null;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    // The protocol reports UNIX seconds; milliseconds are accepted defensively.
    resetsAt = new Date(raw > 1e12 ? raw : raw * 1000).toISOString();
  } else if (typeof raw === 'string' && !Number.isNaN(Date.parse(raw))) {
    resetsAt = new Date(raw).toISOString();
  }
  return { label: windowLabel(minutes), usedPercent, windowDurationMins: minutes, resetsAt };
}

/**
 * Reduce an `account/rateLimits/read` result to the windows it actually reports.
 * `weekly` and `session` are convenience picks; either may legitimately be null.
 */
export function parseCodexRateLimits(result) {
  const buckets = result?.rateLimits ?? result?.rate_limits;
  const byId = result?.rateLimitsByLimitId ?? result?.rate_limits_by_limit_id;
  const snapshot = buckets && typeof buckets === 'object' ? buckets
    : byId && typeof byId === 'object' ? (byId.codex ?? Object.values(byId)[0]) : null;
  if (!snapshot || typeof snapshot !== 'object') {
    return { windows: [], weekly: null, session: null, reached: null };
  }
  const windows = [snapshot.primary, snapshot.secondary]
    .map(normalizeWindow)
    .filter(Boolean);
  return {
    windows,
    weekly: windows.find(window => window.label === 'weekly') ?? null,
    session: windows.find(window => window.label === 'session') ?? null,
    reached: snapshot.rateLimitReachedType ?? snapshot.rate_limit_reached_type ?? null,
  };
}

/** Codex is parked when its weekly reserve is spent or the backend reports a limit. */
export function codexParkedFrom(codex, { weeklyReserveUsedPct = 90 } = {}) {
  if (!codex || codex.error) return false;
  if (codex.reached) return true;
  return isPct(codex.weekly?.usedPercent) && codex.weekly.usedPercent >= weeklyReserveUsedPct;
}

/**
 * Spawn the installed Codex CLI app server, read the account rate limits over
 * newline-delimited JSON-RPC on stdio and stop the owned child.
 */
export function readCodexRateLimits(executable, { timeoutMs = 20_000, clientName = 'agent-meters' } = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(executable, ['app-server'], {
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      resolve({ error: 'local-access' });
      return;
    }

    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = outcome => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Identity-checked stop: only the child this function spawned and still owns.
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ error: 'timeout' }), timeoutMs);

    child.on('error', () => finish({ error: 'local-access' }));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1 && message.result) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} })}\n`);
        } else if (message.id === 1 && message.error) {
          finish({ error: 'protocol' });
        } else if (message.id === 2) {
          // Never echo the provider payload: it carries account identifiers.
          finish(message.result ? parseCodexRateLimits(message.result) : { error: 'protocol' });
        }
      }
    });
    child.on('close', () => finish({ error: classify(stderr) }));
    child.stdin.on('error', () => finish({ error: 'local-access' }));
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { clientInfo: { name: clientName, version: '0.1.0' } },
    })}\n`);
  });
}
