/**
 * Integrator guard.
 *
 * The integrator session that runs a wave must not write product code itself. The rule
 * is checked from git history alone: every non-merge commit in `<since>..HEAD` that
 * changes a file under an implementation root, outside the integrator-owned prefixes,
 * must carry an `Integrates:` trailer naming the reviewed lease it came from. Nothing
 * here reads file contents, prompts or credentials; it prints commit ids, subjects and
 * paths only.
 */
import { spawnSync } from 'node:child_process';

const SEP = '\x1f';

export function gitOutput(args, { cwd, spawn = spawnSync } = {}) {
  const result = spawn('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`git could not be spawned: ${result.error.code ?? 'unknown'}`);
  if (result.status !== 0) throw new Error(`git ${args[0]} failed (exit ${result.status})`);
  return result.stdout;
}

/** True when `file` is implementation code the integrator may not edit directly. */
export function isImplementationPath(file, { implementationRoots = [], ownedPrefixes = [] } = {}) {
  return implementationRoots.some(root => file.startsWith(root)) && !ownedPrefixes.some(prefix => file.startsWith(prefix));
}

const RECORD = '\x1e';

/** Parses one `git log` record produced by `logFormat()`. Trailer values end in newlines. */
export function parseLogLine(record) {
  const [sha, parents, subject, integrates, reviewedBy] = record.split(SEP).map(field => (field ?? '').trim());
  return {
    sha,
    merge: parents.split(' ').filter(Boolean).length > 1,
    subject,
    integrates,
    reviewedBy,
  };
}

/**
 * `%x1f` separates fields and `%x1e` terminates the record, both written as escapes so
 * the control bytes never travel in argv. Records are needed because a trailer value is
 * printed with its own trailing newline.
 */
export function logFormat(guard) {
  return `%H%x1f%P%x1f%s%x1f%(trailers:key=${guard.integratesTrailer},valueonly)%x1f%(trailers:key=${guard.reviewedTrailer},valueonly)%x1e`;
}

export function splitRecords(output) {
  return output.split(RECORD).map(record => record.replace(/^\s+/, '')).filter(record => record.trim());
}

/**
 * Runs the guard over `since..HEAD`. `files(sha)` may be injected for tests; by default
 * it lists the paths changed by the commit.
 */
export function runGuard({ since, cwd = process.cwd(), guard, spawn = spawnSync, files } = {}) {
  const git = args => gitOutput(args, { cwd, spawn });
  const changed = files ?? (sha => git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha]).split('\n').filter(Boolean));
  const commits = splitRecords(git(['log', `--format=${logFormat(guard)}`, `${since}..HEAD`])).map(parseLogLine);
  const violations = [];
  const warnings = [];
  let integrations = 0;
  for (const commit of commits) {
    if (commit.merge) continue;
    const paths = changed(commit.sha);
    const implementation = paths.filter(file => isImplementationPath(file, guard));
    const evidence = paths.filter(file => file.startsWith(guard.evidenceDir));
    if (commit.integrates) integrations += 1;
    if (implementation.length && !commit.integrates) {
      violations.push({ sha: commit.sha.slice(0, 9), subject: commit.subject, files: implementation.slice(0, 8), more: Math.max(0, implementation.length - 8) });
    }
    if (commit.integrates && !commit.reviewedBy) {
      warnings.push(`${commit.sha.slice(0, 9)} integrates without a ${guard.reviewedTrailer}: trailer: ${commit.subject}`);
    }
    if (evidence.length > guard.evidenceWarnFiles) {
      warnings.push(`${commit.sha.slice(0, 9)} adds ${evidence.length} files under ${guard.evidenceDir} (commit README, manifest and samples only): ${commit.subject}`);
    }
  }
  const head = git(['rev-parse', '--short', 'HEAD']).trim();
  return { since, head, commits: commits.length, integrations, violations, warnings };
}

export function formatGuard(report) {
  const lines = [
    `integrator guard: ${report.commits} commit(s) in ${report.since}..${report.head}, ${report.integrations} with an integration trailer, ${report.violations.length} violation(s), ${report.warnings.length} warning(s)`,
  ];
  for (const v of report.violations) {
    lines.push(`- VIOLATION ${v.sha} ${v.subject}`);
    for (const file of v.files) lines.push(`    ${file}`);
    if (v.more) lines.push(`    (+${v.more} more)`);
  }
  for (const w of report.warnings) lines.push(`- warning: ${w}`);
  if (!report.violations.length) lines.push('- no direct implementation commits found');
  return lines.join('\n');
}

export const GUARD_USAGE = `Usage: agent-guard --since <ref> [--json] [--strict] [--config path]

  --since <ref>   first commit NOT checked; the range is <ref>..HEAD (default HEAD~20)
  --json          structured report
  --strict        exit 1 when there is any violation
`;

export function parseGuardArgs(argv) {
  const options = { since: 'HEAD~20', json: false, strict: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--since') { options.since = argv[++i]; if (!options.since) throw new Error('--since needs a ref.'); }
    else if (arg.startsWith('--since=')) options.since = arg.slice(8);
    else if (arg === '--json') options.json = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}
