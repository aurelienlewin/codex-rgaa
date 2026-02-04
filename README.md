# RGAA Website Auditor (MCP)

This project runs an RGAA 4.x audit on a list of pages and produces an Excel report with:
- per-page results for all **106 criteria**
- a global summary sheet (a criterion is conform only if it passes on **every** page)
- a score computed as **C / (C + NC)**

It collects evidence via:
- **MCP** (Chrome DevTools MCP) using `chrome-devtools-mcp` started by Codex (useful when you want to drive an existing Chrome session)

## Requirements
- Node.js 18+
- Chrome/Chromium installed

## Install
```bash
npm install
```

## Run
In interactive terminals, `npm run audit` starts a **guided wizard** by default.

### Guided (default, non-technical)
```bash
npm run audit
```

To disable the wizard (power users), pass:
```bash
npm run audit -- --no-guided
```

You can also run the wizard explicitly:
```bash
npm run audit:guided
```

Report language can also be forced from CLI:
```bash
npm run audit -- --pages https://example.com --allow-remote-debug --report-lang en
```

### 2) From a markdown/text file
```bash
npm run audit -- --pages-file pages.sample.md --allow-remote-debug
```

### 3) From CLI URLs
```bash
npm run audit -- --pages https://example.com https://example.com/contact --allow-remote-debug
```

### 4) Non-interactive
In non-interactive runs (no TTY), the wizard can’t prompt. Provide all required flags:
```bash
npm run audit -- --pages https://example.com --allow-remote-debug --report-lang fr
```

### MCP-first (interactive Chrome, recommended)
This uses `chrome-devtools-mcp` (via Codex) and lets **you** approve the incoming debugging connection in Chrome.
```bash
npm run audit:mcp
```

One-liner (pages from CLI):
```bash
npm run audit:mcp -- --pages https://example.com
```

If the page is already open in Chrome and you want to target it by tab id (from `list_pages`), pass:
```bash
npm run audit:mcp -- --pages https://example.com --mcp-page-id 2
```

### Snapshot collection (MCP)
The auditor collects DOM evidence via the `chrome-devtools-mcp` server (started by Codex).

In interactive runs, the recommended flow is **autoConnect**: you launch Chrome yourself, enable remote debugging in `chrome://inspect/#remote-debugging`, and approve the incoming connection prompt in Chrome.

If you explicitly disable autoConnect and don’t provide a `--mcp-browser-url`, the auditor will launch Chrome itself and point `chrome-devtools-mcp` at that DevTools endpoint.

Note: MCP mode shells out to `chrome-devtools-mcp` (via `npx chrome-devtools-mcp@latest` unless you provide a local command). If your environment has no npm network access, set `AUDIT_MCP_COMMAND` to a pre-installed `chrome-devtools-mcp` binary.

#### Recommended (Chrome 144+): autoConnect to your running Chrome (no CLI flags)
With Chrome 144+, `chrome-devtools-mcp` can auto-connect to your already-open Chrome instance. In guided mode, the auditor **auto-connects by default** and will prompt you to:
- launch Chrome
- open the pages you want to audit in separate tabs
- enable remote debugging in `chrome://inspect/#remote-debugging`
- press Enter so Chrome can show the “Allow” prompt for incoming connections

Then run:
```bash
npm run audit -- --allow-remote-debug
```

Note: in non-interactive runs (no TTY), autoConnect can’t be guided by prompts—either pre-configure Chrome as above or use `--mcp-browser-url`.

#### Guided mode + existing tabs (MCP)
If guided mode detects open Chrome tabs via MCP, it **audits all detected tabs by default** (no selection prompt). To audit specific URLs instead, provide `--pages` or `--pages-file`.

#### Connect to an existing Chrome session (port 9222)
If you already have Chrome running with remote debugging (e.g. `--remote-debugging-port=9222`),
you can tell the auditor to use that endpoint:
```bash
npm run audit -- --mcp-browser-url http://127.0.0.1:9222 --allow-remote-debug
```

#### Use chrome-devtools-mcp autoConnect (Chrome 144+)
If you are on a recent Chrome that supports it, you can let `chrome-devtools-mcp` auto-connect:
```bash
npm run audit -- --mcp-auto-connect --allow-remote-debug
```

#### Restricted environments (no random port probing)
If `chrome-launcher` cannot probe a random port (EPERM), pass a fixed port:
```bash
npm run audit -- --chrome-port 9222 --allow-remote-debug
```

## Output
By default the tool writes one report per run under `out/`, for example: `out/20260203-153012/rgaa-audit.xlsx`.

To change the output path, pass `--out`.

To disable XLSX export, pass `--no-xlsx`.

The Excel file contains:
- **Summary** (first tab): global counts + score, color-coded status chips.
- **Audit**: rows = criteria, columns = pages, with **✓ / ✗ / – / !** icons and color-coded cells. Page URLs are stored as header cell comments; page names appear in the header row.

When evidence is still insufficient after MCP tools (a11y tree, targeted DOM, OCR), criteria are marked **Review** and the Matrix UI cell is left blank with a **solid red** background for human review.

## AI review (mandatory)
All non-automated criteria are reviewed via the local **Codex CLI** (`codex exec`).

You can override the model with `--codex-model` if your Codex config supports it.

**AI+MCP is enabled by default** to let the reviewer call chrome-devtools MCP tools for extra evidence (a11y tree, targeted DOM queries, screenshots).
Disable with:
- CLI: `--no-ai-mcp`
- Env: `AUDIT_AI_MCP=0`

You can also enable OCR (repo-level, no system install required) to extract text from screenshots:
- CLI: `--ai-ocr` (default: on when `--ai-mcp` is enabled)
- Env: `AUDIT_AI_OCR=1` (set to `0` to force-disable)
- OCR languages: `AUDIT_OCR_LANGS=fra+eng`

This can reduce **NA** on dynamic/visual pages but is slower and interacts with the live page. The reviewer is instructed not to submit forms or mutate state. Screenshot-based checks use the built-in OCR tool to extract visible text and include it as evidence.

Local a11y utilities (enabled by default) expose extra MCP tools for quick DOM heuristics and structure checks:
- Env: `AUDIT_AI_UTILS=0` to disable the local `rgaa-utils` MCP server.
- Override command/script with `AUDIT_UTILS_COMMAND` and `AUDIT_UTILS_SCRIPT` if needed.

Extra enrichment (enabled by default) uses MCP screenshots + DOM sampling to reduce NA:
- Motion detection via screenshot diff
- Contrast sampling from computed styles
- HTML hints (marquee/blink/inline animation)
Disable with `AUDIT_ENRICH=0`.

The CLI shows a **live humanized Codex feed** during progress (table + colors + spinner) to explain what the audit is doing. Technical lines are rewritten into short status messages.

Feed controls:
- `--humanize-feed/--no-humanize-feed`
- `--humanize-feed-model`
- `AUDIT_AI_FEED_VERBOSE=0` to collapse the AI feed to a single condensed line (default: verbose multi-line).

In guided mode, the live UI is cleared at the end and replaced with a final **decisions report** plus summary.

To inspect what the tool actually captured per page, set `AUDIT_DEBUG_SNAPSHOTS=1` to write per-page snapshot JSON files under `out/<run>/snapshots/`.
To help with lazy-loaded content (images/cards loaded on scroll), set `AUDIT_SNAPSHOT_SCROLL=1` to scroll during snapshot capture.

If Codex is missing OpenAI credentials, the CLI prints a **red alert** (once) and, by default, the audit **fails fast**.
You can disable fail-fast with `AUDIT_FAIL_FAST=0` (or `false`/`no`) to continue and mark failed criteria/pages as **Error**.

## Notes on automation
- Only a subset of criteria can be validated automatically with high confidence.
- All remaining criteria are evaluated by the AI reviewer using the collected DOM evidence.
- If the evidence is insufficient, the AI returns **Not conform** and notes what is missing.
- If the audit tool encounters a technical failure (page load/snapshot/AI runner), the criterion is marked **Error**.
- By default, missing AI auth or MCP snapshot/enrichment failures **stop the audit** (fail-fast). Disable with `AUDIT_FAIL_FAST=0`.
- The CLI exits with code 1 on errors (use `--allow-partial` to keep exit code 0).

## Tests
```bash
npm test
```

Manual test checklist: `docs/testing-scenarios.md`.

## RGAA criteria source
The 106 criteria list is cached in:
- `data/rgaa-criteria.json` (French)
- `data/rgaa-criteria.en.json` (English)

Fetched from:
- https://accessibilite.numerique.gouv.fr/methode/criteres-et-tests/

(Downloaded on 2026-02-02.)

## Example pages file
See `pages.sample.md`.
