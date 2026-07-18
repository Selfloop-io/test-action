# Autobot AI Tester — GitHub Action

Autonomous visual QA on every pull request. Autobot builds your app inside the
runner, explores it in a real (headless) browser like a first-time user, and
reports UX flaws — with annotated screenshots — as a comment on your PR plus a
hosted report.

## Quick start

1. Get an API key from the [Selfloop dashboard](https://selfloop.ai/dashboard)
   (installing the GitHub App opens a setup PR that does steps 2–3 for you).
2. Add the key as a repo secret named `AUTOBOT_API_KEY`.
3. Add `.github/workflows/autobot.yml`:

```yaml
name: Autobot
on:
  pull_request:
    branches: [main]
permissions:
  contents: read
concurrency:
  group: autobot-${{ github.ref }}
  cancel-in-progress: true
jobs:
  autobot:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: selfloop-io/test-action@v1
        with:
          api-key: ${{ secrets.AUTOBOT_API_KEY }}
        env:
          # test-account credentials referenced by .autobot/config.yml
          AUTOBOT_TEST_USERNAME: ${{ secrets.AUTOBOT_TEST_USERNAME }}
          AUTOBOT_TEST_PASSWORD: ${{ secrets.AUTOBOT_TEST_PASSWORD }}
          # plus any env your app needs to build & start
```

4. (Optional) Add `.autobot/config.yml`:

```yaml
version: 1
app:
  about: "A team todo app with realtime sync"
  # framework/build/start/port are auto-detected for Next.js, Vite and CRA —
  # only set them to override, or set `url` to test an already-deployed site.
test:
  mode: login              # login | signup | "" (test from the landing state)
  credentials:
    username_env: AUTOBOT_TEST_USERNAME
    password_env: AUTOBOT_TEST_PASSWORD
  steps: 40                # exploration budget
  instructions: |
    The demo workspace has seeded data. Don't test the billing pages.
ci:
  fail_on: high            # fail the check on: high | medium | low | never
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `api-key` | (required) | Autobot API key (`AUTOBOT_API_KEY` secret) |
| `config-path` | `.autobot/config.yml` | Config file path, relative to `working-directory` |
| `working-directory` | `.` | App directory (monorepo support) |
| `backend-url` | `https://fastfind.app` | Backend override (staging) |
| `upload` | `true` | `false` = dry run: no metering, no hosted report, artifact only |

## What you get

- A **check** ("Autobot") that fails per your `ci.fail_on` gate.
- One **PR comment** (updated in place on new pushes) with severity counts,
  top flaws and annotated screenshots.
- A **hosted report** link with the full step-by-step journal.
- The raw run directory as an Actions **artifact** (fallback, always).

## Notes

- Credentials: the config only ever names **env vars**; values come from repo
  secrets via the workflow's `env:` block and are never echoed or uploaded.
- LLM calls are metered through the Autobot relay against your account; your
  code never leaves the runner — only screenshots and the flaw report are
  uploaded (skip that too with `upload: 'false'`).

---
This repo is generated from the autobot monorepo by `sync-engine.sh` — please
open issues here, but PRs against the vendored `engine/` can't be accepted.
