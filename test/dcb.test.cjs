const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { brotliDecompressSync, gunzipSync } = require('node:zlib');
const brotli = require('brotli-wasm-custom-dictionary');
const { createDemoServer } = require('../server/index.cjs');

const rootDir = path.resolve(__dirname, '../build');
const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'demo-manifest.json')));
const dictionary = fs.readFileSync(path.join(rootDir, manifest.dictionary.url));
const hash = createHash('sha256').update(dictionary).digest();
const resource = manifest.resources[0];
const css = fs.readFileSync(path.join(rootDir, resource.url));
const server = createDemoServer({ rootDir, logger: { info() {}, error() {} } });
let origin;
before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

// node:http preserves the encoded body; fetch would transparently decompress br/gzip.
function request(url, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    http.get(origin + url, { headers, method }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

test('build: DCB contains the raw dictionary hash and restores the exact minified CSS', () => {
  assert.equal(manifest.dictionary.sha256, hash.toString('base64'));
  assert.equal(dictionary.length, manifest.dictionary.bytes);
  assert.notDeepEqual(css, dictionary, 'The fixture represents two different releases');
  for (const asset of manifest.resources) {
    const original = fs.readFileSync(path.join(rootDir, asset.url));
    const dcb = fs.readFileSync(path.join(rootDir, `${asset.url}.dcb`));
    assert.deepEqual(dcb.subarray(0, 4), Buffer.from([0xff, 0x44, 0x43, 0x42]));
    assert.deepEqual(dcb.subarray(4, 36), hash);
    assert.deepEqual(Buffer.from(brotli.decompress(dcb.subarray(36), { customDictionary: dictionary })), original);
    assert.throws(() => brotli.decompress(dcb.subarray(36)), 'This fixture actually requires the dictionary');
    assert.equal(dcb.length, asset.dcbBytes);
    assert.equal(original.length, asset.bytes);
    for (const [extension, size, decode] of [
      ['br', asset.brotliBytes, brotliDecompressSync], ['gz', asset.gzipBytes, gunzipSync],
    ]) {
      const encoded = fs.readFileSync(path.join(rootDir, `${asset.url}.${extension}`));
      assert.equal(encoded.length, size);
      assert.deepEqual(decode(encoded), original);
    }
  }
});

test('discovery: versioned dictionary, two-week cache and native HTML link', async () => {
  const dict = await request(manifest.dictionary.url, { 'Accept-Encoding': 'br' });
  assert.equal(dict.status, 200);
  assert.equal(dict.headers['use-as-dictionary'], `match="/dist/styles.*.css", id="${manifest.dictionary.id}"`);
  assert.equal(dict.headers['cache-control'], 'public, max-age=1209600, immutable');
  assert.equal(dict.headers.vary, 'Accept-Encoding');
  assert.equal(dict.headers['content-encoding'], 'br');
  assert.equal(dict.body.length, manifest.dictionary.brotliBytes);
  assert.deepEqual(brotliDecompressSync(dict.body), dictionary);
  const html = await request('/');
  assert.equal(html.status, 200);
  assert.ok(html.body.toString().includes(`rel="compression-dictionary" href="${manifest.dictionary.url}"`));
  assert.ok(html.body.toString().includes(`href="${resource.url}"`));
  assert.ok(!html.body.toString().includes('.css.dcb'));
});

test('negotiation: hash and Accept-Encoding are both required; quality and fallback respected', async () => {
  const available = `:${manifest.dictionary.sha256}:`;
  const cases = [
    [{}, 'identity'],
    [{ 'Accept-Encoding': 'gzip, br' }, 'br'],
    [{ 'Accept-Encoding': 'gzip' }, 'gzip'],
    [{ 'Accept-Encoding': 'br, dcb' }, 'br'],
    [{ 'Accept-Encoding': 'br, dcb', 'Available-Dictionary': ':unknown:' }, 'br'],
    [{ 'Accept-Encoding': 'br, dcb', 'Dictionary-ID': `"${manifest.dictionary.id}"` }, 'br'],
    [{ 'Accept-Encoding': 'br', 'Available-Dictionary': available }, 'br'],
    [{ 'Accept-Encoding': 'gzip, br, dcb', 'Available-Dictionary': available }, 'dcb'],
    [{ 'Accept-Encoding': 'br, dcb;q=0', 'Available-Dictionary': available }, 'br'],
    [{ 'Accept-Encoding': 'dcb;q=0.5, br;q=1', 'Available-Dictionary': available }, 'br'],
    [{ 'Accept-Encoding': 'dcb;q=1, br;q=0.5', 'Available-Dictionary': available }, 'dcb'],
    [{ 'Accept-Encoding': 'br;q=0.2, identity;q=1' }, 'identity'],
    [{ 'Accept-Encoding': 'br;q=0, gzip;q=0, dcb;q=0' }, 'identity'],
    [{ 'Accept-Encoding': '*', 'Available-Dictionary': available }, 'br'],
    [{ 'Accept-Encoding': 'x-dcb, br', 'Available-Dictionary': available }, 'br'],
    [{ 'Accept-Encoding': 'dcb;q=oops, br', 'Available-Dictionary': available }, 'br'],
  ];
  for (const [headers, expected] of cases) {
    const result = await request(`${resource.url}?case=${encodeURIComponent(JSON.stringify(headers))}`, headers);
    assert.equal(result.status, 200);
    assert.equal(result.headers['content-encoding'] || 'identity', expected, JSON.stringify(headers));
    assert.equal(result.headers.vary, 'Accept-Encoding, Available-Dictionary');
    assert.equal(result.headers['content-type'], 'text/css; charset=utf-8');
    assert.equal(Number(result.headers['content-length']), result.body.length);
    const decoders = {
      identity: (body) => body,
      br: brotliDecompressSync,
      gzip: gunzipSync,
      dcb: (body) => Buffer.from(brotli.decompress(body.subarray(36), { customDictionary: dictionary })),
    };
    assert.deepEqual(decoders[expected](result.body), css);
  }
});

test('reject unacceptable encodings and keep raw sidecars/private paths inaccessible', async () => {
  assert.equal((await request('/demo-manifest.json', { 'Accept-Encoding': 'identity;q=0' })).status, 406);
  for (const value of ['*;q=0', 'br;q=0, gzip;q=0, identity;q=0', 'dcb, identity;q=0']) {
    const result = await request(resource.url, { 'Accept-Encoding': value });
    assert.equal(result.status, 406, value);
    assert.equal(result.headers.vary, 'Accept-Encoding, Available-Dictionary');
  }
  for (const url of [resource.url + '.dcb', '/package.json', '/%2e%2e/package.json', '/missing.css']) {
    assert.equal((await request(url)).status, 404, url);
  }
  const head = await request(resource.url, { 'Accept-Encoding': 'dcb', 'Available-Dictionary': `:${manifest.dictionary.sha256}:` }, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(Number(head.headers['content-length']), resource.dcbBytes);
  assert.equal(head.headers['content-encoding'], 'dcb');
  assert.equal((await request(resource.url, {}, 'POST')).status, 405);
});
