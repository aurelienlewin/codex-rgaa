import fs from 'node:fs/promises';

function isObject(x) {
  return x && typeof x === 'object' && !Array.isArray(x);
}

function walkSchema(schema, visit, ctx = { path: '$' }) {
  if (!isObject(schema)) return;

  visit(schema, ctx);

  if (isObject(schema.properties)) {
    for (const [key, child] of Object.entries(schema.properties)) {
      walkSchema(child, visit, { path: `${ctx.path}.properties.${key}` });
    }
  }
  if (schema.items) {
    walkSchema(schema.items, visit, { path: `${ctx.path}.items` });
  }

  for (const kw of ['anyOf', 'oneOf', 'allOf']) {
    const arr = schema[kw];
    if (Array.isArray(arr)) {
      arr.forEach((child, i) => walkSchema(child, visit, { path: `${ctx.path}.${kw}[${i}]` }));
    }
  }
}

export async function validateStrictOutputSchema(schemaPath) {
  const raw = await fs.readFile(schemaPath, 'utf-8');
  const schema = JSON.parse(raw);

  const problems = [];

  walkSchema(schema, (node, ctx) => {
    const hasProps = isObject(node.properties) && Object.keys(node.properties).length > 0;
    const isObj = node.type === 'object' || hasProps;
    if (!isObj) return;
    if (!hasProps) return;

    if (!Array.isArray(node.required)) {
      problems.push(`${ctx.path}: missing required[]`);
      return;
    }

    const propKeys = Object.keys(node.properties);
    const missing = propKeys.filter((k) => !node.required.includes(k));
    if (missing.length) {
      problems.push(`${ctx.path}: required[] missing keys: ${missing.join(', ')}`);
    }

    // OpenAI/Codex structured-output schemas are strict; missing this tends to cause 400s.
    if (node.additionalProperties !== false) {
      problems.push(`${ctx.path}: additionalProperties must be false`);
    }
  });

  return { ok: problems.length === 0, problems };
}

