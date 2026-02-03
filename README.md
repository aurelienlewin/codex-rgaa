# RGAA Website Auditor (CDP + MCP)

This project runs an RGAA 4.x audit on a list of pages and produces an Excel report with:
- per-page results for all **106 criteria**
- a global summary sheet (a criterion is conform only if it passes on **every** page)
- a score computed as **C / (C + NC)**

It collects evidence either via:
- **CDP** (Chrome DevTools Protocol) using `chrome-remote-interface` + `chrome-launcher`
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
npm run audit -- --pages https://example.com --allow-remote-debug --snapshot-mode cdp --report-lang fr
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

### Snapshot mode (default: CDP)
By default, the auditor collects DOM evidence via **CDP** (`chrome-remote-interface`).

### MCP mode
MCP snapshot mode collects DOM evidence via the `chrome-devtools-mcp` server (started by Codex).

In interactive runs, the recommended flow is **autoConnect**: you launch Chrome yourself, enable remote debugging in `chrome://inspect/#remote-debugging`, and approve the incoming connection prompt in Chrome.

If you explicitly disable autoConnect and don’t provide a `--mcp-browser-url`, the auditor will launch Chrome itself and point `chrome-devtools-mcp` at that DevTools endpoint.

Note: MCP mode shells out to `chrome-devtools-mcp` (via `npx chrome-devtools-mcp@latest` unless you provide a local command). If your environment has no npm network access, use `--snapshot-mode cdp` or set `AUDIT_MCP_COMMAND` to a pre-installed `chrome-devtools-mcp` binary.

#### Recommended (Chrome 144+): autoConnect to your running Chrome (no CLI flags)
With Chrome 144+, `chrome-devtools-mcp` can auto-connect to your already-open Chrome instance. The auditor will prompt you to:
- launch Chrome
- enable remote debugging in `chrome://inspect/#remote-debugging`
- click “Allow” for incoming connections

Then run:
```bash
npm run audit -- --snapshot-mode mcp --allow-remote-debug
```

Note: in non-interactive runs (no TTY), autoConnect can’t be guided by prompts—either pre-configure Chrome as above or use `--mcp-browser-url`.

#### Connect to an existing Chrome session (CDP port 9222)
If you already have Chrome running with remote debugging (e.g. `--remote-debugging-port=9222`),
you can tell the auditor to use that endpoint:
```bash
npm run audit -- --snapshot-mode mcp --mcp-browser-url http://127.0.0.1:9222 --allow-remote-debug
```

#### Use chrome-devtools-mcp autoConnect (Chrome 144+)
If you are on a recent Chrome that supports it, you can let `chrome-devtools-mcp` auto-connect:
```bash
npm run audit -- --snapshot-mode mcp --mcp-auto-connect --allow-remote-debug
```

#### Restricted environments (no random port probing)
If `chrome-launcher` cannot probe a random port (EPERM), pass a fixed port:
```bash
npm run audit -- --chrome-port 9222 --allow-remote-debug
```

## Output
By default the tool writes `rgaa-audit.xlsx` in the current directory.

To change the output path, pass `--out`.

To disable XLSX export, pass `--no-xlsx`.

The Excel file contains:
- **Matrix**: rows = criteria, columns = pages. Values: `1` (Conform), `0` (Non applicable), `-1` (Not conform), `-2` (Error / audit tool failure). Cells are color-coded.
- **Matrix UI**: same matrix but with **✓ / ✗ / – / !** icons for quick reading (also color-coded).
- **Summary**: global counts + score.

## AI review (mandatory)
All non-automated criteria are reviewed via the local **Codex CLI** (`codex exec`).

You can override the model with `--codex-model` if your Codex config supports it.

The CLI shows an **AI feed** during progress, with a short rationale snippet for each criterion.

## Notes on automation
- Only a subset of criteria can be validated automatically with high confidence.
- All remaining criteria are evaluated by the AI reviewer using the collected DOM evidence.
- If the evidence is insufficient, the AI returns **Not conform** and notes what is missing.
- If the audit tool encounters a technical failure (page load/snapshot/AI runner), the criterion is marked **Error** and the CLI exits with code 1 (use `--allow-partial` to keep exit code 0).

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
