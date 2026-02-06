# Testing scenarios (bulletproof execution)

## Critical execution paths
- Run with a single valid URL (sanity)
- Run with multiple URLs (mix of 200/404/redirect)
- Run with a markdown file input (URL per line, with comments and bullets)
- Run with invalid lines (should be skipped, warning shown)
- Guided auto-launch (opens `chrome://inspect/#remote-debugging`, pauses, then continues after Enter)
- Hotkeys (`p` pause, `r` resume, `h` help) still work when stdin is busy
- Guided mode with existing tabs: list_pages auto-detects tabs and audits in tab order
- Pause mid-page writes resume state and resume continues the same page on restart

## Environment checks
- Codex CLI available (`codex --version` succeeds)
- Chrome present and launchable
- XLS export default (`rgaa-audit.xlsx`) and `--no-xlsx`
- Headless + non-headless modes
- Repo-local Chrome profile created at `.chrome-profile/` (override with `AUDIT_CHROME_PROFILE_DIR`)

## RGAA logic
- Criteria list = 106 unique IDs
- Non-automated criteria require AI review
- AI review failures are reported as Error with a failure note
- Missing/insufficient evidence after MCP tools yields Review (🟡 in Matrix UI)
- Global score computed as C / (C + NC)
- AI+MCP mode (default on; disable with `--no-ai-mcp` / `AUDIT_AI_MCP=0`) can collect extra evidence via MCP tools
- OCR tool (`--ai-ocr` / `AUDIT_AI_OCR=1`) extracts text from screenshots when needed

## Output correctness
- Matrix sheet exists when `--out` provided
- Matrix rows match criteria IDs
- Matrix columns match pages order
- Values mapping: C=1, NA=0, NC=-1, ERR=-2
- Summary labels and legend are localized to the report language

## Automated coverage
- `npm test` includes an end-to-end audit against local fixture pages
- Requires Chrome (or set `CHROME_PATH`) and uses a mock Codex binary
- Verifies XLSX matrix values and AI log streaming

## Resilience
- Page timeout: simulate slow load, ensure timeout handled
- Network errors: page load fail should mark criteria Error with note
- Large pages: ensure snapshot sampling caps array sizes
- AI+MCP fallback: if MCP tooling fails, AI review retries without MCP
- OCR fallback: if OCR fails, AI continues without OCR evidence
