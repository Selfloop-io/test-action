// ============================================================================
// ci/run-web.mjs — CI orchestrator for a headless web run. What the desktop
// app's runner.js does with Electron IPC, this does for a GitHub Actions job:
// parse the customer repo's .autobot/config.yml, materialize the engine's
// inputs contract, spawn explore → critique → annotate → report, then write
// a machine-readable ci-summary.json + human summary.md into the run dir.
//
//   node ci/run-web.mjs [--config <path>]
//
// Env in:  TARGET_URL (from the action's serve step; falls back to app.url),
//          OPENROUTER_API_KEY (required), OPENROUTER_BASE_URL (relay),
//          RUN_DIR (default $RUNNER_TEMP/autobot-run), RUNNER_TEMP.
// Exit:    0 = pipeline ran (gate verdict lives in ci-summary.json — enforced
//          by a later action step so uploads always happen), 1 = infra failure.
// ============================================================================
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveCredentials, gateOf } from './config-schema.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(HERE, '..', 'web');
const TARGET = 'ci-target'; // fixed inputs slug — one target per CI run

// --- args + config -----------------------------------------------------------
const argIdx = process.argv.indexOf('--config');
const configPath = resolve(
  argIdx !== -1 ? process.argv[argIdx + 1]
    : join(process.env.GITHUB_WORKSPACE || process.cwd(), '.autobot', 'config.yml'),
);

function fail(msg) { console.error(`autobot: ${msg}`); process.exit(1); }

if (!process.env.OPENROUTER_API_KEY) fail('OPENROUTER_API_KEY is not set — pass the action `api-key` input (repo secret AUTOBOT_API_KEY).');

let cfg;
try {
  if (!existsSync(configPath)) console.log(`autobot: no config at ${configPath} — using defaults`);
  cfg = loadConfig(configPath);
} catch (err) { fail(String(err.message || err)); }

const url = process.env.TARGET_URL || cfg.app.url;
if (!url) fail('no target URL — the serve step must output target-url, or set app.url in .autobot/config.yml');

// --- materialize the engine inputs contract ----------------------------------
const TMP = process.env.RUNNER_TEMP || tmpdir();
const RUN_DIR = process.env.RUN_DIR || join(TMP, 'autobot-run');
const INPUTS_DIR = join(TMP, 'autobot-inputs');
const INSTRUCTIONS_DIR = join(TMP, 'autobot-instructions');
mkdirSync(RUN_DIR, { recursive: true });
mkdirSync(INPUTS_DIR, { recursive: true });
mkdirSync(INSTRUCTIONS_DIR, { recursive: true });

const credentials = resolveCredentials(cfg); // never logged
writeFileSync(join(INPUTS_DIR, `${TARGET}.json`), JSON.stringify({
  url,
  ...(credentials ? { credentials } : {}),
  about: cfg.app.about,
  testData: cfg.test.test_data,
}, null, 2));
// Instructions file = free-text instructions + OFF-LIMITS sections from the
// blocklist knobs. Config fields and env vars (BLOCKED_PATHS csv, BLOCKED_ACTIONS
// free text — set by the fleet workflow for monitor runs) are merged additively.
const blockedPaths = [
  ...cfg.test.blocked_paths,
  ...(process.env.BLOCKED_PATHS || '').split(',').map((s) => s.trim()).filter(Boolean),
];
const blockedActions = [cfg.test.blocked_actions, process.env.BLOCKED_ACTIONS || '']
  .map((s) => s.trim()).filter(Boolean);
const instructionParts = [cfg.test.instructions.trim()];
if (blockedPaths.length) instructionParts.push(
  `OFF-LIMITS PATHS — never navigate to or interact with pages under these URL paths:\n${blockedPaths.map((p) => `- ${p}`).join('\n')}`,
);
if (blockedActions.length) instructionParts.push(
  `OFF-LIMITS ACTIONS — never do any of the following, even if a goal seems to call for it:\n${blockedActions.map((a) => `- ${a}`).join('\n')}`,
);
const instructions = instructionParts.filter(Boolean).join('\n\n');
if (instructions) {
  writeFileSync(join(INSTRUCTIONS_DIR, `${TARGET}.md`), instructions);
}

const stageEnv = {
  ...process.env,
  HEADLESS: '1',
  RUN_DIR,
  INPUTS_DIR,
  INSTRUCTIONS_DIR,
  ...(cfg.test.mode ? { MODE: cfg.test.mode } : {}),
  ...(cfg.test.goal ? { GOAL: cfg.test.goal } : {}),
  ...(cfg.test.focus ? { FOCUS: cfg.test.focus } : {}),
  GLOBAL_STEPS: String(cfg.test.steps),
  VIEWPORT: cfg.test.viewport,
  ...(cfg.test.safe_mode ? { SAFE_MODE: '1' } : {}), // env SAFE_MODE=1 also works (already spread)
};

// --- stage runner (runner.js contract: detached + process-group kill) --------
function runStage(script, arg) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [join(WEB_DIR, script), arg], {
      cwd: WEB_DIR, env: stageEnv, stdio: 'inherit',
      detached: true, // mcp.mjs spawns a Playwright grandchild — kill the whole group
    });
    const killGroup = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } };
    const onSignal = () => { killGroup(); process.exit(1); };
    process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
    child.on('error', (err) => { killGroup(); rejectPromise(err); });
    child.on('exit', (code) => {
      process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal);
      code === 0 ? resolvePromise() : rejectPromise(new Error(`${script} exited with code ${code}`));
    });
  });
}

// --- pipeline -----------------------------------------------------------------
const startedAt = Date.now();
const phaseErrors = {};

console.log(`autobot: exploring ${url} (${cfg.test.steps} steps, viewport ${cfg.test.viewport}, mode ${cfg.test.mode || 'current-state'})`);
try {
  await runStage('explore.mjs', TARGET); // fatal — every later pass reads its artifacts
} catch (err) {
  fail(`explore failed — ${err.message}`);
}

// Post-explore passes are best-effort and independent (mirrors runner.js): a
// broken critique must not throw away the explore flaws already on disk.
// design.mjs is intentionally absent in CI v1 (needs a Figma token).
for (const name of ['critique', 'annotate', 'report']) {
  try { await runStage(`${name}.mjs`, RUN_DIR); }
  catch (err) {
    phaseErrors[name] = String(err.message || err);
    console.error(`autobot: ${name} failed — ${phaseErrors[name]} (other results are unaffected)`);
  }
}

// --- severity counts + gate ----------------------------------------------------
const readJsonl = (p) => existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const exploreFlaws = readJsonl(join(RUN_DIR, 'flaws.jsonl'));
const critiqueFlaws = readJsonl(join(RUN_DIR, 'critique.jsonl')).flatMap((c) => c.flaws || []);
const allFlaws = [...exploreFlaws, ...critiqueFlaws];
const counts = { high: 0, medium: 0, low: 0 };
for (const f of allFlaws) if (counts[f.severity] !== undefined) counts[f.severity] += 1;

const gate = gateOf(counts, cfg.ci.fail_on);

writeFileSync(join(RUN_DIR, 'ci-summary.json'), JSON.stringify({
  gate, failOn: cfg.ci.fail_on, counts,
  phaseErrors: Object.keys(phaseErrors).length ? phaseErrors : null,
  trigger: process.env.AUTOBOT_TRIGGER || 'pr', // pr|push|schedule|manual — backend keys alerting off this
  url, steps: cfg.test.steps, mode: cfg.test.mode,
  startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt,
}, null, 2));

// summary.md — appended to GITHUB_STEP_SUMMARY by the action's gate step.
const SEV_ORDER = { high: 0, medium: 1, low: 2 };
const top = allFlaws
  .slice().sort((a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3))
  .slice(0, 10);
const md = [
  `## Autobot — ${gate === 'fail' ? '❌ flaws at or above `' + cfg.ci.fail_on + '`' : '✅ passed'}`,
  '',
  `| High | Medium | Low |`,
  `| --- | --- | --- |`,
  `| ${counts.high} | ${counts.medium} | ${counts.low} |`,
  '',
  ...(top.length ? ['### Top flaws', ...top.map((f) => `- **${f.severity}** ${f.summary || f.type || 'flaw'}${f.detail ? ` — ${f.detail}` : ''}`)] : ['No flaws found.']),
  ...(Object.keys(phaseErrors).length ? ['', '### Phase errors', ...Object.entries(phaseErrors).map(([k, v]) => `- ${k}: ${v}`)] : []),
].join('\n');
writeFileSync(join(RUN_DIR, 'summary.md'), md + '\n');

console.log(`autobot: done — ${allFlaws.length} flaws (${counts.high} high / ${counts.medium} medium / ${counts.low} low), gate=${gate} (fail_on=${cfg.ci.fail_on})`);
process.exit(0);
