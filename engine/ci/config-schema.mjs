// ============================================================================
// ci/config-schema.mjs — schema + defaults for the customer-repo config file
// (.autobot/config.yml). Single source of truth for what CI accepts: the
// backend's setup-PR generator writes this shape, ci/run-web.mjs consumes it.
//
// Convention: the config never contains secret VALUES — credentials are named
// env vars (mapped from repo secrets in the workflow's `env:` block).
// ============================================================================
import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const nonEmpty = (s) => typeof s === 'string' && s.trim() !== '';

export const CONFIG = z.object({
  version: z.number().default(1),
  app: z.object({
    about: z.string().default(''),
    // build/serve knobs are consumed by the action's serve step, not the engine —
    // they live here so one file describes the whole run.
    framework: z.enum(['nextjs', 'vite', 'cra', 'custom']).optional(),
    install: z.string().default(''),
    build: z.string().default(''),
    start: z.string().default(''),
    port: z.number().int().positive().optional(),
    ready_path: z.string().default('/'),
    ready_timeout: z.number().int().positive().default(300),
    // Set url to test an already-deployed target; the serve step is skipped.
    url: z.string().default(''),
  }).default({}),
  test: z.object({
    mode: z.enum(['login', 'signup', '']).default(''),
    credentials: z.object({
      username_env: z.string().default('AUTOBOT_TEST_USERNAME'),
      password_env: z.string().default('AUTOBOT_TEST_PASSWORD'),
    }).default({}),
    goal: z.string().default(''),
    focus: z.string().default(''),
    instructions: z.string().default(''),
    // Monitor-run knobs (also usable from repo configs): safe_mode hardens the
    // explore doctrine for live production targets; blocked_* become OFF-LIMITS
    // sections in the instructions file.
    safe_mode: z.boolean().default(false),
    blocked_paths: z.array(z.string()).default([]),
    blocked_actions: z.string().default(''),
    steps: z.number().int().positive().max(200).default(40),
    viewport: z.string().regex(/^\d+x\d+$/).default('1440x900'),
    test_data: z.record(z.any()).default({}),
  }).default({}),
  ci: z.object({
    fail_on: z.enum(['high', 'medium', 'low', 'never']).default('high'),
  }).default({}),
});

// Load + validate a config file. A missing file is fine (all defaults) — the
// action works zero-config against a plain Next app.
export function loadConfig(path) {
  const raw = existsSync(path) ? parseYaml(readFileSync(path, 'utf8')) : {};
  return parseConfig(raw);
}

// Parse an already-YAML-decoded object. Throws with a readable message listing
// every bad path — these errors surface verbatim in the customer's Actions log.
export function parseConfig(raw) {
  const res = CONFIG.safeParse(raw ?? {});
  if (!res.success) {
    const lines = res.error.issues.map((i) => `  .${i.path.join('.')} — ${i.message}`);
    throw new Error(`Invalid .autobot/config.yml:\n${lines.join('\n')}`);
  }
  return res.data;
}

// Resolve credentials from the env-var names the config declares. Values are
// returned for the inputs file only — callers must never log them.
export function resolveCredentials(cfg, env = process.env) {
  const { username_env, password_env } = cfg.test.credentials;
  const username = env[username_env] || '';
  const password = env[password_env] || '';
  if (!nonEmpty(username) && !nonEmpty(password)) return null;
  return { username, password };
}

// Gate helper shared by run-web and the action's check-gate step.
const SEV_RANK = { high: 3, medium: 2, low: 1, never: Infinity };
export function gateOf(counts, failOn) {
  if (failOn === 'never') return 'pass';
  const worst = counts.high ? 'high' : counts.medium ? 'medium' : counts.low ? 'low' : null;
  return worst && SEV_RANK[worst] >= SEV_RANK[failOn] ? 'fail' : 'pass';
}
