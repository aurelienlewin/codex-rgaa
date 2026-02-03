import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import chromeLauncher from 'chrome-launcher';
import { runAudit } from '../src/audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures', 'site');

function contentTypeFor(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.jpg')) return 'image/jpeg';
  return 'application/octet-stream';
}

async function startFixtureServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname === '/' ? '/good.html' : url.pathname);
      const filePath = path.join(fixturesDir, pathname);

      if (!filePath.startsWith(fixturesDir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      const data = await fs.readFile(filePath);
      res.writeHead(200, { 'Content-Type': contentTypeFor(filePath) });
      res.end(data);
    } catch (err) {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function createMockCodex(tmpDir) {
  const mockPath = path.join(tmpDir, 'codex');
  const script = `#!/usr/bin/env node\nconst fs = require('fs');\nconst args = process.argv.slice(2);\nif (args.includes('--version')) {\n  console.log('codex 0.0.0-test');\n  process.exit(0);\n}\nif (args[0] === 'exec') {\n  const outIdx = args.indexOf('--output-last-message');\n  const outFile = outIdx !== -1 ? args[outIdx + 1] : null;\n  try {\n    fs.readFileSync(0, 'utf8');\n  } catch (_) {}\n  if (outFile) {\n    const payload = { status: 'Conform', confidence: 0.72, rationale: 'Mock review', evidence: ['fixture'] };\n    fs.writeFileSync(outFile, JSON.stringify(payload));\n    process.exit(0);\n  }\n}\nprocess.exit(1);\n`;
  await fs.writeFile(mockPath, script, { mode: 0o755 });
  return mockPath;
}

function findMatrixRow(sheet, id) {
  for (let row = 3; row <= sheet.rowCount; row += 1) {
    const cell = sheet.getRow(row).getCell(1).value;
    if (cell === id) return sheet.getRow(row);
  }
  return null;
}

test('end-to-end audit writes expected XLSX matrix', async (t) => {
  const chromePath = process.env.CHROME_PATH || chromeLauncher.Launcher.getFirstInstallation();
  if (!chromePath) {
    t.skip('Chrome not found; set CHROME_PATH or install Chrome to run e2e test.');
    return;
  }

  let server = null;
  let baseUrl = null;
  try {
    const started = await startFixtureServer();
    server = started.server;
    baseUrl = started.baseUrl;
  } catch (err) {
    if (err && err.code === 'EPERM') {
      t.skip('Listening on localhost is not permitted in this environment.');
      return;
    }
    throw err;
  }
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rgaa-audit-'));
  const outPath = path.join(tmpDir, 'report.xlsx');
  const mockCodex = await createMockCodex(tmpDir);

  const originalPath = process.env.PATH || '';
  const originalCodex = process.env.CODEX_PATH;
  process.env.PATH = `${tmpDir}:${originalPath}`;
  process.env.CODEX_PATH = mockCodex;

  const aiLogs = [];
  const reporter = {
    onAIStart() {},
    onAILog({ message }) {
      if (message) aiLogs.push(message);
    },
    onCriterion() {},
    onChromeReady() {},
    onPageStart() {},
    onPageEnd() {},
    onDone() {}
  };

  try {
    await runAudit({
      pages: [`${baseUrl}/good.html`, `${baseUrl}/bad.html`],
      outPath,
      chromePath,
      headless: true,
      timeoutMs: 15000,
      reporter,
      ai: { model: '' }
    });

    assert.ok(aiLogs.length > 0, 'AI log stream should be recorded.');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outPath);
    const matrix = workbook.getWorksheet('Matrix');
    assert.ok(matrix, 'Matrix sheet should exist.');

    const row11 = findMatrixRow(matrix, '1.1');
    assert.ok(row11, 'Row for criterion 1.1 should exist.');
    assert.equal(row11.getCell(4).value, 1, '1.1 should be conform on good page.');
    assert.equal(row11.getCell(5).value, -1, '1.1 should be not conform on bad page.');

    const row21 = findMatrixRow(matrix, '2.1');
    assert.ok(row21, 'Row for criterion 2.1 should exist.');
    assert.equal(row21.getCell(4).value, 1, '2.1 should be conform on good page.');
    assert.equal(row21.getCell(5).value, 0, '2.1 should be NA on bad page.');

    const row127 = findMatrixRow(matrix, '12.7');
    assert.ok(row127, 'Row for criterion 12.7 should exist.');
    assert.equal(row127.getCell(4).value, 1, '12.7 should be conform on good page.');
    assert.equal(row127.getCell(5).value, -1, '12.7 should be not conform on bad page.');
  } finally {
    process.env.PATH = originalPath;
    if (originalCodex === undefined) delete process.env.CODEX_PATH;
    else process.env.CODEX_PATH = originalCodex;
    if (server) await new Promise((resolve) => server.close(resolve));
  }
});
