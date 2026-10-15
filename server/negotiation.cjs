const { brotliCompressSync, gzipSync, constants } = require('node:zlib');

// Prefer a compressed representation unless identity is explicitly preferred.
// An unknown/missing dictionary can never select dcb, even with Dictionary-ID.
function selectEncoding(acceptEncoding, dictionaryMatches = false, supported = ['dcb', 'br', 'gzip']) {
  if (!acceptEncoding?.trim()) return 'identity';
  const weights = new Map();
  for (const entry of acceptEncoding.toLowerCase().split(',')) {
    const [token, ...parameters] = entry.trim().split(';').map((part) => part.trim());
    if (!token) continue;
    let q = 1;
    if (parameters.length) {
      const match = parameters.length === 1 && /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.exec(parameters[0]);
      q = match ? Number(match[1]) : 0;
    }
    weights.set(token, Math.min(weights.get(token) ?? 1, q));
  }
  const quality = (encoding) => weights.get(encoding) ?? weights.get('*') ?? 0;
  const candidates = supported
    .filter((encoding) => encoding !== 'dcb' || (dictionaryMatches && weights.has('dcb')))
    .map((encoding) => ({ encoding, q: quality(encoding) }))
    .filter(({ q }) => q > 0)
    .sort((a, b) => b.q - a.q);
  const identityQuality = weights.get('identity') ?? (weights.get('*') === 0 ? 0 : null);
  if (candidates.length) {
    if (identityQuality !== null && identityQuality > candidates[0].q) return 'identity';
    return candidates[0].encoding;
  }
  return identityQuality === 0 ? null : 'identity';
}

// Ordinary HTTP compression belongs to the server; DCB is already built by Webpack.
function encodeBody(body, encoding) {
  if (encoding === 'br') {
    return brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  }
  if (encoding === 'gzip') return gzipSync(body, { level: 9 });
  if (encoding === 'identity') return body;
  throw new Error(`Codifica HTTP non gestita: ${encoding}`);
}

module.exports = { selectEncoding, encodeBody };
