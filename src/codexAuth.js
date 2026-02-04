import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let missingAuthAlerted = false;

export function looksLikeMissingAuth(text) {
  const normalized = String(text || '').toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes('missing bearer authentication') ||
    normalized.includes('unauthorized') ||
    normalized.includes('401') ||
    normalized.includes('api key') ||
    normalized.includes('openai_api_key')
  );
}

export function maybeHandleMissingAuth({ onLog, onError, stderr }) {
  if (missingAuthAlerted) return false;
  if (!looksLikeMissingAuth(stderr)) return false;
  missingAuthAlerted = true;
  const message =
    'Missing OpenAI API credentials. Set OPENAI_API_KEY or configure ~/.codex/config.toml, then retry.';
  if (onError) onError(message);
  else onLog?.(`Codex: ${message}`);
  return true;
}

export function applyCodexBaseUrlFromConfig(env, codexHome) {
  if (!env || env.OPENAI_BASE_URL) return env;
  const home = codexHome || env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const configPath = path.join(home, 'config.toml');
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const match = content.match(/^\s*base_url\s*=\s*\"([^\"]+)\"\s*$/m);
    if (match && match[1]) {
      env.OPENAI_BASE_URL = match[1].trim();
    }
  } catch {}
  return env;
}
