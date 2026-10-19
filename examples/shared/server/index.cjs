const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { selectEncoding, encodeBody } = require('./negotiation.cjs');
const { MANIFEST_NAME, MANIFEST_URL, loadBuild, demoMetrics, renderHtml } = require('./build.cjs');

// Workspace scripts start this shared server from the selected example.
const DEFAULT_ROOT = path.resolve(process.cwd(), 'build');
const DICTIONARY_CACHE = 'public, max-age=1209600, immutable';
const CSS_VARY = 'Accept-Encoding, Available-Dictionary';

function createDemoServer({ rootDir = DEFAULT_ROOT, tls, logger = console } = {}) {
  // Fail immediately with an actionable message if the project hasn't been built.
  if (!fs.existsSync(path.join(rootDir, MANIFEST_NAME)) || !fs.existsSync(path.join(rootDir, 'index.html'))) {
    throw new Error('Build missing: run npm run build before npm run serve.');
  }
  const handler = async (req, res) => {
    const plain = (status, message, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
      res.end(req.method === 'HEAD' ? undefined : message);
    };
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        plain(405, 'Method not allowed', { Allow: 'GET, HEAD' });
        return;
      }
      const pathname = new URL(req.url, 'http://localhost').pathname;
      // One source of dictionary identities for discovery and HTTP negotiation.
      const build = await loadBuild(rootDir);
      const css = build.resources.find((resource) => resource.url === pathname);
      const dictionary = build.dictionaries.find((item) => item.url === pathname);
      const script = build.scripts.find((item) => item.url === pathname);
      const isHtml = pathname === '/' || pathname === '/index.html';
      const isMetrics = pathname === '/api/demo-stats';
      const isManifest = pathname === MANIFEST_URL;
      if (!css && !dictionary && !isHtml && !isManifest && !isMetrics && !script) {
        plain(404, 'Resource not found');
        return;
      }
      const headers = {
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': isHtml || isManifest || isMetrics ? 'no-cache' : DICTIONARY_CACHE,
      };
      headers.Vary = css ? CSS_VARY : 'Accept-Encoding';
      const cssDictionary = css && build.dictionaries.find((item) => item.url === css.dictionaryUrl);
      const dictionaryMatches = Boolean(cssDictionary)
        && req.headers['available-dictionary']?.trim() === `:${cssDictionary.sha256Base64}:`;
      const asset = css || dictionary || script;
      const supported = asset || isHtml ? [...(cssDictionary ? ['dcb'] : []), 'br', 'gzip'] : [];
      const encoding = selectEncoding(req.headers['accept-encoding'], dictionaryMatches, supported);
      if (!encoding) {
        plain(406, 'No acceptable representation', { ...headers, 'Cache-Control': 'no-store' });
        return;
      }
      if (css) headers['Content-Type'] = 'text/css; charset=utf-8';
      if (dictionary) {
        headers['Content-Type'] = 'application/octet-stream';
        headers['Use-As-Dictionary'] = `match="${dictionary.match}", id="${dictionary.id}"`;
      }
      if (script) headers['Content-Type'] = 'text/javascript; charset=utf-8';
      if (isManifest || isMetrics) headers['Content-Type'] = 'application/json; charset=utf-8';
      let body;
      if (isHtml) {
        headers['Content-Type'] = 'text/html; charset=utf-8';
        if (build.dictionaries.length) {
          headers.Link = build.dictionaries.map((item) => `<${item.url}>; rel="compression-dictionary"`).join(', ');
        }
        // Inject before compression so every HTML representation uses this manifest.
        body = Buffer.from(renderHtml(await fsp.readFile(path.join(rootDir, 'index.html'), 'utf8'), build.dictionaries));
      } else if (isManifest) {
        body = build.manifestBytes;
      } else if (isMetrics) {
        body = Buffer.from(`${JSON.stringify(demoMetrics(build), null, 2)}\n`);
      } else {
        body = encoding === 'dcb' ? css.dcbContent : asset.content;
      }
      if (encoding !== 'dcb') body = encodeBody(body, encoding);
      if (encoding !== 'identity') headers['Content-Encoding'] = encoding;
      headers['Content-Length'] = body.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
      if (css) logger.info(`CSS ${encoding.padEnd(8)} ${body.length} B  ${pathname}`);
    } catch (error) {
      if (error.code === 'ENOENT') plain(404, 'Resource not found; the build may be updating.');
      else {
        logger.error(error);
        plain(500, 'Server error');
      }
    }
  };
  return tls ? https.createServer(tls, handler) : http.createServer(handler);
}

if (require.main === module) {
  try {
    if (Boolean(process.env.TLS_CERT) !== Boolean(process.env.TLS_KEY)) {
      throw new Error('Specify both TLS_CERT and TLS_KEY to start HTTPS.');
    }
    const tls = process.env.TLS_CERT ? {
      cert: fs.readFileSync(process.env.TLS_CERT),
      key: fs.readFileSync(process.env.TLS_KEY),
    } : undefined;
    const host = process.env.HOST || 'localhost';
    const port = Number(process.env.PORT || 8080);
    const server = createDemoServer({ tls });
    server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
    server.listen(port, host, () => console.log(`Demo: ${tls ? 'https' : 'http'}://${host}:${port}`));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { createDemoServer };
