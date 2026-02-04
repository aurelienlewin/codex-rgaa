import { readFile, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { createWorker } from 'tesseract.js';

const DEFAULT_LANG = String(process.env.AUDIT_OCR_LANGS || 'fra+eng').trim() || 'fra+eng';
const MAX_TEXT_LENGTH = Math.max(
  0,
  Number.parseInt(process.env.AUDIT_OCR_MAX_CHARS || '4000', 10) || 4000
);
const DEBUG = String(process.env.AUDIT_OCR_DEBUG || '').trim().toLowerCase();

const workers = new Map();

function normalizeBase64(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const prefix = 'base64,';
  const idx = raw.indexOf(prefix);
  if (idx !== -1) {
    return raw.slice(idx + prefix.length).trim();
  }
  return raw;
}

async function getWorker(lang) {
  const key = String(lang || DEFAULT_LANG).trim() || DEFAULT_LANG;
  if (workers.has(key)) return workers.get(key);
  const worker = await createWorker({
    logger: DEBUG ? (m) => process.stderr.write(`${JSON.stringify(m)}\n`) : undefined
  });
  await worker.loadLanguage(key);
  await worker.initialize(key);
  workers.set(key, worker);
  return worker;
}

function normalizeOcrText(text) {
  const raw = String(text || '');
  const clipped = MAX_TEXT_LENGTH > 0 ? raw.slice(0, MAX_TEXT_LENGTH) : raw;
  return clipped.trim();
}

async function runCliOcr({ buffer, lang }) {
  const tmpDir = os.tmpdir();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const imgPath = path.join(tmpDir, `rgaa-ocr-${suffix}.png`);
  const language = String(lang || DEFAULT_LANG).trim() || DEFAULT_LANG;
  try {
    await writeFile(imgPath, buffer);
    const args = [imgPath, 'stdout', '-l', language];
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn('tesseract', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => {
        out += String(chunk || '');
      });
      child.stderr.on('data', (chunk) => {
        err += String(chunk || '');
      });
      child.on('error', (error) => reject(error));
      child.on('close', (code) => {
        if (code === 0) resolve(out);
        else reject(new Error(`tesseract exited with code ${code}: ${err.trim()}`));
      });
    });
    return {
      text: normalizeOcrText(stdout),
      confidence: null,
      lang: language,
      truncated: MAX_TEXT_LENGTH > 0 && stdout.length > MAX_TEXT_LENGTH,
      engine: 'tesseract-cli'
    };
  } finally {
    await unlink(imgPath).catch(() => {});
  }
}

async function runOcr({ path, base64, lang }) {
  let buffer = null;
  if (base64) {
    const normalized = normalizeBase64(base64);
    if (normalized) buffer = Buffer.from(normalized, 'base64');
  } else if (path) {
    buffer = await readFile(String(path));
  }
  if (!buffer) {
    throw new Error('OCR requires either "path" or "base64" input.');
  }

  const language = String(lang || DEFAULT_LANG).trim() || DEFAULT_LANG;
  try {
    const worker = await getWorker(language);
    const result = await worker.recognize(buffer);
    const text = String(result?.data?.text || '');
    const confidence = Number.isFinite(result?.data?.confidence)
      ? Number(result.data.confidence)
      : null;
    return {
      text: normalizeOcrText(text),
      confidence,
      lang: language,
      truncated: MAX_TEXT_LENGTH > 0 && text.length > MAX_TEXT_LENGTH,
      engine: 'tesseract.js'
    };
  } catch (err) {
    if (DEBUG) {
      process.stderr.write(`OCR failed with tesseract.js: ${String(err?.message || err)}\n`);
    }
    try {
      return await runCliOcr({ buffer, lang: language });
    } catch (cliErr) {
      if (language !== 'eng') {
        try {
          return await runCliOcr({ buffer, lang: 'eng' });
        } catch (fallbackErr) {
          const message = `OCR failed (tesseract.js + tesseract CLI): ${String(
            fallbackErr?.message || fallbackErr
          )}`;
          throw new Error(message);
        }
      }
      const message = `OCR failed (tesseract.js + tesseract CLI): ${String(cliErr?.message || cliErr)}`;
      throw new Error(message);
    }
  }
}

const server = new Server(
  {
    name: 'rgaa-ocr',
    version: '0.1.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'rgaa_ocr',
      description:
        'Run OCR on an image. Provide either a local file path or base64 image data; returns extracted text and confidence.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Local image path (png/jpg/webp).' },
          base64: {
            type: 'string',
            description: 'Base64 image data (raw or data URI).'
          },
          lang: {
            type: 'string',
            description: 'Tesseract language(s), e.g. "fra+eng".'
          }
        }
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params?.name;
  if (name !== 'rgaa_ocr') {
    throw new Error(`Unknown tool: ${name}`);
  }
  const args = request.params?.arguments || {};
  const result = await runOcr({
    path: args.path,
    base64: args.base64,
    lang: args.lang
  });
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result)
      }
    ]
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);

process.on('SIGINT', async () => {
  for (const worker of workers.values()) {
    try {
      await worker.terminate();
    } catch {}
  }
  process.exit(0);
});
