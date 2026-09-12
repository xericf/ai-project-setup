/**
 * Wave pacing.
 *
 * Compares the scarce provider's all-model weekly spend against the elapsed
 * fraction of its weekly window and turns the difference into an implementation
 * slot count, using bands that live in config rather than in this file:
 *
 *   gap = all_model_weekly_pct - week_elapsed_pct
 *
 * Two hard stops sit in front of the bands: session headroom and the weekly
 * reserve. Both are percentages from config.
 *
 * An unreadable meter always yields `null` — "unavailable" — and never zero. That
 * distinction is the whole point: zero slots is a decision, unavailable is not.
 */
import { classify } from './claude-usage.js';
import { codexParkedFrom } from './codex-usage.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round = (value, digits = 1) => Number(value.toFixed(digits));
const isPct = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

/* ------------------------------------------------------------------ pure core */

function zoneOffsetMs(instantMs, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const field = type => Number(parts.find(part => part.type === type)?.value);
  const hour = field('hour') === 24 ? 0 : field('hour');
  return Date.UTC(field('year'), field('month') - 1, field('day'), hour, field('minute'), field('second')) - instantMs;
}

/** Convert a wall-clock reading in `zone` (or local time when absent) to an instant. */
function wallClockToInstant({ year, month, day, hour, minute }, zone) {
  if (!zone) return new Date(year, month, day, hour, minute).getTime();
  const guess = Date.UTC(year, month, day, hour, minute);
  const first = guess - zoneOffsetMs(guess, zone);
  return guess - zoneOffsetMs(first, zone);
}

/**
 * Elapsed fraction of the weekly window, as a percentage, from the reset string the
 * meter reports (for example `Sep 13, 3pm (America/New_York)` or
 * `Sep 13, 3:00pm (America/New_York)`). Returns null when it cannot be parsed —
 * never a guess and never zero. The zone conversion uses `Intl` only, so this stays
 * dependency free and behaves the same on every platform.
 */
export function weekElapsedFrom(resets, now = Date.now()) {
  if (typeof resets !== 'string' || !resets.trim()) return null;
  const text = resets.trim();
  const match = text.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,\s*(\d{4}))?[,\s]+(\d{1,2})(?::(\d{2}))?\s*(?:([AaPp])\.?[Mm]\.?)?/);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1].slice(0, 3).toLowerCase());
  if (month < 0) return null;
  const day = Number(match[2]);
  const meridiem = match[6]?.toLowerCase();
  let hour = Number(match[4]);
  const minute = match[5] ? Number(match[5]) : 0;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === 'p' ? 12 : 0);
  }
  if (day < 1 || day > 31 || hour > 23 || minute > 59) return null;

  let zone = text.match(/\(([^)]+)\)/)?.[1]?.trim() ?? null;
  if (zone) {
    try {
      zoneOffsetMs(now, zone);
    } catch {
      zone = null;
    }
  }

  const nowDate = new Date(now);
  const years = match[3]
    ? [Number(match[3])]
    : [nowDate.getFullYear() - 1, nowDate.getFullYear(), nowDate.getFullYear() + 1];
  // The meter omits the year; take the reading nearest the middle of the window.
  const target = now + WEEK_MS / 2;
  const resetAt = years
    .map(year => wallClockToInstant({ year, month, day, hour, minute }, zone))
    .filter(Number.isFinite)
    .sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
  if (resetAt === undefined) return null;
  return round(clamp((1 - (resetAt - now) / WEEK_MS) * 100, 0, 100));
}

/** gap = all_model_weekly_pct - week_elapsed_pct, or null when either is unknown. */
export function computeGap(weekAllPct, weekElapsedPct) {
  if (!isPct(weekAllPct) || !isPct(weekElapsedPct)) return null;
  return round(weekAllPct - weekElapsedPct);
}

/**
 * The band a gap falls in. A band matches when the gap is below `gapBelow`
 * (strictly, or inclusively when the band sets `inclusive`); the last band omits
 * `gapBelow` and is the fallback.
 */
export function selectBand(bands, gap) {
  for (const band of bands) {
    if (band.gapBelow === undefined) return band;
    if (band.inclusive ? gap <= band.gapBelow : gap < band.gapBelow) return band;
  }
  return bands.at(-1) ?? { slots: 0 };
}

const describeBand = band => (band.gapBelow === undefined
  ? 'above the last band'
  : `below ${band.gapBelow}${band.inclusive ? ' inclusive' : ''}`);

/**
 * The pacing decision: slot count, waiver, model-tier advice and the notes that
 * explain each step. An unreadable meter yields null slots, never zero.
 */
export function decideSlots({ gap, sessionPct, weekAllPct, weekModelPct } = {}, pacing = {}) {
  const bands = Array.isArray(pacing.bands) && pacing.bands.length
    ? pacing.bands
    : [{ gapBelow: -10, slots: 2 }, { gapBelow: 10, inclusive: true, slots: 1 }, { slots: 0 }];
  const sessionBlock = Number.isFinite(pacing.sessionBlockUsedPct) ? pacing.sessionBlockUsedPct : 80;
  const weeklyReserve = Number.isFinite(pacing.weeklyReserveUsedPct) ? pacing.weeklyReserveUsedPct : 90;
  const perModelLabel = pacing.tierAdvice?.perModelMeter ?? 'per-model weekly';
  const allModelLabel = pacing.tierAdvice?.allModelMeter ?? 'all-model weekly';

  const notes = [];
  const advice = isPct(weekModelPct) && isPct(weekAllPct) && weekModelPct > weekAllPct ? 'lower' : 'hold';
  if (advice === 'lower') {
    notes.push(`Per-model weekly (${perModelLabel} ${weekModelPct}%) runs ahead of all-model weekly (${allModelLabel} ${weekAllPct}%): keep the slot count, lower the model tier one step.`);
  } else if (!isPct(weekModelPct)) {
    notes.push('No per-model weekly meter was reported, so there is no tier advice; this is not a zero reading.');
  }

  if (!isPct(sessionPct)) {
    notes.push('Session meter unavailable: slot count is unavailable, not zero.');
    return { slots: null, waived: null, advice, notes };
  }
  if (sessionPct >= sessionBlock) {
    notes.push(`Session meter at ${sessionPct}% used, at or above the ${sessionBlock}% block: no implementation slots.`);
    return { slots: 0, waived: 'quota-blocked', advice, notes };
  }
  if (isPct(weekAllPct) && weekAllPct >= weeklyReserve) {
    notes.push(`Weekly reserve spent (${weekAllPct}% used of the ${weeklyReserve}% ceiling): no implementation slots.`);
    return { slots: 0, waived: 'quota-blocked', advice, notes };
  }
  if (!isPct(weekAllPct)) {
    notes.push('All-model weekly meter unavailable: slot count is unavailable, not zero.');
    return { slots: null, waived: null, advice, notes };
  }
  if (gap === null || gap === undefined || !Number.isFinite(gap)) {
    notes.push('Weekly elapsed fraction unavailable, so the gap and the slot count are unavailable, not zero.');
    return { slots: null, waived: null, advice, notes };
  }

  const band = selectBand(bands, gap);
  const slots = Number.isInteger(band.slots) ? band.slots : 0;
  notes.push(slots > 0
    ? `Gap ${gap} falls in the band ${describeBand(band)}: ${slots} implementation slot(s), plus review.`
    : `Gap ${gap} falls in the band ${describeBand(band)}: review only, no implementation slots. This is pacing, not a quota waiver.`);
  return { slots, waived: null, advice, notes };
}

/* ------------------------------------------------------------------- rendering */

const pct = value => (isPct(value) ? `${value}%` : 'unavailable');

export function formatDispatch(report, pacing = {}) {
  const provider = pacing.scarceProvider ?? 'claude';
  const perModelLabel = report.claude?.modelMeterLabel ?? pacing.tierAdvice?.perModelMeter ?? 'per-model';
  const lines = [];
  const slots = report.claudeSlots === null || report.claudeSlots === undefined ? 'unavailable' : String(report.claudeSlots);
  lines.push(`\`${provider}Slots: ${slots}\`; \`${provider}Assignments\`: <fill in the assigned packets or reviews>.`);
  if (report.claudeWaived) {
    lines.push(`\`${provider}Waived: ${report.claudeWaived}\` — this wave only; it does not carry forward.`);
  }

  const claude = report.claude ?? {};
  lines.push(claude.error
    ? `Claude meters unavailable (${claude.error}); treat as unavailable, not zero.`
    : `Claude meters: session ${pct(claude.session)}, all-model week ${pct(claude.weekAll)}, ${perModelLabel} ${pct(claude.weekModel)}, weekly reset ${claude.weekResets ?? 'unavailable'}.`);

  lines.push(report.gap === null || report.gap === undefined
    ? 'The weekly elapsed fraction is unavailable, so the gap is unavailable and no slot count is asserted.'
    : `The weekly elapsed fraction is approximately ${Math.round(claude.weekElapsedPct)}%, giving a gap near ${report.gap > 0 ? '+' : ''}${Math.round(report.gap)} points.`);

  const codex = report.codex ?? {};
  if (codex.error) {
    lines.push(`Codex meters unavailable (${codex.error}); park state unknown.`);
  } else if (report.codex) {
    const windows = (codex.windows ?? []).length
      ? codex.windows.map(window => `${window.label} ${pct(window.usedPercent)}${window.resetsAt ? ` (resets ${window.resetsAt})` : ''}`).join(', ')
      : 'no windows reported';
    lines.push(`Codex windows: ${windows}; ${report.codexParked ? 'parked until its reported reset' : 'not parked'}.`);
  }

  lines.push(`Model tier: ${report.claudeModelAdvice === 'lower' ? 'lower one step' : 'hold'}.`);
  for (const note of report.notes ?? []) lines.push(`- ${note}`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ assembly */

/** Assembles the report object from already-read meter values. Pure. */
export function buildReport({ claude, codex, weekElapsedOverride = null, notes = [] }, pacing = {}) {
  const extra = [...notes];
  if (claude && !claude.error) {
    claude.weekElapsedPct = weekElapsedOverride ?? weekElapsedFrom(claude.weekResets);
    if (weekElapsedOverride !== null) {
      extra.push(`Weekly elapsed fraction supplied by --week-elapsed (${weekElapsedOverride}%).`);
    } else if (claude.weekElapsedPct === null) {
      extra.push('The weekly reset string could not be parsed; pass --week-elapsed <pct> to supply it.');
    }
  }

  const gap = claude && !claude.error ? computeGap(claude.weekAll, claude.weekElapsedPct) : null;
  const decision = claude && !claude.error
    ? decideSlots({ gap, sessionPct: claude.session, weekAllPct: claude.weekAll, weekModelPct: claude.weekModel }, pacing)
    : { slots: null, waived: null, advice: 'hold', notes: ['No Claude reading, so no slot count is asserted.'] };

  const codexParked = codexParkedFrom(codex, pacing);
  if (codexParked) extra.push('Codex is parked until its reported reset; route eligible independent work to the other provider.');

  return {
    readAt: new Date().toISOString(),
    claude: claude ?? null,
    codex: codex ?? null,
    gap,
    claudeSlots: decision.slots,
    claudeWaived: decision.waived,
    claudeModelAdvice: decision.advice,
    codexParked,
    notes: [...decision.notes, ...extra],
  };
}

/* ------------------------------------------------------------------------ cli */

export const PACING_USAGE = `Usage: agent-pacing [options]

  --dispatch             render the dispatch-record lines (default)
  --json                 render the structured report
  --claude-only          read only the Claude meters
  --codex-only           read only the Codex rate limits
  --week-elapsed <pct>   supply the weekly elapsed fraction instead of deriving it
  --config <path>        use this agent-meters.config.json
  --help                 show this message

Reads local subscription meters only. No model turn is spent, and no provider
output, environment value, token or account id is ever printed.`;

export function parseArgs(argv) {
  const options = { claudeOnly: false, codexOnly: false, weekElapsed: null, dispatch: true, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--claude-only') options.claudeOnly = true;
    else if (arg === '--codex-only') options.codexOnly = true;
    else if (arg === '--json') options.dispatch = false;
    else if (arg === '--dispatch') options.dispatch = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--week-elapsed') {
      const value = Number(argv[index += 1]);
      if (!isPct(value)) throw new Error('--week-elapsed takes a percentage between 0 and 100.');
      options.weekElapsed = round(value);
    } else {
      throw new Error(`Unknown flag: ${arg}. Use --claude-only, --codex-only, --week-elapsed <pct>, --json, --dispatch or --config <path>.`);
    }
  }
  if (options.claudeOnly && options.codexOnly) throw new Error('Use at most one of --claude-only and --codex-only.');
  return options;
}

export { classify, isPct, round };
