const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const brotli = require('brotli-wasm-custom-dictionary');
const compressionDictionary = require('use-as-dictionary/vite');

const MANIFEST_NAME = 'dist/compression-dictionary-manifest.json';
const hash = (bytes) => createHash('sha256').update(bytes).digest();

function fixture(t, files = {}) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'vite-dictionary-test-'));
  const outputPath = path.join(directory, 'build');
  const write = (name, bytes) => {
    const filename = path.join(directory, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes);
  };
  write('index.html', '<html><head></head><body><script type="module" src="/main.js"></script></body></html>');
  write('main.js', 'document.body.dataset.ready = "yes";');
  for (const [name, bytes] of Object.entries(files)) write(name, bytes);
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
    assert.ok(path.basename(directory).startsWith('vite-dictionary-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    outputPath,
    write,
    async build(plugins = [], overrides = {}) {
      const { build } = await import('vite');
      const result = await build({
        root: directory,
        configFile: false,
        logLevel: 'silent',
        plugins,
        ...overrides,
        build: { outDir: outputPath, emptyOutDir: true, ...overrides.build },
      });
      const outputs = Array.isArray(result) ? result.flatMap(({ output }) => output) : result.output;
      return new Map(outputs.map((asset) => [asset.fileName,
        overrides.build?.write === false
          ? Buffer.from(asset.type === 'chunk' ? asset.code : asset.source)
          : fs.readFileSync(path.join(outputPath, asset.fileName)),
      ]));
    },
  };
}

function emitAssets(assets) {
  return {
    name: 'test-assets',
    generateBundle() {
      for (const [fileName, source] of Object.entries(assets)) this.emitFile({ type: 'asset', fileName, source });
    },
  };
}

function dictionaryNames(assets) {
  return [...assets.keys()].filter((name) => name.endsWith('.dat')).sort();
}

function assertManifest(assets) {
  assert.ok(assets.has(MANIFEST_NAME));
  const manifest = JSON.parse(assets.get(MANIFEST_NAME));
  assert.deepEqual(Object.keys(manifest), ['dictionaries']);
  assert.deepEqual(Object.keys(manifest.dictionaries), dictionaryNames(assets));
  for (const name of dictionaryNames(assets)) {
    const sha256Base64 = hash(assets.get(name)).toString('base64');
    assert.deepEqual(manifest.dictionaries[name], { sha256Base64, availableDictionary: `:${sha256Base64}:` });
  }
  return manifest;
}

function assertDcb(assets, filename, expected, dictionaryName = dictionaryNames(assets)[0]) {
  assertManifest(assets);
  const dictionary = assets.get(dictionaryName);
  const dcb = assets.get(filename);
  assert.ok(dcb, `Missing ${filename}`);
  assert.deepEqual(dcb.subarray(0, 4), Buffer.from([0xff, 0x44, 0x43, 0x42]));
  assert.deepEqual(dcb.subarray(4, 36), hash(dictionary));
  assert.deepEqual(Buffer.from(brotli.decompress(dcb.subarray(36), { customDictionary: dictionary })), expected);
}

test('vite: compresses final minified CSS and JS with final hashed names, preserving every original asset', async (t) => {
  const project = fixture(t, {
    'main.js': 'import "./styles.css"; document.body.dataset.message = "hello from the final chunk";',
    'styles.css': '/* source formatting */\n.card { color: #ffffff; margin: 0px 0px 0px 0px; }\n',
  });
  const baseline = await project.build();
  const assets = await project.build([compressionDictionary({ test: /\.(css|js)$/ })]);
  const cssName = [...baseline.keys()].find((name) => name.endsWith('.css'));
  assert.match(cssName, /^assets\/index-[\w-]+\.css$/);
  assert.ok(!assets.get(cssName).toString().includes('source formatting'));
  for (const [name, bytes] of baseline) {
    assert.deepEqual(assets.get(name), bytes, `Original ${name} must be unchanged`);
    if (/\.(css|js)$/.test(name)) {
      const dictionaryName = `dictionaries/${hash(bytes).toString('hex')}.dat`;
      assert.deepEqual(assets.get(dictionaryName), bytes);
      assertDcb(assets, `${name}.dcb`, bytes, dictionaryName);
    }
  }
  assert.equal(assets.size, baseline.size + 5);
});

test('vite: multiple instances share one sorted manifest and deduplicate identical dictionaries', async (t) => {
  const snapshot = Buffer.from('dictionary bytes for a shared snapshot'.repeat(20));
  const first = Buffer.from('first resource '.repeat(100));
  const second = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256));
  const project = fixture(t, { 'one/shared.css': snapshot, 'two/shared.dat': snapshot });
  const assets = await project.build([
    emitAssets({ 'first/data.bin': first, 'second/data.bin': second, 'untouched.bin': 'unchanged' }),
    compressionDictionary({ test: 'first/data.bin', dictionarySource: 'one/shared.css' }),
    compressionDictionary({ test: 'second/data.bin', dictionarySource: 'two/shared.dat' }),
  ]);
  assert.equal(dictionaryNames(assets).length, 1);
  assert.match(dictionaryNames(assets)[0], /^dictionaries\/shared\.[a-f0-9]{64}\.dat$/);
  assertDcb(assets, 'first/data.bin.dcb', first);
  assertDcb(assets, 'second/data.bin.dcb', second);
  assert.equal(assets.get('untouched.bin').toString(), 'unchanged');
  assert.ok(!assets.has('untouched.bin.dcb'));
});

test('vite: external input supports custom output names and frozen dictionary bytes', async (t) => {
  const content = Buffer.from('current resource '.repeat(300));
  const snapshot = Buffer.from('snapshot\r\n'.repeat(250));
  const project = fixture(t, { 'source/raw.bin': content, 'snapshots/fixed.dat': snapshot });
  const assets = await project.build([compressionDictionary({
    input: 'source/raw.bin', dictionarySource: 'snapshots/fixed.dat', dcbFilename: 'representations/current.dcb', quality: 4,
  })]);
  assert.deepEqual(assets.get(dictionaryNames(assets)[0]), snapshot);
  assertDcb(assets, 'representations/current.dcb', content);
  assert.ok(!assets.has('raw.bin'));
  assert.deepEqual(fs.readFileSync(path.join(project.directory, 'snapshots/fixed.dat')), snapshot);
});

test('vite: automatic dictionaries persist after successful writes, reuse and rotate across builds', async (t) => {
  const first = Buffer.from('.first { color: purple; padding: 10px; }\n'.repeat(200));
  const second = Buffer.from('.second { display: grid; gap: 20px; }\n'.repeat(200));
  const project = fixture(t, { 'input.css': first });
  const dictionaryPath = path.join(project.directory, 'cache/styles.css');
  const reuse = compressionDictionary({ input: 'input.css', dictionarySource: 'cache/styles.css', autoUpdate: { minSavings: 0 } });
  const initial = await project.build([reuse]);
  assert.deepEqual(fs.readFileSync(dictionaryPath), first);
  assertDcb(initial, 'input.css.dcb', first);
  project.write('input.css', second);
  const reused = await project.build([reuse]);
  assert.deepEqual(dictionaryNames(reused), dictionaryNames(initial));
  assert.deepEqual(fs.readFileSync(dictionaryPath), first);
  assertDcb(reused, 'input.css.dcb', second);
  const rotated = await project.build([compressionDictionary({
    input: 'input.css', dictionarySource: 'cache/styles.css', autoUpdate: { minSavings: 1 },
  })]);
  assert.notDeepEqual(dictionaryNames(rotated), dictionaryNames(initial));
  assert.deepEqual(fs.readFileSync(dictionaryPath), second);
  assertDcb(rotated, 'input.css.dcb', second);
});

test('vite: build.write false returns valid generated assets without creating or updating automatic state', async (t) => {
  const initial = Buffer.from('initial resource '.repeat(150));
  const current = Buffer.from('new resource '.repeat(250));
  const project = fixture(t, { 'input.txt': current, 'cache/existing.txt': initial });
  for (const filename of ['missing.txt', 'existing.txt']) {
    const assets = await project.build([compressionDictionary({
      input: 'input.txt', dictionarySource: `cache/${filename}`, autoUpdate: { minSavings: 1 },
    })], { build: { write: false } });
    assertDcb(assets, 'input.txt.dcb', current);
  }
  assert.equal(fs.existsSync(path.join(project.directory, 'cache/missing.txt')), false);
  assert.deepEqual(fs.readFileSync(path.join(project.directory, 'cache/existing.txt')), initial);
  assert.equal(fs.existsSync(project.outputPath), false);
});

for (const stage of ['generateBundle', 'writeBundle']) {
  test(`vite: failure in another ${stage} hook does not persist automatic state`, async (t) => {
    const initial = Buffer.from('old dictionary '.repeat(150));
    const project = fixture(t, { 'input.txt': 'new resource '.repeat(250), 'cache/current.txt': initial });
    const plugin = compressionDictionary({ input: 'input.txt', dictionarySource: 'cache/current.txt', autoUpdate: { minSavings: 1 } });
    const failure = { name: 'hook-failure', enforce: 'post', [stage]: { order: 'post', sequential: true, handler() { throw new Error(`${stage} failure`); } } };
    await assert.rejects(project.build(stage === 'writeBundle' ? [failure, plugin] : [plugin, failure]), new RegExp(`${stage} failure`));
    assert.deepEqual(fs.readFileSync(path.join(project.directory, 'cache/current.txt')), initial);
    const recovered = await project.build([plugin]);
    const current = Buffer.from('new resource '.repeat(250));
    assert.deepEqual(fs.readFileSync(path.join(project.directory, 'cache/current.txt')), current);
    assertDcb(recovered, 'input.txt.dcb', current);
  });
}

test('vite: output write failure does not create an automatic dictionary', async (t) => {
  const project = fixture(t, { 'input.txt': 'resource bytes '.repeat(100) });
  const blocker = {
    name: 'block-output',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler() {
        fs.mkdirSync(project.outputPath, { recursive: true });
        fs.writeFileSync(path.join(project.outputPath, 'dictionaries'), 'cannot create a directory here');
      },
    },
  };
  await assert.rejects(project.build([
    compressionDictionary({ input: 'input.txt', dictionarySource: 'cache/new.txt', autoUpdate: {} }), blocker,
  ]));
  assert.equal(fs.existsSync(path.join(project.directory, 'cache/new.txt')), false);
});

test('vite: automatic state rejects a later post writeBundle hook with an ordering instruction', async (t) => {
  const project = fixture(t, { 'input.txt': 'resource bytes' });
  await assert.rejects(project.build([
    compressionDictionary({ input: 'input.txt', dictionarySource: 'cache/current.txt', autoUpdate: {} }),
    { name: 'late-write-hook', enforce: 'post', writeBundle: { order: 'post', handler() {} } },
  ]), /move it after that plugin/);
  assert.equal(fs.existsSync(path.join(project.directory, 'cache/current.txt')), false);
});

test('vite: stateful regex selectors reset for each asset and each build', async (t) => {
  const project = fixture(t);
  const selector = /\.txt$/g;
  selector.lastIndex = 999;
  const plugin = compressionDictionary({ test: selector });
  for (const contents of [
    { 'a.txt': 'first content', 'b.txt': 'second content' },
    { 'c.txt': 'third content', 'd.txt': 'fourth content' },
  ]) {
    const assets = await project.build([emitAssets(contents), plugin]);
    assert.equal(dictionaryNames(assets).length, 2);
    for (const [name, content] of Object.entries(contents)) {
      const bytes = Buffer.from(content);
      assertDcb(assets, `${name}.dcb`, bytes, `dictionaries/${hash(bytes).toString('hex')}.dat`);
    }
  }
  assert.equal(selector.lastIndex, 999);
});

test('vite: overlapping selectors, existing DCB files and reserved manifest paths reject collisions', async (t) => {
  const project = fixture(t, { 'input.txt': 'input content' });
  await assert.rejects(project.build([
    emitAssets({ 'a.txt': 'resource' }), compressionDictionary({ test: 'a.txt' }), compressionDictionary({ test: /\.txt$/ }),
  ]), /output collision at a\.txt\.dcb/);
  await assert.rejects(project.build([
    emitAssets({ 'a.txt': 'resource', 'a.txt.dcb': 'existing' }), compressionDictionary({ test: 'a.txt' }),
  ]), /output collision at a\.txt\.dcb/);
  await assert.rejects(project.build([
    emitAssets({ 'a.txt': 'resource', [MANIFEST_NAME]: '{}' }), compressionDictionary({ test: 'a.txt' }),
  ]), /output collision at dist\/compression-dictionary-manifest\.json/);
  await assert.rejects(project.build([
    compressionDictionary({ input: 'input.txt', dcbFilename: MANIFEST_NAME }),
  ]), /reserved for the dictionary manifest/);
});

test('vite: dictionary outputs must not overwrite copied public files', async (t) => {
  const project = fixture(t, { 'input.txt': 'resource bytes', 'public/input.txt.dcb': 'public content' });
  await assert.rejects(project.build([compressionDictionary({ input: 'input.txt' })]), /already exists in publicDir/);
});

test('vite: automatic source paths cannot overlap inputs, fixed dictionaries, other writers or output directories', async (t) => {
  const project = fixture(t, { 'input.txt': 'resource bytes', 'other.txt': 'different bytes' });
  const automatic = (source) => compressionDictionary({ input: 'input.txt', dictionarySource: source, autoUpdate: {} });
  await assert.rejects(project.build([automatic('input.txt')]), /cannot overwrite an input/);
  await assert.rejects(project.build([
    automatic('cache/shared.txt'),
    compressionDictionary({ input: 'other.txt', dictionarySource: 'cache/shared.txt' }),
  ]), /cannot overwrite an input or a fixed dictionarySource/);
  await assert.rejects(project.build([
    automatic('cache/shared.txt'),
    compressionDictionary({ input: 'other.txt', dictionarySource: 'cache/shared.txt', autoUpdate: {} }),
  ]), /distinct dictionarySource/);
  await assert.rejects(project.build([automatic('build/cache.txt')]), /outside build\.outDir/);
});

test('vite: missing selectors, unreadable inputs and automatic multi-asset selection fail without state changes', async (t) => {
  const project = fixture(t);
  await assert.rejects(project.build([compressionDictionary({ test: 'missing.css' })]), /no emitted assets match/);
  await assert.rejects(project.build([compressionDictionary({ input: 'missing.css' })]), /cannot read input/);
  await assert.rejects(project.build([
    emitAssets({ 'a.css': 'a {}', 'b.css': 'b {}' }),
    compressionDictionary({ test: /\.css$/, dictionarySource: 'cache/styles.css', autoUpdate: {} }),
  ]), /exactly one asset/);
  assert.equal(fs.existsSync(path.join(project.directory, 'cache/styles.css')), false);
});

test('vite: unsupported multiple outputs and automatic watch builds reject before writing', async (t) => {
  const project = fixture(t, { 'input.txt': 'resource bytes' });
  await assert.rejects(project.build([compressionDictionary({ input: 'input.txt' })], {
    build: { rolldownOptions: { output: [{ format: 'es' }, { format: 'cjs' }] } },
  }), /exactly one output/);
  await assert.rejects(project.build([compressionDictionary({ input: 'input.txt', dictionarySource: 'cache/styles.txt', autoUpdate: {} })], {
    build: { watch: {} },
  }), /build\.watch is not supported with autoUpdate/);
  assert.equal(fs.existsSync(path.join(project.directory, 'cache/styles.txt')), false);
});

test('vite: automatic state rejects promised post write hooks in output.plugins before writing', async (t) => {
  const project = fixture(t, { 'input.txt': 'resource bytes' });
  await assert.rejects(project.build([
    compressionDictionary({ input: 'input.txt', dictionarySource: 'cache/styles.txt', autoUpdate: {} }),
  ], { build: { rolldownOptions: { output: {
    plugins: Promise.resolve([[{ name: 'output-post-hook', writeBundle: { order: 'post', handler() {} } }]]),
  } } } }), /autoUpdate does not support post writeBundle hooks in output\.plugins/);
  assert.equal(fs.existsSync(path.join(project.directory, 'cache/styles.txt')), false);
});
