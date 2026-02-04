export function attachIgnoreEpipe(stream, onError) {
  if (!stream || typeof stream.on !== 'function') return;
  stream.on('error', (err) => {
    if (!err || err.code === 'EPIPE' || err.code === 'ERR_STREAM_WRITE_AFTER_END') return;
    if (typeof onError === 'function') onError(err);
  });
}
