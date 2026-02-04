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
