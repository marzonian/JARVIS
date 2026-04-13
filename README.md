# JARVIS (McNair Mindset Runtime)

Jarvis is a local trading-assistant runtime focused on:

- assistant-first query/response for trading decisions and reviews
- ORB-based decision logic with replay and accountability layers
- shadow-policy experimentation (for example late-entry policy lanes)
- truth propagation from internal checkpoints and external trade sources

This repository contains application code, tests, scripts, and docs. Local runtime state, keys, and databases are intentionally excluded from version control.

## Quick start

### 1. Install dependencies

```bash
npm install
cd client && npm install && cd ..
```

### 2. Configure environment

```bash
cp .env.example .env
# Fill values in .env (do not commit this file)
```

If you use local machine-specific runtime settings, copy:

```bash
cp config.example.yaml config.yaml
```

### 3. Start runtime

```bash
npm run dev
```

- UI: `http://localhost:3130`
- API: `http://localhost:3131`

### 4. Run tests

```bash
npm test
```

## Project structure

- `server/`:
  - Express API, Jarvis core logic, replay/accountability modules, integrations
- `client/`:
  - React/Vite frontend (command center and assistant UI)
- `scripts/`:
  - operational helpers, audits, runtime tooling, backfill/maintenance scripts
- `tests/`:
  - node-based test suites (unit/integration/system checks)
- `data/`:
  - local runtime databases and generated artifacts (ignored in git)
- `Logs/`:
  - local runtime logs (ignored in git)

## Safety and secrets

- Never commit:
  - `.env` and any key files
  - local DB files (`*.db`, `*.sqlite*`)
  - logs, caches, local state folders
- Commit only:
  - source code, tests, docs, scripts, and templates/examples

## Useful commands

- `npm run preflight`: local runtime/data preflight
- `npm run server`: start API runtime
- `npm run dev`: run API + frontend concurrently
- `npm run runtime:doctor`: runtime health and path checks
- `npm run test:jarvis:recommendation-outcome`: targeted recommendation outcome tests

## Notes

- This repo is intended for private use.
- External provider credentials (OpenAI/Topstep/etc.) must stay in environment or keychain, never in git.
