// ============================================================================
// serve.mjs — build and serve the customer's web app inside the runner, then
// hand the URL to the engine. cwd = the app under test (working-directory).
//
//   node serve.mjs --config .autobot/config.yml
//
// Outputs `target-url` to $GITHUB_OUTPUT. When config sets app.url the whole
// build/serve is skipped and that URL is passed through (externally-hosted
// target). App server logs go to $RUNNER_TEMP/app-server.log; on a failed
// health wait the tail is printed so build problems are debuggable from the
// Actions log alone.
// ============================================================================
import { spawn, execSync } from 'node:child_process';
import { appendFileSync, existsSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// Published layout: <root>/scripts + <root>/engine. Monorepo dev layout:
// <repo>/action/scripts + <repo>/v2-engine.
const ENGINE_DIR = ['../engine', '../../v2-engine']
  .map((p) => resolve(HERE, p))
  .find((p) => existsSync(join(p, 'ci', 'config-schema.mjs')));
if (!ENGINE_DIR) { console.error('serve: cannot locate the Autobot engine directory'); process.exit(1); }
const { loadConfig } = await import(pathToFileURL(join(ENGINE_DIR, 'ci', 'config-schema.mjs')).href);

const argIdx = process.argv.indexOf('--config');
const configPath = resolve(argIdx !== -1 ? process.argv[argIdx + 1] : '.autobot/config.yml');

const fail = (msg) => { console.error(`serve: ${msg}`); process.exit(1); };
const setOutput = (k, v) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
  console.log(`serve: ${k}=${v}`);
};

let cfg;
try { cfg = loadConfig(configPath); } catch (err) { fail(String(err.message || err)); }

// Externally-hosted target — nothing to build.
if (cfg.app.url) {
  console.log('serve: app.url is set — skipping build/serve');
  setOutput('target-url', cfg.app.url);
  process.exit(0);
}

if (!existsSync('package.json')) fail('no package.json here and no app.url in .autobot/config.yml — set app.url to test a deployed site, or point working-directory at your app');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };

// --- detect package manager (by lockfile) + framework (by dependency) ---------
const pm = existsSync('pnpm-lock.yaml') ? 'pnpm' : existsSync('yarn.lock') ? 'yarn' : 'npm';
const installCmd = { pnpm: 'pnpm install --frozen-lockfile', yarn: 'yarn --frozen-lockfile', npm: existsSync('package-lock.json') ? 'npm ci' : 'npm install' }[pm];
const runCmd = (script) => ({ pnpm: `pnpm run ${script}`, yarn: `yarn ${script}`, npm: `npm run ${script}` }[pm]);

const framework = cfg.app.framework
  || (deps.next ? 'nextjs' : deps.vite ? 'vite' : deps['react-scripts'] ? 'cra' : 'custom');

const FRAMEWORK_DEFAULTS = {
  nextjs: { build: runCmd('build'), start: null /* resolved after build: standalone vs next start */, port: 3000 },
  vite: { build: runCmd('build'), start: 'npx vite preview --host 127.0.0.1 --port 4173 --strictPort', port: 4173 },
  cra: { build: runCmd('build'), start: 'npx serve -s build -l 3000', port: 3000 },
  custom: { build: '', start: '', port: 3000 },
};
const def = FRAMEWORK_DEFAULTS[framework];
const port = cfg.app.port || def.port;
if (framework === 'custom' && !cfg.app.start) {
  fail(`could not detect a known framework (next/vite/react-scripts) — set app.framework or app.build/app.start/app.port in .autobot/config.yml`);
}
console.log(`serve: framework=${framework} pm=${pm} port=${port}`);

const sh = (cmd, label) => {
  console.log(`serve: ${label}: ${cmd}`);
  execSync(cmd, { stdio: 'inherit', env: { ...process.env, CI: 'true' } });
};

// --- install + build -----------------------------------------------------------
sh(cfg.app.install || installCmd, 'install');
const buildCmd = cfg.app.build || def.build;
if (buildCmd) sh(buildCmd, 'build');

// --- resolve start command ------------------------------------------------------
let startCmd = cfg.app.start || def.start;
if (!startCmd && framework === 'nextjs') {
  if (existsSync('.next/standalone/server.js')) {
    // Next standalone bundles don't include static assets — copy them in, per Next docs.
    execSync('cp -r .next/static .next/standalone/.next/static 2>/dev/null; [ -d public ] && cp -r public .next/standalone/public || true', { shell: '/bin/bash' });
    startCmd = `node .next/standalone/server.js`;
  } else {
    startCmd = `npx next start -p ${port}`;
  }
}

// --- start (detached, logged) ---------------------------------------------------
const logPath = join(process.env.RUNNER_TEMP || tmpdir(), 'app-server.log');
const logFd = openSync(logPath, 'a');
console.log(`serve: start: ${startCmd} (logs → ${logPath})`);
const child = spawn(startCmd, {
  shell: true, detached: true, stdio: ['ignore', logFd, logFd],
  env: { ...process.env, CI: 'true', PORT: String(port), HOSTNAME: '127.0.0.1', HOST: '127.0.0.1' },
});
child.unref(); // outlive this script; the runner tears the job's processes down at the end

// --- health wait -----------------------------------------------------------------
const targetUrl = `http://127.0.0.1:${port}`;
const readyUrl = new URL(cfg.app.ready_path, targetUrl).href;
const deadline = Date.now() + cfg.app.ready_timeout * 1000;
process.stdout.write(`serve: waiting for ${readyUrl} (timeout ${cfg.app.ready_timeout}s) `);
let up = false;
while (Date.now() < deadline) {
  try {
    // ANY http response counts as up — login walls (401), redirects (3xx) and
    // error pages all prove the server is accepting connections.
    await fetch(readyUrl, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
    up = true; break;
  } catch { /* not up yet */ }
  process.stdout.write('.');
  await new Promise((r) => setTimeout(r, 1000));
}
console.log('');
if (!up) {
  console.error(`serve: app never responded on ${readyUrl} — last 100 lines of app log:`);
  try { console.error(readFileSync(logPath, 'utf8').split('\n').slice(-100).join('\n')); } catch { /* no log */ }
  process.exit(1);
}
console.log('serve: app is up');
setOutput('target-url', targetUrl);
process.exit(0);
