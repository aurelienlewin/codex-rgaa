import fs from 'node:fs/promises';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { analyzeContrast, analyzeDomHints, analyzeHtmlHints, analyzeMotion } from './enrichment.js';

const MAX_HTML_LENGTH = Math.max(
  0,
  Number.parseInt(process.env.AUDIT_UTILS_HTML_MAX_CHARS || '200000', 10) || 200000
);

async function readHtml({ html, filePath }) {
  if (html) return String(html);
  if (!filePath) return '';
  const resolved = path.resolve(String(filePath));
  return fs.readFile(resolved, 'utf-8');
}

function parseFontSizePx(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const match = raw.match(/([0-9.]+)/);
  if (!match) return null;
  const n = Number.parseFloat(match[1]);
  return Number.isFinite(n) ? n : null;
}

function isBold(fontWeight) {
  const raw = String(fontWeight || '').trim();
  if (!raw) return false;
  if (/bold/i.test(raw)) return true;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n >= 700 : false;
}

function classifyContrast({ ratio, fontSizePx, fontWeight }) {
  if (!Number.isFinite(ratio)) return null;
  const size = Number.isFinite(fontSizePx) ? fontSizePx : null;
  const bold = isBold(fontWeight);
  const largeText = size !== null && (size >= 24 || (size >= 18.66 && bold));
  const aa = ratio >= (largeText ? 3 : 4.5);
  const aaa = ratio >= (largeText ? 4.5 : 7);
  return { aa, aaa, largeText };
}

const server = new Server(
  {
    name: 'rgaa-utils',
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
      name: 'rgaa_html_analyze',
      description:
        'Analyze HTML for accessibility-related hints (DOM + HTML patterns). Provide inline HTML or a local file path.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          html: { type: 'string', description: 'HTML string to analyze.' },
          path: { type: 'string', description: 'Local HTML file path.' }
        }
      }
    },
    {
      name: 'rgaa_contrast_samples',
      description:
        'Compute contrast ratios for style samples (text + colors) and return a summary.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          samples: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                text: { type: 'string' },
                selector: { type: 'string' },
                color: { type: 'string' },
                backgroundColor: { type: 'string' },
                fontSize: { type: 'string' },
                fontWeight: { type: 'string' }
              }
            }
          }
        },
        required: ['samples']
      }
    },
    {
      name: 'rgaa_motion_diff',
      description:
        'Analyze two full-page screenshots for motion/animation signals.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          screenshot1: { type: 'string', description: 'First screenshot path.' },
          screenshot2: { type: 'string', description: 'Second screenshot path.' }
        },
        required: ['screenshot1', 'screenshot2']
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params?.name;
  const args = request.params?.arguments || {};

  if (name === 'rgaa_html_analyze') {
    const html = await readHtml({ html: args.html, filePath: args.path });
    const clipped = MAX_HTML_LENGTH > 0 ? html.slice(0, MAX_HTML_LENGTH) : html;
    const htmlHints = analyzeHtmlHints(clipped);
    const domHints = analyzeDomHints(clipped);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            length: html.length,
            truncated: MAX_HTML_LENGTH > 0 && html.length > MAX_HTML_LENGTH,
            htmlHints,
            domHints
          })
        }
      ]
    };
  }

  if (name === 'rgaa_contrast_samples') {
    const samples = Array.isArray(args.samples) ? args.samples : [];
    const summary = analyzeContrast(samples);
    const worst = summary?.worstSample || null;
    const classification = worst
      ? classifyContrast({
          ratio: worst.ratio,
          fontSizePx: parseFontSizePx(worst.fontSize),
          fontWeight: worst.fontWeight
        })
      : null;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            summary,
            worstClassification: classification
          })
        }
      ]
    };
  }

  if (name === 'rgaa_motion_diff') {
    const result = await analyzeMotion({
      screenshot1: args.screenshot1,
      screenshot2: args.screenshot2
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result)
        }
      ]
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
