const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { selectEncoding } = require('./negotiation.cjs');

const DEFAULT_ROOT = path.resolve(__dirname, '../build');
const DICTIONARY_CACHE = 'public, max-age=1209600, immutable';
const CSS_VARY = 'Accept-Encoding, Available-Dictionary';

function createDemoServer({ rootDir = DEFAULT_ROOT, tls, logger = console } = {}) {
  // Fail immediately with an actionable message if the project hasn't been built.
  if (!fs.existsSync(path.join(rootDir, 'demo-manifest.json'))) {
    throw new Error('Build assente: esegui npm run build prima di npm run serve.');
  }
  const handler = async (req, res) => {
    const plain = (status, message, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
      res.end(req.method === 'HEAD' ? undefined : message);
    };
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        plain(405, 'Metodo non consentito', { Allow: 'GET, HEAD' });
        return;
      }
      const pathname = new URL(req.url, 'http://localhost').pathname;
      // Reload the manifest so build:watch can publish a fresh set of assets.
      const manifest = JSON.parse(await fsp.readFile(path.join(rootDir, 'demo-manifest.json'), 'utf8'));
      const dictionary = manifest.dictionary;
      const css = manifest.resources.find((resource) => resource.url === pathname);
      const isDictionary = pathname === dictionary.url;
      const isHtml = pathname === '/' || pathname === '/index.html';
      const isManifest = pathname === '/demo-manifest.json';
      const isScript = /^\/dist\/app\.[a-f0-9]{16}\.js$/.test(pathname);
      if (!css && !isDictionary && !isHtml && !isManifest && !isScript) {
        plain(404, 'Risorsa non trovata');
        return;
      }
      const headers = {
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': isHtml || isManifest ? 'no-cache' : DICTIONARY_CACHE,
      };
      headers.Vary = css ? CSS_VARY : 'Accept-Encoding';
      const dictionaryMatches = Boolean(css) && req.headers['available-dictionary']?.trim() === `:${dictionary.sha256}:`;
      const encoding = selectEncoding(req.headers['accept-encoding'], dictionaryMatches,
        isManifest ? [] : ['dcb', 'br', 'gzip']);
      if (!encoding) {
        plain(406, 'Nessuna rappresentazione accettabile', { ...headers, 'Cache-Control': 'no-store' });
        return;
      }
      if (css) headers['Content-Type'] = 'text/css; charset=utf-8';
      if (isDictionary) {
        headers['Content-Type'] = 'application/octet-stream';
        headers['Use-As-Dictionary'] = `match="${dictionary.match}", id="${dictionary.id}"`;
      }
      if (isScript) headers['Content-Type'] = 'text/javascript; charset=utf-8';
      if (isManifest) headers['Content-Type'] = 'application/json; charset=utf-8';
      if (isHtml) {
        headers['Content-Type'] = 'text/html; charset=utf-8';
        headers.Link = `<${dictionary.url}>; rel="compression-dictionary"`;
      }
      const suffix = { identity: '', br: '.br', gzip: '.gz', dcb: '.dcb' }[encoding];
      const filename = isHtml ? 'index.html' : pathname.slice(1);
      const body = await fsp.readFile(path.join(rootDir, filename + suffix));
      if (encoding !== 'identity') headers['Content-Encoding'] = encoding;
      headers['Content-Length'] = body.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
      if (css) logger.info(`CSS ${encoding.padEnd(8)} ${body.length} B  ${pathname}`);
    } catch (error) {
      if (error.code === 'ENOENT') plain(404, 'Risorsa non trovata; la build potrebbe essere in aggiornamento.');
      else {
        logger.error(error);
        plain(500, 'Errore del server');
      }
    }
  };
  return tls ? https.createServer(tls, handler) : http.createServer(handler);
}

if (require.main === module) {
  try {
    if (Boolean(process.env.TLS_CERT) !== Boolean(process.env.TLS_KEY)) {
      throw new Error('Specifica sia TLS_CERT sia TLS_KEY per avviare HTTPS.');
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
