// ============================================================================
// backend.mjs — the action's two conversations with the Autobot backend.
// Zero npm deps (native fetch/FormData); auth = Bearer AUTOBOT_API_KEY.
//
//   node backend.mjs start    metering check + issue run_id (BEFORE any
//                             expensive work — a drained account fails in
//                             seconds, not after minutes of build + LLM spend)
//   node backend.mjs upload   zip $RUN_DIR and POST it against $AUTOBOT_RUN_ID
//   node backend.mjs log      ship the run outcome (or its absence — a run
//                             step that died before ci-summary.json) to our
//                             operational-telemetry store; always() step
//
// `start` is fatal only on a definitive 402 (out of runs); backend outages
// degrade to a warning + no run-id, which skips upload — the LLM relay still
// meters credits, so nothing runs free.
// ============================================================================
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const cmd = process.argv[2];
const BACKEND = (process.env.AUTOBOT_BACKEND_URL || 'https://fastfind.app').replace(/\/$/, '');
const KEY = process.env.AUTOBOT_API_KEY;
if (!KEY) { console.error('backend: AUTOBOT_API_KEY is not set'); process.exit(1); }

const setOutput = (k, v) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
};

// PR metadata from the Actions event. For pull_request events use the HEAD sha,
// not GITHUB_SHA (the synthetic merge commit) — check runs must attach to the
// commit that actually appears on the PR.
function runMeta() {
  let event = {};
  try { event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')); } catch { /* not in Actions */ }
  const pr = event.pull_request;
  return {
    repo: process.env.GITHUB_REPOSITORY || '',
    sha: pr?.head?.sha || process.env.GITHUB_SHA || '',
    branch: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || '',
    pr_number: pr?.number ?? null,
    platform: 'web',
  };
}

if (cmd === 'start') {
  const meta = runMeta();
  if (!meta.repo) { console.error('backend: not running inside GitHub Actions (no GITHUB_REPOSITORY) — skipping run start'); process.exit(0); }
  try {
    const res = await fetch(`${BACKEND}/autobot-cloud/run/start`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(meta),
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 402) {
      const body = await res.json().catch(() => ({}));
      console.error('backend: this account is out of Autobot runs — visit your dashboard to get more.');
      console.error(`AUTOBOT_RUNS_EXHAUSTED runs_remaining=${body.runs_remaining ?? 0}`);
      process.exit(1);
    }
    if (res.status === 401 || res.status === 403) {
      console.error('backend: AUTOBOT_API_KEY was rejected — rotate it in the dashboard and update the repo secret.');
      process.exit(1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    setOutput('run-id', body.run_id);
    console.log(`backend: run ${body.run_id} started (${body.runs_remaining} runs remaining)`);
  } catch (err) {
    // Backend unreachable ≠ customer's fault — don't block their CI on our uptime.
    console.error(`backend: could not reach ${BACKEND} (${err.message}) — continuing without report upload`);
    setOutput('run-id', '');
  }
  process.exit(0);
}

if (cmd === 'upload') {
  const runDir = process.env.RUN_DIR;
  const runId = process.env.AUTOBOT_RUN_ID;
  if (!runId) { console.error('backend: no run id — skipping upload'); process.exit(0); }
  if (!runDir || !existsSync(join(runDir, 'journal.jsonl'))) {
    console.error('backend: no run artifacts to upload'); process.exit(0);
  }

  // Zip lands NEXT TO the run dir, not inside it (or it would zip itself on re-runs).
  // `zip` is preinstalled on all GitHub-hosted runner images.
  const zipPath = join(runDir, '..', 'autobot-run.zip');
  execFileSync('zip', ['-r', '-q', zipPath, '.'], { cwd: runDir });

  let summary = {};
  try { summary = JSON.parse(readFileSync(join(runDir, 'ci-summary.json'), 'utf8')); } catch { /* explore died before summary */ }
  const metadata = {
    ...runMeta(),
    status: existsSync(join(runDir, 'ci-summary.json')) ? 'completed' : 'failed',
    counts: summary.counts ?? null,
    gate: summary.gate ?? null,
    report_path: existsSync(join(runDir, 'report.html')) ? 'report.html' : null,
    actions_run_url: process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
  };

  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));
  form.append('archive', new Blob([readFileSync(zipPath)], { type: 'application/zip' }), 'run.zip');

  try {
    const res = await fetch(`${BACKEND}/autobot-cloud/run/${runId}/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}` },
      body: form,
      signal: AbortSignal.timeout(300000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    console.log(`backend: run uploaded — report at ${body.report_url}`);
    if (process.env.GITHUB_STEP_SUMMARY && body.report_url) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n[View the full Autobot report](${body.report_url})\n`);
    }
  } catch (err) {
    // Never fail the customer's job over report hosting — the artifact fallback has everything.
    console.error(`backend: upload failed (${err.message}) — the run is still attached as an Actions artifact`);
  }
  process.exit(0);
}

if (cmd === 'log') {
  // Operational telemetry (why did OUR run fail?), distinct from the report
  // upload (what did the run find?). Runs on if:always() so an explore/infra
  // death that never wrote ci-summary.json still leaves a trace in our DB.
  const runDir = process.env.RUN_DIR || '';
  const summaryPath = runDir ? join(runDir, 'ci-summary.json') : '';
  let summary = null;
  try { summary = JSON.parse(readFileSync(summaryPath, 'utf8')); } catch { /* run step died before writing it */ }

  const failed = !summary;
  const event = {
    ts: new Date().toISOString(),
    level: failed ? 'error' : summary.phaseErrors ? 'warn' : 'info',
    event: failed ? 'ci_run_failed' : 'ci_run_finished',
    ...runMeta(),
    run_id: process.env.AUTOBOT_RUN_ID || null,
    run_step_outcome: process.env.AUTOBOT_RUN_OUTCOME || null,
    ...(summary ? {
      gate: summary.gate ?? null,
      counts: summary.counts ?? null,
      phase_errors: summary.phaseErrors ?? null,
      duration_ms: summary.durationMs ?? null,
    } : { error: 'run step produced no ci-summary.json (explore or infra failure before summary)' }),
  };

  try {
    const res = await fetch(`${BACKEND}/autobot-relay/log`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ events: [event] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log(`backend: telemetry logged (${event.event})`);
  } catch (err) {
    // Telemetry must never affect the customer's job outcome.
    console.error(`backend: telemetry send failed (${err.message}) — ignoring`);
  }
  process.exit(0);
}

console.error(`backend: unknown command "${cmd}" (expected start|upload|log)`);
process.exit(1);
