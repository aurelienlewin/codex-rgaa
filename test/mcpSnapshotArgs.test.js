import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { collectSnapshotWithMcp } from '../src/mcpSnapshot.js';

async function createMockCodex(tmpDir, { expectBrowserUrl }) {
  const mockPath = path.join(tmpDir, 'codex');
const script = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex 0.0.0-test');
  process.exit(0);
}
const execIdx = args.indexOf('exec');
if (execIdx !== -1) {
  const execArgs = args.slice(execIdx);
  const cfgVals = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' || args[i] === '--config') {
      cfgVals.push(String(args[i + 1] || ''));
      i++;
    }
  }
  const cfg = cfgVals.join('\\n');
  const outIdx = execArgs.indexOf('--output-last-message');
  const outFile = outIdx !== -1 ? execArgs[outIdx + 1] : null;
  const stderr = (msg) => process.stderr.write(String(msg) + '\\n');

  if (!cfg.includes('mcp_servers.chrome-devtools.command=')) {
    stderr('missing mcp server command config');
    process.exit(2);
  }
  if (!cfg.includes('mcp_servers.chrome-devtools.args=')) {
    stderr('missing mcp server args config');
    process.exit(2);
  }
  if (!cfg.includes('chrome-devtools-mcp@latest')) {
    stderr('missing chrome-devtools-mcp invocation');
    process.exit(2);
  }
  if (!cfg.includes('"-y"')) {
    stderr('missing -y in npx args');
    process.exit(2);
  }
  if (cfg.includes('--yes')) {
    stderr('unexpected --yes in npx args (use -y)');
    process.exit(2);
  }
  if (${expectBrowserUrl ? 'true' : 'false'} && !cfg.includes(${JSON.stringify(`--browser-url=${expectBrowserUrl}`)})) {
    stderr('missing expected --browser-url');
    process.exit(2);
  }
  if (${expectBrowserUrl ? 'true' : 'false'} && (cfg.includes('--autoConnect') || cfg.includes('--auto-connect'))) {
    stderr('unexpected autoConnect when browserUrl is provided');
    process.exit(2);
  }

  try { fs.readFileSync(0, 'utf8'); } catch (_) {}
  if (outFile) {
    const snapshot = {
      doctype: 'html',
      title: 'fixture',
      lang: 'fr',
      images: [],
      frames: [],
      links: [],
      formControls: [],
      headings: [],
      listItems: [],
      langChanges: [],
      tables: [],
      media: { video: 0, audio: 0, object: 0 },
      scripts: { scriptTags: 0, hasInlineHandlers: false }
    };
    fs.writeFileSync(outFile, JSON.stringify(snapshot));
    process.exit(0);
  }
}
process.exit(1);
`;
  await fs.writeFile(mockPath, script, { mode: 0o755 });
  return mockPath;
}

test('MCP snapshot runner passes browserUrl to chrome-devtools-mcp without --yes', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rgaa-mcp-args-'));
  const browserUrl = 'http://127.0.0.1:9222';
  const mockCodex = await createMockCodex(tmpDir, { expectBrowserUrl: browserUrl });

  const originalCodexPath = process.env.CODEX_PATH;
  const originalMcpMode = process.env.CODEX_MCP_MODE;
  process.env.CODEX_PATH = mockCodex;
  process.env.CODEX_MCP_MODE = 'chrome';

  try {
    const snapshot = await collectSnapshotWithMcp({
      url: 'http://example.com/',
      model: '',
      mcp: { browserUrl, autoConnect: true, channel: '' }
    });
    assert.equal(snapshot.title, 'fixture');
  } finally {
    if (originalCodexPath === undefined) delete process.env.CODEX_PATH;
    else process.env.CODEX_PATH = originalCodexPath;
    if (originalMcpMode === undefined) delete process.env.CODEX_MCP_MODE;
    else process.env.CODEX_MCP_MODE = originalMcpMode;
  }
});
