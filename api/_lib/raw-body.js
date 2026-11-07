// Read the EXACT bytes PayPal sent, so the webhook signature can be verified.
// Never hangs: handles an unparsed stream, an already-parsed body, and an already-consumed stream.
export async function getRawBody(req, { limit = 512 * 1024, timeoutMs = 8000 } = {}) {
  // Body parser ran (or a test passed a string/Buffer): use what we have.
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  // Parsed object: the stream is gone. Best-effort re-serialisation beats hanging until timeout.
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);

  if (typeof req.on !== 'function') throw new Error('Request body is not readable');
  if (req.readableEnded || (req.complete === true && req.readable === false)) throw new Error('Request body already consumed');

  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    const timer = setTimeout(() => reject(new Error('Timed out reading request body')), timeoutMs);
    const done = (fn, v) => { clearTimeout(timer); fn(v); };
    req.on('data', (chunk) => {
      length += chunk.length;
      if (length > limit) return done(reject, new Error('Payload too large'));
      chunks.push(chunk);
    });
    req.on('end', () => done(resolve, Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => done(reject, err));
  });
}
