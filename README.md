# RGAA Website Auditor (MCP)

UI-first RGAA auditing with Chrome DevTools evidence, AI review, and an Excel report your team can actually use.

Main mode is **TTY + remote Chrome**. Non-TTY/CI is supported but secondary.

---

## Quickstart (TTY + remote Chrome)

1) Install deps:

```bash
npm install
```

2) Launch a dedicated Chrome with remote debugging enabled:

```bash
# macOS
open -a "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="/tmp/rgaa-audit-profile"

# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir="/tmp/rgaa-audit-profile"
```

3) Run the guided audit (TTY):

```bash
npm run audit
```

Guided mode will:
- auto-connect to Chrome when possible
- pause so you can open the tabs to audit
- resume when you press Enter

If you prefer to pass URLs explicitly:

```bash
npm run audit -- --pages https://example.com https://example.com/contact --allow-remote-debug
```

---

## Requirements

- OS: macOS, Windows, or Linux
- Node.js 18+ (npm included)
- Chrome/Chromium installed
- Codex CLI available in PATH (for AI review / MCP tool runs)
- Optional: `tesseract` in PATH (OCR fallback if `tesseract.js` fails)
- Optional: `chrome-devtools-mcp` installed locally (otherwise pulled via `npx`)
- Optional (criterion 8.2): `html-validate` (installed via npm dependencies)

---

## Remote monitor (codex-rgaa-monitor)

This repo can stream live status to the **codex-rgaa-monitor** dashboard. The two repos are designed to live as siblings.

### Option A (recommended): push directly from the CLI to Upstash

In **this** repo:

```bash
export AUDIT_REMOTE_STATUS=1
export AUDIT_UPSTASH_REST_URL="https://<your-upstash>.upstash.io"
export AUDIT_UPSTASH_REST_TOKEN="<token>"
export AUDIT_UPSTASH_KEY="rgaa-monitor:state"
export AUDIT_REMOTE_PUSH_MS=60000
```

In **codex-rgaa-monitor** (Vercel):

```bash
AUDIT_MONITOR_REMOTE=1
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
AUDIT_UPSTASH_KEY=rgaa-monitor:state
AUDIT_MONITOR_UI_TOKEN=...
```

### Option B: push from codex-rgaa-monitor

On Vercel:

```bash
AUDIT_MONITOR_REMOTE=1
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
AUDIT_UPSTASH_KEY=rgaa-monitor:state
AUDIT_MONITOR_INGEST_TOKEN=...
AUDIT_MONITOR_UI_TOKEN=...
```

On the machine running the audit:

```bash
export AUDIT_MONITOR_INGEST_URL="https://your-vercel-app.vercel.app/api/ingest"
export AUDIT_MONITOR_INGEST_TOKEN="same-as-vercel"
export AUDIT_MONITOR_AUDIT_ROOT="/absolute/path/to/audit"
npm run monitor:push
```

Tip: if a sibling `codex-rgaa-monitor/.env.local` exists, the CLI can auto-load missing Upstash creds from it.

Cleanup: the CLI clears the Upstash key at startup and after completion/errors (with retries). To keep data longer,
disable remote status or use a different key.

---

## Non-TTY / CI (secondary)

Provide all flags explicitly and disable guided prompts:

```bash
npm run audit -- --no-guided --pages https://example.com --allow-remote-debug --report-lang en
```

If you already run Chrome with remote debugging enabled, point to it:

```bash
npm run audit -- --mcp-browser-url http://127.0.0.1:9222 --allow-remote-debug
```

---

## Resume / recover

- Pause: `p` | Resume: `r` | Pause + quit: `q`
- Resume file written to `out/<run>/audit.resume.json`

Resume later:

```bash
npm run audit -- --resume out/<run>/audit.resume.json
```

---

## Output

Default output: `out/<run>/rgaa-audit.xlsx`.

- Summary tab: global counts + score (C / (C + NC))
- Audit tab: criteria x pages matrix with status chips and notes
- Evidence tab: per-criterion evidence, screenshots, links

Configure:
- Change output dir: `--out`
- Disable XLSX export: `--no-xlsx`
- Disable auto-open: `AUDIT_OPEN_XLS=0`

Legend: C = Conform • NC = Not conform • NA = Non applicable • REV = Review • ERR = Error

---

## AI review (mandatory)

Non-automated criteria are reviewed via the local **Codex CLI** (`codex exec`).
AI+MCP is enabled by default so the reviewer can request extra evidence (a11y tree, targeted DOM, screenshots).

Disable MCP tools during review:
- CLI: `--no-ai-mcp`
- Env: `AUDIT_AI_MCP=0`

Enable OCR (default when AI+MCP is on):
- CLI: `--ai-ocr`
- Env: `AUDIT_AI_OCR=1`
- OCR languages: `AUDIT_OCR_LANGS=fra+eng`

Fail-fast when AI auth is missing (default). Disable with `AUDIT_FAIL_FAST=0`.

---

## Notes on MCP / Chrome

- Recommended flow is auto-connect to an already-open Chrome (Chrome 144+).
- If auto-connect is disabled and no `--mcp-browser-url` is provided, the auditor launches Chrome itself.
- In non-interactive runs, pre-configure Chrome or pass `--mcp-browser-url`.
- Restricted environments: set a fixed port with `--chrome-port 9222`.

---

## Tests

```bash
npm test
```

Manual test checklist: `docs/testing-scenarios.md`.

---

## RGAA criteria source

The 106 criteria list is cached in:
- `data/rgaa-criteria.json` (French)
- `data/rgaa-criteria.en.json` (English)

Fetched from:
- https://accessibilite.numerique.gouv.fr/methode/criteres-et-tests/

(Downloaded on 2026-02-02.)

---

## Example pages file

See `pages.sample.md`.
