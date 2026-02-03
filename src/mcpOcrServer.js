import { readFile } from 'node:fs/promises';
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
  const worker = await getWorker(language);
  const result = await worker.recognize(buffer);
  const text = String(result?.data?.text || '');
  const confidence = Number.isFinite(result?.data?.confidence)
    ? Number(result.data.confidence)
    : null;

  const clipped = MAX_TEXT_LENGTH > 0 ? text.slice(0, MAX_TEXT_LENGTH) : text;
  return {
    text: clipped.trim(),
    confidence,
    lang: language,
    truncated: MAX_TEXT_LENGTH > 0 && text.length > MAX_TEXT_LENGTH
  };
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
