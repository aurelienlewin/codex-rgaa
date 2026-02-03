import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

async function readJson(relPath) {
  const abs = path.join(PROJECT_ROOT, relPath);
  const txt = await fs.readFile(abs, 'utf8');
  return JSON.parse(txt);
}

function walkSchema(schema, { onObject }, ctx = { path: '$' }) {
  if (!schema || typeof schema !== 'object') return;

  if (schema.type === 'object' || schema.properties) {
    onObject?.(schema, ctx);

    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const [key, child] of Object.entries(props)) {
      walkSchema(child, { onObject }, { path: `${ctx.path}.properties.${key}` });
    }
  }

  if (schema.type === 'array' || schema.items) {
    walkSchema(schema.items, { onObject }, { path: `${ctx.path}.items` });
  }

  // Support common schema constructs used elsewhere in the project.
  if (schema.anyOf && Array.isArray(schema.anyOf)) {
    schema.anyOf.forEach((s, i) => walkSchema(s, { onObject }, { path: `${ctx.path}.anyOf[${i}]` }));
  }
  if (schema.oneOf && Array.isArray(schema.oneOf)) {
    schema.oneOf.forEach((s, i) => walkSchema(s, { onObject }, { path: `${ctx.path}.oneOf[${i}]` }));
  }
  if (schema.allOf && Array.isArray(schema.allOf)) {
    schema.allOf.forEach((s, i) => walkSchema(s, { onObject }, { path: `${ctx.path}.allOf[${i}]` }));
  }
}

function assertRequiredMatchesProperties(schema, ctx) {
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : null;
  if (!props) return;
  const propKeys = Object.keys(props);
  if (propKeys.length === 0) return;

  const req = schema.required;
  assert.ok(Array.isArray(req), `${ctx.path}: missing required[] for object schema`);

  const missing = propKeys.filter((k) => !req.includes(k));
  assert.deepEqual(missing, [], `${ctx.path}: required[] must include all properties (missing: ${missing.join(', ')})`);
}

test('OpenAI structured-output schemas require all object properties to be listed in required[]', async () => {
  const snapshotSchema = await readJson('data/mcp-snapshot-schema.json');
  const listPagesSchema = await readJson('data/mcp-list-pages-schema.json');

  for (const schema of [snapshotSchema, listPagesSchema]) {
    walkSchema(schema, { onObject: assertRequiredMatchesProperties });
  }
});

