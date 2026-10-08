const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const webpack = require('webpack');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin');
const brotli = require('brotli-wasm-custom-dictionary');
const CompressionDictionaryPlugin = require('../webpack/production/CompressionDictionaryPlugin.cjs');
const MANIFEST_NAME = 'dist/compression-dictionary-manifest.json';

function fixture(t, files = {}) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'production-dictionary-test-'));
  const outputPath = path.join(directory, 'build');
  const write = (name, bytes) => {
    const filename = path.join(directory, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes);
  };
  write('entry.js', '');
  for (const [name, bytes] of Object.entries(files)) write(name, bytes);
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
    assert.ok(path.basename(directory).startsWith('production-dictionary-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    write,
    async build(plugins, overrides = {}) {
      const compiler = webpack({
        mode: 'production',
        context: directory,
        entry: './entry.js',
        output: { path: outputPath, filename: 'main.js', clean: true },
        devtool: false,
        cache: false,
        optimization: { minimize: false },
        plugins,
        ...overrides,
      });
      let stats;
      try {
        stats = await new Promise((resolve, reject) => {
          compiler.run((error, result) => error ? reject(error) : resolve(result));
        });
        if (stats.hasErrors()) {
          const messages = stats.toJson({ all: false, errors: true }).errors.map(({ message }) => message);
          throw new Error(messages.join('\n'));
        }
        return {
          assets: new Map(stats.compilation.getAssets().map(({ name }) => [
            name, fs.readFileSync(path.join(outputPath, name)),
          ])),
          fileDependencies: new Set(stats.compilation.fileDependencies),
        };
      } finally {
        await new Promise((resolve, reject) => compiler.close((error) => error ? reject(error) : resolve()));
      }
    },
  };
}

class EmitAssetsPlugin {
  constructor(assets) {
    this.assets = assets;
  }

  apply(compiler) {
    compiler.hooks.thisCompilation.tap('EmitTestAssets', (compilation) => {
      compilation.hooks.processAssets.tap({
        name: 'EmitTestAssets',
        stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
      }, () => {
        for (const [name, bytes] of Object.entries(this.assets)) {
          compilation.emitAsset(name, new compiler.webpack.sources.RawSource(bytes));
        }
      });
    });
  }
}

function dictionaryAssets(assets) {
  return [...assets.keys()].filter((name) => name.endsWith('.dat'));
}

function assertManifest(assets) {
  const bytes = assets.get(MANIFEST_NAME);
  assert.ok(bytes, 'Missing production dictionary manifest');
  const manifest = JSON.parse(bytes.toString('utf8'));
  const dictionaryNames = dictionaryAssets(assets).sort();
  assert.deepEqual(Object.keys(manifest), ['dictionaries']);
  assert.deepEqual(Object.keys(manifest.dictionaries), dictionaryNames, 'Manifest entries must be complete and sorted');
  for (const name of dictionaryNames) {
    const sha256Base64 = createHash('sha256').update(assets.get(name)).digest('base64');
    assert.deepEqual(manifest.dictionaries[name], {
      sha256Base64,
      availableDictionary: `:${sha256Base64}:`,
    });
  }
  return manifest;
}

function assertDcb(assets, assetName, dictionaryName, expected = assets.get(assetName)) {
  const manifest = assertManifest(assets);
  const dictionary = assets.get(dictionaryName);
  const dcb = assets.get(`${assetName}.dcb`);
  assert.ok(dictionary, `Missing dictionary ${dictionaryName}`);
  assert.ok(dcb, `Missing DCB for ${assetName}`);
  assert.deepEqual(dcb.subarray(0, 4), Buffer.from([0xff, 0x44, 0x43, 0x42]));
  assert.deepEqual(dcb.subarray(4, 36), createHash('sha256').update(dictionary).digest());
  assert.equal(dcb.subarray(4, 36).toString('base64'), manifest.dictionaries[dictionaryName].sha256Base64);
  assert.deepEqual(
    Buffer.from(brotli.decompress(dcb.subarray(36), { customDictionary: dictionary })),
    expected,
    'Decoding must restore the exact emitted asset bytes',
  );
}

function cssBuild(project, dictionaryPlugins = []) {
  return project.build([
    new MiniCssExtractPlugin({ filename: 'dist/styles.[contenthash:16].css' }),
    ...dictionaryPlugins,
  ], {
    module: {
      rules: [{ test: /\.css$/, use: [MiniCssExtractPlugin.loader, require.resolve('css-loader')] }],
    },
    optimization: {
      minimize: true,
      minimizer: [new CssMinimizerPlugin({ parallel: false })],
    },
  });
}

test('production: emits dictionary, DCB and manifest additions for the final minified, hashed CSS', async (t) => {
  const project = fixture(t, {
    'entry.js': 'import "./styles.css";',
    'styles.css': '/* source formatting */\n.card { color: #ffffff; margin: 0px 0px 0px 0px; }\n',
  });
  const baseline = await cssBuild(project);
  const result = await cssBuild(project, [new CompressionDictionaryPlugin({ test: /\.css$/ })]);
  const cssName = [...baseline.assets.keys()].find((name) => name.endsWith('.css'));
  assert.match(cssName, /^dist\/styles\.[a-f0-9]{16}\.css$/);
  assert.ok(!result.assets.get(cssName).toString().includes('source formatting'));
  const hash = createHash('sha256').update(result.assets.get(cssName)).digest('hex');
  const dictionaryName = `dictionaries/${hash}.dat`;
  const additions = [...result.assets.keys()].filter((name) => !baseline.assets.has(name)).sort();
  assert.deepEqual(additions, [dictionaryName, `${cssName}.dcb`, MANIFEST_NAME].sort());
  for (const [name, bytes] of baseline.assets) assert.deepEqual(result.assets.get(name), bytes);
  assert.deepEqual(result.assets.get(dictionaryName), result.assets.get(cssName));
  assertDcb(result.assets, cssName, dictionaryName);
});

test('production: separate instances support distinct paths, binary bytes and exact string selectors', async (t) => {
  const project = fixture(t);
  const first = Buffer.from('body { color: purple; }\n'.repeat(30));
  const second = Buffer.from(Array.from({ length: 2048 }, (_, i) => i % 256));
  const result = await project.build([
    new EmitAssetsPlugin({ 'first/shared.css': first, 'second/shared.css': second, 'untouched.css': 'leave this alone' }),
    new CompressionDictionaryPlugin({ test: 'first/shared.css' }),
    new CompressionDictionaryPlugin({ test: 'second/shared.css' }),
  ]);
  assert.equal(dictionaryAssets(result.assets).length, 2);
  for (const name of ['first/shared.css', 'second/shared.css']) {
    const hash = createHash('sha256').update(result.assets.get(name)).digest('hex');
    assertDcb(result.assets, name, `dictionaries/${hash}.dat`);
  }
  assert.ok(!result.assets.has('untouched.css.dcb'));
  assert.equal(result.assets.get('untouched.css').toString(), 'leave this alone');
});

test('production: a frozen source is used byte-for-byte and reused after the CSS changes', async (t) => {
  const snapshot = Buffer.from('/* preserve this snapshot exactly */\r\n.card { color: purple; padding: 10px; }\r\n');
  const project = fixture(t, {
    'entry.js': 'import "./styles.css";',
    'styles.css': '.card { color: purple; padding: 12px; }',
    'snapshots/styles.v1.css': snapshot,
  });
  const plugin = new CompressionDictionaryPlugin({
    test: /\.css$/,
    dictionarySource: 'snapshots/styles.v1.css',
    dictionaryFilename: 'snapshots/style.[hash].dat',
  });
  const first = await cssBuild(project, [plugin]);
  project.write('styles.css', '.card { color: orange; padding: 18px; }');
  const second = await cssBuild(project, [plugin]);
  const dictionaryName = `snapshots/style.${createHash('sha256').update(snapshot).digest('hex')}.dat`;
  const firstCss = [...first.assets.keys()].find((name) => name.endsWith('.css'));
  const secondCss = [...second.assets.keys()].find((name) => name.endsWith('.css'));
  assert.notEqual(firstCss, secondCss);
  assert.notDeepEqual(first.assets.get(firstCss), second.assets.get(secondCss));
  for (const result of [first, second]) {
    assert.deepEqual(dictionaryAssets(result.assets), [dictionaryName]);
    assert.deepEqual(result.assets.get(dictionaryName), snapshot);
    assert.ok(result.fileDependencies.has(path.join(project.directory, 'snapshots/styles.v1.css')));
  }
  assertDcb(first.assets, firstCss, dictionaryName);
  assertDcb(second.assets, secondCss, dictionaryName);
});

test('production: identical dictionaries can be shared and stateful regex selectors match every asset', async (t) => {
  const project = fixture(t);
  const bytes = Buffer.from('.shared { display: grid; }'.repeat(30));
  const pattern = /\.css$/g;
  pattern.lastIndex = 100;
  const result = await project.build([
    new EmitAssetsPlugin({ 'a.css': bytes, 'b.css': bytes, 'c.js': bytes }),
    new CompressionDictionaryPlugin({ test: pattern }),
    new CompressionDictionaryPlugin({ test: 'c.js', quality: 0 }),
  ]);
  const names = dictionaryAssets(result.assets);
  assert.equal(names.length, 1);
  for (const name of ['a.css', 'b.css', 'c.js']) assertDcb(result.assets, name, names[0]);
});

test('production: later instances ignore generated dictionaries and compressed sidecars', async (t) => {
  const project = fixture(t);
  const result = await project.build([
    new EmitAssetsPlugin({ 'a.css': '.a { color: red; }', 'b.css': '.b { color: blue; }' }),
    new CompressionDictionaryPlugin({ test: 'a.css' }),
    new CompressionDictionaryPlugin({ test: /^(?:b\.css|dictionaries\/.*\.dat|.*\.dcb)$/ }),
  ]);
  assert.equal(dictionaryAssets(result.assets).length, 2);
  assert.deepEqual([...result.assets.keys()].filter((name) => name.endsWith('.dcb')).sort(), [
    'a.css.dcb', 'b.css.dcb',
  ]);
  for (const name of ['a.css', 'b.css']) {
    const hash = createHash('sha256').update(result.assets.get(name)).digest('hex');
    assertDcb(result.assets, name, `dictionaries/${hash}.dat`);
  }
});

test('production: overlapping instances and conflicting output names fail the build', async (t) => {
  await t.test('two instances cannot emit the same DCB', async (t) => {
    const project = fixture(t);
    await assert.rejects(project.build([
      new EmitAssetsPlugin({ 'a.css': '.card { color: red; }' }),
      new CompressionDictionaryPlugin({ test: 'a.css' }),
      new CompressionDictionaryPlugin({ test: 'a.css' }),
    ]));
  });
  await t.test('distinct dictionary bytes cannot share a filename', async (t) => {
    const project = fixture(t);
    await assert.rejects(project.build([
      new EmitAssetsPlugin({ 'a.css': '.a { color: red; }', 'b.css': '.b { color: blue; }' }),
      new CompressionDictionaryPlugin({ test: 'a.css', dictionaryFilename: 'shared.dat' }),
      new CompressionDictionaryPlugin({ test: 'b.css', dictionaryFilename: 'shared.dat' }),
    ]));
  });
  await t.test('an existing DCB asset is never overwritten', async (t) => {
    const project = fixture(t);
    await assert.rejects(project.build([
      new EmitAssetsPlugin({ 'a.css': '.a { color: red; }', 'a.css.dcb': 'already generated' }),
      new CompressionDictionaryPlugin({ test: 'a.css' }),
    ]));
  });
});

test('production: missing inputs and unusable dictionary sizes fail the build', async (t) => {
  await t.test('selector must match an emitted asset', async (t) => {
    const project = fixture(t);
    await assert.rejects(project.build([new CompressionDictionaryPlugin({ test: 'missing.css' })]));
  });
  await t.test('external dictionary file must exist', async (t) => {
    const project = fixture(t);
    await assert.rejects(project.build([
      new EmitAssetsPlugin({ 'a.css': '.a { color: red; }' }),
      new CompressionDictionaryPlugin({ test: 'a.css', dictionarySource: 'missing.dat' }),
    ]));
  });
  await t.test('empty source cannot be used as a dictionary', async (t) => {
    const project = fixture(t);
    await assert.rejects(project.build([
      new EmitAssetsPlugin({ 'empty.css': '' }),
      new CompressionDictionaryPlugin({ test: 'empty.css' }),
    ]));
  });
  await t.test('external dictionary must fit the encoder window', async (t) => {
    const project = fixture(t, { 'too-large.dat': Buffer.alloc(2 ** 22 - 15, 97) });
    await assert.rejects(project.build([
      new EmitAssetsPlugin({ 'a.css': '.a { color: red; }' }),
      new CompressionDictionaryPlugin({ test: 'a.css', dictionarySource: 'too-large.dat' }),
    ]));
  });
});

test('production: validates the asset selector and compression quality', () => {
  for (const options of [{}, { test: '' }, { test: [] }, { test: () => true }]) {
    assert.throws(() => new CompressionDictionaryPlugin(options));
  }
  for (const quality of [-1, 12, 1.5, '11', NaN]) {
    assert.throws(() => new CompressionDictionaryPlugin({ test: 'a.css', quality }));
  }
});

test('production: rejects dictionary filenames outside the output directory or with unsupported placeholders', () => {
  for (const dictionaryFilename of ['', '../outside.dat', '/absolute.dat', 'C:/absolute.dat',
    'nested/../outside.dat', 'nested\\dictionary.dat', 'dictionary.[name].dat']) {
    assert.throws(() => new CompressionDictionaryPlugin({ test: 'a.css', dictionaryFilename }));
  }
});

test('production: a ready CSS file produces its dictionary, DCB and manifest without resolving CSS imports or URLs', async (t) => {
  const original = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('@import "./missing.css";\r\n@font-face { font-family: example; src: url(./missing.woff2); }\r\n'),
  ]);
  const project = fixture(t, { 'ready/styles.ready.css': original });
  const result = await project.build([
    new CompressionDictionaryPlugin({ input: 'ready/styles.ready.css' }),
  ], { entry: {} });
  const dictionaryName = `dictionaries/${createHash('sha256').update(original).digest('hex')}.dat`;
  assert.deepEqual([...result.assets.keys()].sort(), [dictionaryName, 'styles.ready.css.dcb', MANIFEST_NAME].sort());
  assert.deepEqual(result.assets.get(dictionaryName), original);
  assertDcb(result.assets, 'styles.ready.css', dictionaryName, original);
  const inputPath = path.join(project.directory, 'ready/styles.ready.css');
  assert.ok(result.fileDependencies.has(inputPath));
  assert.deepEqual(fs.readFileSync(inputPath), original);
});

test('production: direct inputs support a custom DCB path and reload the input and frozen dictionary between builds', async (t) => {
  const firstInput = Buffer.from('.card { color: blue; background: url(./missing.png); }\r\n');
  const secondInput = Buffer.from('.card { color: purple; background: url(./missing.png); }\r\n');
  const firstSnapshot = Buffer.from('/* keep snapshot bytes */\r\n.card { color: blue; }\r\n');
  const secondSnapshot = Buffer.from('/* snapshot version 2 */\n.card { color: purple; }\n');
  const project = fixture(t, { 'ready/app.css': firstInput, 'snapshots/previous.css': firstSnapshot });
  const inputPath = path.join(project.directory, 'ready/app.css');
  const snapshotPath = path.join(project.directory, 'snapshots/previous.css');
  const plugin = new CompressionDictionaryPlugin({
    input: inputPath,
    dcbFilename: 'dist/css/app.css.dcb',
    dictionarySource: 'snapshots/previous.css',
    dictionaryFilename: 'dictionaries/frozen.[hash].dat',
  });
  const first = await project.build([plugin], { entry: {} });
  project.write('ready/app.css', secondInput);
  const second = await project.build([plugin], { entry: {} });
  project.write('snapshots/previous.css', secondSnapshot);
  const third = await project.build([plugin], { entry: {} });
  const firstDictionary = `dictionaries/frozen.${createHash('sha256').update(firstSnapshot).digest('hex')}.dat`;
  const secondDictionary = `dictionaries/frozen.${createHash('sha256').update(secondSnapshot).digest('hex')}.dat`;
  assert.notDeepEqual(first.assets.get('dist/css/app.css.dcb'), second.assets.get('dist/css/app.css.dcb'));
  for (const [result, dictionaryName, snapshot, input] of [
    [first, firstDictionary, firstSnapshot, firstInput],
    [second, firstDictionary, firstSnapshot, secondInput],
    [third, secondDictionary, secondSnapshot, secondInput],
  ]) {
    assert.deepEqual([...result.assets.keys()].sort(), [dictionaryName, 'dist/css/app.css.dcb', MANIFEST_NAME].sort());
    assert.deepEqual(result.assets.get(dictionaryName), snapshot);
    assertDcb(result.assets, 'dist/css/app.css', dictionaryName, input);
    assert.ok(result.fileDependencies.has(inputPath));
    assert.ok(result.fileDependencies.has(snapshotPath));
  }
  assert.deepEqual(fs.readFileSync(inputPath), secondInput);
  assert.deepEqual(fs.readFileSync(snapshotPath), secondSnapshot);
});

test('production: direct-file instances require distinct DCB paths when inputs share a basename', async (t) => {
  const first = Buffer.from('.first { color: red; }');
  const second = Buffer.from('.second { color: blue; }');
  const project = fixture(t, { 'first/app.css': first, 'second/app.css': second });
  await assert.rejects(project.build([
    new CompressionDictionaryPlugin({ input: 'first/app.css' }),
    new CompressionDictionaryPlugin({ input: 'second/app.css' }),
  ], { entry: {} }));
  const result = await project.build([
    new CompressionDictionaryPlugin({ input: 'first/app.css', dcbFilename: 'first/app.css.dcb' }),
    new CompressionDictionaryPlugin({ input: 'second/app.css', dcbFilename: 'second/app.css.dcb' }),
  ], { entry: {} });
  assert.equal(result.assets.size, 5);
  for (const [name, bytes] of [['first/app.css', first], ['second/app.css', second]]) {
    const dictionaryName = `dictionaries/${createHash('sha256').update(bytes).digest('hex')}.dat`;
    assertDcb(result.assets, name, dictionaryName, bytes);
  }
});

test('production: direct-file mode rejects missing input and output paths that overwrite source files', async (t) => {
  await t.test('input file must exist', async (t) => {
    const project = fixture(t);
    await assert.rejects(project.build([
      new CompressionDictionaryPlugin({ input: 'missing.css' }),
    ], { entry: {} }));
  });
  await t.test('DCB cannot overwrite its original file', async (t) => {
    const original = Buffer.from('.card { color: green; }');
    const project = fixture(t, { 'build/app.css': original });
    await assert.rejects(project.build([
      new CompressionDictionaryPlugin({ input: 'build/app.css', dcbFilename: 'app.css' }),
    ], { entry: {} }));
    assert.deepEqual(fs.readFileSync(path.join(project.directory, 'build/app.css')), original);
  });
  await t.test('Windows source protection ignores filename casing', { skip: process.platform !== 'win32' }, async (t) => {
    const original = Buffer.from('.card { color: purple; }');
    const project = fixture(t, { 'build/app.css': original });
    await assert.rejects(project.build([
      new CompressionDictionaryPlugin({ input: 'build/app.css', dcbFilename: 'APP.CSS' }),
    ], { entry: {} }));
    assert.deepEqual(fs.readFileSync(path.join(project.directory, 'build/app.css')), original);
  });
  await t.test('dictionary output cannot overwrite the frozen snapshot', async (t) => {
    const snapshot = Buffer.from('.previous { color: green; }');
    const project = fixture(t, { 'ready/app.css': '.card { color: red; }', 'build/snapshot.dat': snapshot });
    await assert.rejects(project.build([
      new CompressionDictionaryPlugin({
        input: 'ready/app.css',
        dictionarySource: 'build/snapshot.dat',
        dictionaryFilename: 'snapshot.dat',
      }),
    ], { entry: {} }));
    assert.deepEqual(fs.readFileSync(path.join(project.directory, 'build/snapshot.dat')), snapshot);
  });
});

test('production: input and test are mutually exclusive and DCB filenames belong to direct-file mode', () => {
  for (const options of [
    { input: '' },
    { input: 123 },
    { input: 'ready.css', test: /\.css$/ },
    { dictionarySource: 'snapshot.css' },
    { test: 'a.css', dcbFilename: 'a.css.dcb' },
    { input: 'ready.css', dcbFilename: '../outside.dcb' },
    { input: 'ready.css', dcbFilename: '/absolute.dcb' },
  ]) {
    assert.throws(() => new CompressionDictionaryPlugin(options));
  }
});

test('production: one sorted manifest aggregates mixed instances, deduplicates shared dictionaries and resets on rebuild', async (t) => {
  const shared = Buffer.from('.shared { display: grid; }');
  const current = Buffer.from('.current { color: blue; }');
  const oldSnapshot = Buffer.from('.snapshot { color: red; }');
  const newSnapshot = Buffer.from('.snapshot { color: green; }');
  const project = fixture(t, {
    'ready/current.css': current,
    'ready/shared.css': shared,
    'snapshots/previous.css': oldSnapshot,
  });
  const outputPath = path.join(project.directory, 'build');
  const compiler = webpack({
    mode: 'production',
    context: project.directory,
    entry: {},
    output: { path: outputPath, clean: true },
    cache: false,
    devtool: false,
    optimization: { minimize: false },
    plugins: [
      new EmitAssetsPlugin({ 'generated.css': shared }),
      new CompressionDictionaryPlugin({ test: 'generated.css', dictionaryFilename: 'dictionaries/z-shared.dat' }),
      new CompressionDictionaryPlugin({
        input: 'ready/current.css',
        dictionarySource: 'snapshots/previous.css',
        dictionaryFilename: 'dictionaries/a-frozen.[hash].dat',
      }),
      new CompressionDictionaryPlugin({ input: 'ready/shared.css', dictionaryFilename: 'dictionaries/z-shared.dat' }),
    ],
  });
  const build = async () => {
    const stats = await new Promise((resolve, reject) => {
      compiler.run((error, result) => error ? reject(error) : resolve(result));
    });
    assert.equal(stats.hasErrors(), false, stats.toString({ all: false, errors: true }));
    return new Map(stats.compilation.getAssets().map(({ name }) => [
      name, fs.readFileSync(path.join(outputPath, name)),
    ]));
  };
  try {
    const first = await build();
    project.write('snapshots/previous.css', newSnapshot);
    const second = await build();
    const firstName = `dictionaries/a-frozen.${createHash('sha256').update(oldSnapshot).digest('hex')}.dat`;
    const secondName = `dictionaries/a-frozen.${createHash('sha256').update(newSnapshot).digest('hex')}.dat`;
    for (const [assets, frozenName] of [[first, firstName], [second, secondName]]) {
      const manifest = assertManifest(assets);
      assert.deepEqual(Object.keys(manifest.dictionaries), [frozenName, 'dictionaries/z-shared.dat']);
      assert.equal([...assets.keys()].filter((name) => name.endsWith('.json')).length, 1);
      assertDcb(assets, 'generated.css', 'dictionaries/z-shared.dat');
      assertDcb(assets, 'shared.css', 'dictionaries/z-shared.dat', shared);
      assertDcb(assets, 'current.css', frozenName, current);
    }
    assert.ok(!second.has(firstName), 'The old snapshot must not remain in a later compilation');
    assert.ok(!Object.hasOwn(assertManifest(second).dictionaries, firstName));
  } finally {
    await new Promise((resolve, reject) => compiler.close((error) => error ? reject(error) : resolve()));
  }
});

test('production: manifest path collisions fail instead of overwriting other outputs', async (t) => {
  await t.test('an existing asset owns the manifest filename', async (t) => {
    const project = fixture(t);
    await assert.rejects(project.build([
      new EmitAssetsPlugin({ 'app.css': '.card { color: red; }', [MANIFEST_NAME]: '{"existing":true}' }),
      new CompressionDictionaryPlugin({ test: 'app.css' }),
    ]));
  });
  await t.test('a dictionary cannot use the manifest filename', async (t) => {
    const project = fixture(t);
    await assert.rejects(project.build([
      new EmitAssetsPlugin({ 'app.css': '.card { color: red; }' }),
      new CompressionDictionaryPlugin({ test: 'app.css', dictionaryFilename: MANIFEST_NAME }),
    ]));
  });
  await t.test('a DCB cannot use the manifest filename', async (t) => {
    const project = fixture(t, { 'ready/app.css': '.card { color: red; }' });
    await assert.rejects(project.build([
      new CompressionDictionaryPlugin({ input: 'ready/app.css', dcbFilename: MANIFEST_NAME }),
    ], { entry: {} }));
  });
  await t.test('manifest filename reservations ignore casing on Windows', { skip: process.platform !== 'win32' }, async (t) => {
    const project = fixture(t, { 'ready/app.css': '.card { color: red; }' });
    await assert.rejects(project.build([
      new CompressionDictionaryPlugin({ input: 'ready/app.css', dcbFilename: MANIFEST_NAME.toUpperCase() }),
    ], { entry: {} }));
  });
});

test('production: the aggregated manifest cannot overwrite any instance input or frozen snapshot', async (t) => {
  await t.test('a later direct-file instance uses the manifest path as input', async (t) => {
    const original = Buffer.from('original input file bytes');
    const inputPath = `build/${MANIFEST_NAME}`;
    const project = fixture(t, { 'ready/app.css': '.card { color: red; }', [inputPath]: original });
    await assert.rejects(project.build([
      new CompressionDictionaryPlugin({ input: 'ready/app.css' }),
      new CompressionDictionaryPlugin({ input: inputPath, dcbFilename: 'original.dcb' }),
    ], { entry: {} }));
    assert.deepEqual(fs.readFileSync(path.join(project.directory, inputPath)), original);
  });
  await t.test('a later asset-mode instance uses the manifest path as dictionarySource', async (t) => {
    const snapshot = Buffer.from('original snapshot file bytes');
    const snapshotPath = `build/${MANIFEST_NAME}`;
    const project = fixture(t, { 'ready/app.css': '.card { color: red; }', [snapshotPath]: snapshot });
    await assert.rejects(project.build([
      new EmitAssetsPlugin({ 'generated.css': '.generated { color: blue; }' }),
      new CompressionDictionaryPlugin({ input: 'ready/app.css' }),
      new CompressionDictionaryPlugin({ test: 'generated.css', dictionarySource: snapshotPath }),
    ], { entry: {} }));
    assert.deepEqual(fs.readFileSync(path.join(project.directory, snapshotPath)), snapshot);
  });
  await t.test('manifest source protection ignores casing on Windows', { skip: process.platform !== 'win32' }, async (t) => {
    const snapshot = Buffer.from('original snapshot with uppercase path');
    const snapshotPath = `build/${MANIFEST_NAME.toUpperCase()}`;
    const project = fixture(t, { 'ready/app.css': '.card { color: red; }', [snapshotPath]: snapshot });
    await assert.rejects(project.build([
      new CompressionDictionaryPlugin({ input: 'ready/app.css', dictionarySource: snapshotPath }),
    ], { entry: {} }));
    assert.deepEqual(fs.readFileSync(path.join(project.directory, snapshotPath)), snapshot);
  });
});
