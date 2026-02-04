# RGAA Website Auditor (MCP)

<p align="center">
  <a href="https://github.com/aurelienlewin">
    <img src="https://avatars.githubusercontent.com/u/45093822?v=4" width="160" height="160" alt="Aurélien Lewin" />
  </a>
</p>
<p align="center">
  <strong>Aurélien Lewin</strong>
</p>

**UI‑first RGAA auditing** — fast evidence, clear answers, and a report your team actually reads.

**Highlights**
| Feature | What it feels like |
|---|---|
| MCP‑driven evidence | Live Chrome‑native auditing without scripts |
| AI review (Codex) | Fast decisions with traceable evidence |
| Excel report | A clean, color‑coded matrix built for reviewers |
| Second‑pass AI | Targets remaining **Review** items after all pages are scanned |

**What you get**
- **Per‑page results** for all **106 criteria**
- **Global summary** (a criterion is conform only if it passes on **every** page)
- **Score** computed as **C / (C + NC)**

**Evidence collection**
- **MCP** (Chrome DevTools MCP) using `chrome-devtools-mcp` started by Codex (handy when driving an existing Chrome session)

> [!TIP]
> The CLI UI is designed like a modern product console: animated progress, humanized AI feed, and a dedicated **Second pass** callout when cross‑page checks run.

---

## Table of contents
- [Requirements](#requirements)
- [Install](#install)
- [Run](#run)
- [Quickstart](#quickstart)
- [Advanced](#advanced)
- [UX moments](#ux-moments)
- [Output](#output)
- [AI review (mandatory)](#ai-review-mandatory)
- [Notes on automation](#notes-on-automation)
- [Tests](#tests)
- [RGAA criteria source](#rgaa-criteria-source)
- [Example pages file](#example-pages-file)

## Requirements
- OS: macOS, Windows, or Linux
- Node.js 18+ (npm included)
- Chrome/Chromium installed
- Codex CLI available in PATH (for AI review / MCP tool runs)
- Optional: `tesseract` binary in PATH (used as OCR fallback if `tesseract.js` fails)
- Optional: `chrome-devtools-mcp` installed locally (otherwise pulled via `npx`)
- Optional (for criterion **8.2**): `html-validate` (installed via npm dependencies)

## Install
```bash
npm install
```

## Quickstart
<details open>
<summary><strong>Minimal run (guided)</strong></summary>

```bash
npm run audit
```
</details>

<details>
<summary><strong>One‑liner (URLs)</strong></summary>

```bash
npm run audit -- --pages https://example.com https://example.com/contact --allow-remote-debug
```
</details>

<details>
<summary><strong>From a pages file</strong></summary>

```bash
npm run audit -- --pages-file pages.sample.md --allow-remote-debug
```
</details>

## Advanced
<details>
<summary><strong>MCP‑first (autoConnect)</strong></summary>

```bash
npm run audit -- --allow-remote-debug
```

Notes:
- Use Chrome 144+ with remote debugging enabled.
- The auditor will auto‑connect and prompt you to approve the connection.
</details>

<details>
<summary><strong>Target an existing tab by id</strong></summary>

```bash
npm run audit:mcp -- --pages https://example.com --mcp-page-id 2
```
</details>

<details>
<summary><strong>Run non‑interactive</strong></summary>

```bash
npm run audit -- --pages https://example.com --allow-remote-debug --report-lang en
```
</details>

## UX moments
<details open>
<summary><strong>What the UI shows while it runs</strong></summary>

- **Progress**: Overall + per‑page bars with live counts.
- **Live feed**: Human‑readable AI activity stream (collapsed or verbose).
- **Second pass**: A dedicated callout panel when cross‑page checks run.
- **End recap**: A modern summary line with Score + C/NC/NA/REV/ERR + remaining Review.
</details>

## Run
The **Quickstart** and **Advanced** sections above cover all common modes.  
Key tips:
- `npm run audit` launches the guided wizard (default).
- `--no-guided` skips prompts for power users.
- In non‑interactive environments, supply all flags explicitly.

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
By default, the generated XLSX is opened automatically; disable with `AUDIT_OPEN_XLS=0`.

The Excel file contains:
- **Summary** (first tab): global counts + score, color-coded status chips.
- **Audit**: rows = criteria, columns = pages, with **✓ / ✗ / – / !** icons and color-coded cells. Page URLs are stored as header cell comments; page names appear in the header row.

When evidence is still insufficient after MCP tools (a11y tree, targeted DOM, OCR), criteria are marked **Review** and the Matrix UI cell is left blank with a **solid red** background for human review.
Enrichment‑based evidence in cell notes is **humanized** (e.g., “liens sans nom”, “taux de mouvement”, “pire contraste”) for easier review.

## AI review (mandatory)
All non-automated criteria are reviewed via the local **Codex CLI** (`codex exec`).

You can override the model with `--codex-model` if your Codex config supports it.
If you rely on a local proxy/authenticator (e.g., a `base_url` in `~/.codex/config.toml`), nested `codex exec` calls read that `base_url` and route through it automatically.

**AI+MCP is enabled by default** to let the reviewer call chrome-devtools MCP tools for extra evidence (a11y tree, targeted DOM queries, screenshots).
Disable with:
- CLI: `--no-ai-mcp`
- Env: `AUDIT_AI_MCP=0`

You can also enable OCR (repo-level, no system install required) to extract text from screenshots:
- CLI: `--ai-ocr` (default: on when `--ai-mcp` is enabled)
- Env: `AUDIT_AI_OCR=1` (set to `0` to force-disable)
- OCR languages: `AUDIT_OCR_LANGS=fra+eng`

This can reduce **NA** on dynamic/visual pages but is slower and interacts with the live page. The reviewer is instructed not to submit forms or mutate state. Screenshot-based checks use the built-in OCR tool to extract visible text and include it as evidence. If `tesseract.js` fails, the tool falls back to the system `tesseract` binary (if available).

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
- Cross-page criteria (e.g., **12.5**) are handled in a **second pass** once all pages have been audited.
- The UI shows a **Second pass** callout when this happens, indicating the AI is doing extra review work to reduce remaining **Review** items.
- Performance note: with `gpt-5.2-codex` on **low reasoning**, expect **up to ~1 hour per page** on a **2019 MacBook Pro (Intel, 6 cores)**.
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
