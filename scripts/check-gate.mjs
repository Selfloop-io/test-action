// ============================================================================
// check-gate.mjs — final action step: publish the run summary to the job's
// step summary and enforce the severity gate from ci-summary.json.
// Runs with if: always() AFTER the upload steps, so a failing gate never
// blocks report hosting or the artifact fallback.
//
// Exit 0 = gate passed. Exit 1 = gate failed OR the pipeline never produced a
// summary (infra failure — surfaced here so the job goes red either way).
// ============================================================================
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const runDir = process.env.RUN_DIR;
const summaryMd = join(runDir || '', 'summary.md');
const summaryJson = join(runDir || '', 'ci-summary.json');

if (existsSync(summaryMd) && process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, readFileSync(summaryMd, 'utf8'));
}

if (!existsSync(summaryJson)) {
  console.error('gate: no ci-summary.json — the Autobot run did not complete (see the "Run Autobot" step above for the failure)');
  process.exit(1);
}

const summary = JSON.parse(readFileSync(summaryJson, 'utf8'));
const { gate, failOn, counts } = summary;
console.log(`gate: ${counts.high} high / ${counts.medium} medium / ${counts.low} low (fail_on=${failOn})`);
if (gate === 'fail') {
  console.error(`gate: FAILED — flaws at or above "${failOn}" severity were found. See the report for details.`);
  process.exit(1);
}
console.log('gate: passed');
process.exit(0);
