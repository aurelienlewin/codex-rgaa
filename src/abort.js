export function createAbortError(message = 'Aborted') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export function isAbortError(err) {
  return Boolean(err && (err.name === 'AbortError' || err.message === 'Aborted'));
}
