const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const webpack = require('webpack');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin');
const brotli = require('brotli-wasm-custom-dictionary');
const CompressionDictionaryPlugin = require('use-as-dictionary/webpack');
const MANIFEST_NAME = 'dictionaries/compression-dictionary-manifest.json';

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

test('webpack: CommonJS and ESM expose the same class and require new', async () => {
  assert.equal((await import('use-as-dictionary/webpack')).default, CompressionDictionaryPlugin);
  assert.throws(() => CompressionDictionaryPlugin({ test: /\.css$/ }), TypeError);
  const plugin = new CompressionDictionaryPlugin({ test: /\.css$/ });
  assert.ok(plugin instanceof CompressionDictionaryPlugin);
  assert.equal(typeof plugin.apply, 'function');
});

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
  });
  const first = await cssBuild(project, [plugin]);
  project.write('styles.css', '.card { color: orange; padding: 18px; }');
  const second = await cssBuild(project, [plugin]);
  const dictionaryName = `dictionaries/styles.v1.${createHash('sha256').update(snapshot).digest('hex')}.dat`;
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

test('production: source stems name dictionaries, sharing identical bytes and separating different hashes', async (t) => {
  const shared = Buffer.from('.shared { color: red; }');
  const different = Buffer.from('.different { color: blue; }');
  const sources = ['one/shared-styles.css', 'two/shared-styles.dat', 'three/shared-styles.dat'];
  const project = fixture(t, { [sources[0]]: shared, [sources[1]]: shared, [sources[2]]: different });
  const content = Buffer.from('.current { display: grid; }');
  const result = await project.build([
    new EmitAssetsPlugin({ 'first.css': content, 'second.css': content, 'third.css': content }),
    ...['first.css', 'second.css', 'third.css'].map((name, index) => new CompressionDictionaryPlugin({
      test: name,
      dictionarySource: index === 1 ? path.join(project.directory, sources[index]) : sources[index],
    })),
  ]);
  const sharedName = `dictionaries/shared-styles.${createHash('sha256').update(shared).digest('hex')}.dat`;
  const differentName = `dictionaries/shared-styles.${createHash('sha256').update(different).digest('hex')}.dat`;
  assert.deepEqual(dictionaryAssets(result.assets).sort(), [sharedName, differentName].sort());
  assert.deepEqual(result.assets.get(sharedName), shared);
  assert.deepEqual(result.assets.get(differentName), different);
  assertDcb(result.assets, 'first.css', sharedName);
  assertDcb(result.assets, 'second.css', sharedName);
  assertDcb(result.assets, 'third.css', differentName);
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
  await t.test('an existing asset cannot be overwritten by a generated dictionary', async (t) => {
    const project = fixture(t);
    const content = Buffer.from('.a { color: red; }');
    const dictionaryName = `dictionaries/${createHash('sha256').update(content).digest('hex')}.dat`;
    await assert.rejects(project.build([
      new EmitAssetsPlugin({ 'a.css': content, [dictionaryName]: 'already owned by another plugin' }),
      new CompressionDictionaryPlugin({ test: 'a.css' }),
    ]), /output collision/);
  });
  await t.test('a custom DCB path cannot collide with its generated dictionary', async (t) => {
    const snapshot = Buffer.from('.snapshot { color: blue; }');
    const project = fixture(t, { 'ready/app.css': '.card { color: red; }', 'snapshots/styles.dat': snapshot });
    const dictionaryName = `dictionaries/styles.${createHash('sha256').update(snapshot).digest('hex')}.dat`;
    await assert.rejects(project.build([
      new CompressionDictionaryPlugin({
        input: 'ready/app.css', dictionarySource: 'snapshots/styles.dat', dcbFilename: dictionaryName,
      }),
    ], { entry: {} }), /output collision/);
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

test('production: removed dictionaryFilename options explain how to migrate to dictionarySource', () => {
  for (const dictionaryFilename of ['dictionaries/[hash].dat', 'fixed.dat', '../outside.dat', '']) {
    assert.throws(
      () => new CompressionDictionaryPlugin({ test: 'a.css', dictionaryFilename }),
      /dictionaryFilename has been removed.*dictionarySource/,
    );
    assert.throws(
      () => automaticPlugin({ dictionaryFilename }),
      /dictionaryFilename has been removed.*dictionarySource/,
    );
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
    dictionarySource: snapshotPath,
  });
  const first = await project.build([plugin], { entry: {} });
  project.write('ready/app.css', secondInput);
  const second = await project.build([plugin], { entry: {} });
  project.write('snapshots/previous.css', secondSnapshot);
  const third = await project.build([plugin], { entry: {} });
  const firstDictionary = `dictionaries/previous.${createHash('sha256').update(firstSnapshot).digest('hex')}.dat`;
  const secondDictionary = `dictionaries/previous.${createHash('sha256').update(secondSnapshot).digest('hex')}.dat`;
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
  await t.test('a custom DCB path cannot overwrite the frozen snapshot', async (t) => {
    const snapshot = Buffer.from('.previous { color: green; }');
    const project = fixture(t, { 'ready/app.css': '.card { color: red; }', 'build/snapshot.dat': snapshot });
    await assert.rejects(project.build([
      new CompressionDictionaryPlugin({
        input: 'ready/app.css',
        dictionarySource: 'build/snapshot.dat',
        dcbFilename: 'snapshot.dat',
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
    'snapshots/a-frozen.css': oldSnapshot,
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
      new CompressionDictionaryPlugin({ test: 'generated.css' }),
      new CompressionDictionaryPlugin({
        input: 'ready/current.css',
        dictionarySource: 'snapshots/a-frozen.css',
      }),
      new CompressionDictionaryPlugin({ input: 'ready/shared.css' }),
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
    project.write('snapshots/a-frozen.css', newSnapshot);
    const second = await build();
    const firstName = `dictionaries/a-frozen.${createHash('sha256').update(oldSnapshot).digest('hex')}.dat`;
    const secondName = `dictionaries/a-frozen.${createHash('sha256').update(newSnapshot).digest('hex')}.dat`;
    const sharedName = `dictionaries/${createHash('sha256').update(shared).digest('hex')}.dat`;
    for (const [assets, frozenName] of [[first, firstName], [second, secondName]]) {
      const manifest = assertManifest(assets);
      assert.deepEqual(Object.keys(manifest.dictionaries), [frozenName, sharedName].sort());
      assert.equal([...assets.keys()].filter((name) => name.endsWith('.json')).length, 1);
      assertDcb(assets, 'generated.css', sharedName);
      assertDcb(assets, 'shared.css', sharedName, shared);
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

function sampleBytes(seed, length = 8192) {
  let state = seed;
  return Buffer.from(Array.from({ length }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 24;
  }));
}

function automaticPlugin(options = {}) {
  return new CompressionDictionaryPlugin({
    input: 'ready/app.css',
    dictionarySource: '.dictionary-cache/styles.dat',
    autoUpdate: {},
    ...options,
  });
}

test('production: automatic dictionaries survive clean output and a fresh build process', async (t) => {
  const original = sampleBytes(1);
  const project = fixture(t, { 'ready/app.css': original });
  const first = await project.build([automaticPlugin()], { entry: {} });
  const cachePath = path.join(project.directory, '.dictionary-cache/styles.dat');
  const dictionaryName = dictionaryAssets(first.assets)[0];
  assert.equal(dictionaryName, `dictionaries/styles.${createHash('sha256').update(original).digest('hex')}.dat`);
  assert.deepEqual(fs.readFileSync(cachePath), original);
  assert.equal(first.fileDependencies.has(cachePath), false, 'Automatic dictionaries must not trigger watch rebuilds');
  assertDcb(first.assets, 'app.css', dictionaryName, original);

  // The next process must reuse the disk snapshot even though the input changed.
  const changed = Buffer.from(original);
  changed[100] ^= 0xff;
  project.write('ready/app.css', changed);
  project.write('build/stale.txt', 'output.clean must remove this');
  fs.utimesSync(cachePath, 1, 1);
  const oldMtime = fs.statSync(cachePath).mtimeMs;
  const script = `
    const [directory, webpackPath, pluginPath] = process.argv.slice(1);
    const webpack = require(webpackPath);
    const Plugin = require(pluginPath);
    const compiler = webpack({
      mode: 'production', context: directory, entry: {}, cache: false,
      output: { path: require('node:path').join(directory, 'build'), clean: true },
      plugins: [new Plugin({
        input: 'ready/app.css',
        dictionarySource: '.dictionary-cache/styles.dat',
        autoUpdate: {},
      })],
    });
    compiler.run((error, stats) => compiler.close((closeError) => {
      if (error || closeError || stats.hasErrors()) {
        process.stderr.write(String(error || closeError || stats.toString({ all: false, errors: true })));
        process.exitCode = 1;
      }
    }));
  `;
  execFileSync(process.execPath, [
    '-e', script, project.directory, require.resolve('webpack'),
    require.resolve('use-as-dictionary/webpack'),
  ], { timeout: 30000, windowsHide: true });
  const outputPath = path.join(project.directory, 'build');
  const assets = new Map([dictionaryName, 'app.css.dcb', MANIFEST_NAME].map((name) => [
    name, fs.readFileSync(path.join(outputPath, name)),
  ]));
  assert.equal(fs.existsSync(path.join(outputPath, 'stale.txt')), false);
  assert.deepEqual(fs.readFileSync(cachePath), original);
  assert.equal(fs.statSync(cachePath).mtimeMs, oldMtime, 'Reusing a dictionary must not rewrite its cache');
  assertDcb(assets, 'app.css', dictionaryName, changed);
});

test('production: existing dictionarySource is reused above 90% and overwritten below it only with autoUpdate', async (t) => {
  const snapshot = sampleBytes(2);
  const similar = Buffer.from(snapshot);
  similar[100] ^= 0xff;
  const unrelated = sampleBytes(3);
  const project = fixture(t, { 'ready/app.css': similar, '.dictionary-cache/styles.dat': snapshot });
  const first = await project.build([automaticPlugin()], { entry: {} });
  const firstName = dictionaryAssets(first.assets)[0];
  const cachePath = path.join(project.directory, '.dictionary-cache/styles.dat');
  assert.equal(firstName, `dictionaries/styles.${createHash('sha256').update(snapshot).digest('hex')}.dat`);
  assert.deepEqual(first.assets.get(firstName), snapshot);
  assert.ok(1 - first.assets.get('app.css.dcb').length / similar.length >= 0.9);
  assert.deepEqual(fs.readFileSync(cachePath), snapshot);
  assertDcb(first.assets, 'app.css', firstName, similar);

  const outdatedDcbSize = 36 + brotli.compress(unrelated, { quality: 11, customDictionary: snapshot }).length;
  assert.ok(1 - outdatedDcbSize / unrelated.length < 0.9, 'Fixture must cross the default rotation threshold');
  project.write('ready/app.css', unrelated);
  const fixed = await project.build([automaticPlugin({ autoUpdate: undefined })], { entry: {} });
  assert.deepEqual(dictionaryAssets(fixed.assets), [firstName]);
  assert.deepEqual(fs.readFileSync(cachePath), snapshot, 'A fixed snapshot must never be overwritten');
  assert.ok(fixed.fileDependencies.has(cachePath), 'Fixed snapshots remain watched inputs');
  assertDcb(fixed.assets, 'app.css', firstName, unrelated);

  const rotated = await project.build([automaticPlugin()], { entry: {} });
  const rotatedName = dictionaryAssets(rotated.assets)[0];
  assert.equal(rotatedName, `dictionaries/styles.${createHash('sha256').update(unrelated).digest('hex')}.dat`);
  assert.notEqual(rotatedName, firstName);
  assert.deepEqual(rotated.assets.get(rotatedName), unrelated);
  assert.deepEqual(fs.readFileSync(cachePath), unrelated);
  assert.equal(rotated.fileDependencies.has(cachePath), false);
  assertDcb(rotated.assets, 'app.css', rotatedName, unrelated);

  const reused = await project.build([automaticPlugin()], { entry: {} });
  assert.deepEqual(dictionaryAssets(reused.assets), [rotatedName]);
  assertDcb(reused.assets, 'app.css', rotatedName, unrelated);
});

test('production: automatic threshold includes the 36-byte DCB header and reuses at equality', async (t) => {
  const seed = sampleBytes(4);
  const changed = Buffer.from(seed);
  changed[0] ^= 0xff;
  const compressedSize = brotli.compress(changed, { quality: 11, customDictionary: seed }).length;
  const exactSavings = 1 - (compressedSize + 36) / changed.length;
  const payloadOnlySavings = 1 - compressedSize / changed.length;
  const project = fixture(t, {
    'ready/app.css': changed, '.dictionary-cache/equal.dat': seed, '.dictionary-cache/header.dat': seed,
  });
  const buildAt = (minSavings, dictionarySource) => project.build([automaticPlugin({
    dictionarySource, autoUpdate: { minSavings },
  })], { entry: {} });
  const equal = await buildAt(exactSavings, '.dictionary-cache/equal.dat');
  const equalName = dictionaryAssets(equal.assets)[0];
  assert.deepEqual(equal.assets.get(equalName), seed, 'Savings equal to the threshold must reuse the seed');
  assertDcb(equal.assets, 'app.css', equalName, changed);
  const between = await buildAt((exactSavings + payloadOnlySavings) / 2, '.dictionary-cache/header.dat');
  const betweenName = dictionaryAssets(between.assets)[0];
  assert.deepEqual(between.assets.get(betweenName), changed, 'Counting the DCB header must trigger rotation');
  assertDcb(between.assets, 'app.css', betweenName, changed);
});

test('production: automatic dictionary cache remains stable when CSS contenthash changes', async (t) => {
  const rules = Array.from({ length: 150 }, (_, index) => `.card${index} { color: red; padding: ${index}px; }`).join('\n');
  const project = fixture(t, { 'entry.js': 'import "./styles.css";', 'styles.css': rules });
  const makePlugin = () => new CompressionDictionaryPlugin({
    test: /\.css$/, dictionarySource: '.dictionary-cache/styles.dat', autoUpdate: {},
  });
  const first = await cssBuild(project, [makePlugin()]);
  project.write('styles.css', rules.replace('color: red', 'color: blue'));
  const second = await cssBuild(project, [makePlugin()]);
  const firstCss = [...first.assets.keys()].find((name) => name.endsWith('.css'));
  const secondCss = [...second.assets.keys()].find((name) => name.endsWith('.css'));
  assert.notEqual(firstCss, secondCss);
  assert.deepEqual(dictionaryAssets(second.assets), dictionaryAssets(first.assets));
  assertDcb(second.assets, secondCss, dictionaryAssets(first.assets)[0]);
});

test('production: failed builds neither create nor rotate automatic dictionary caches', async (t) => {
  const original = sampleBytes(5);
  const replacement = sampleBytes(6);
  const failLate = {
    apply(compiler) {
      compiler.hooks.thisCompilation.tap('FailAfterDictionaryAssets', (compilation) => {
        compilation.hooks.processAssets.tap({
          name: 'FailAfterDictionaryAssets', stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_REPORT + 1,
        }, () => { compilation.errors.push(new Error('Deliberate late compilation failure')); });
      });
    },
  };
  const project = fixture(t, { 'ready/app.css': original });
  const cachePath = path.join(project.directory, '.dictionary-cache/styles.dat');
  await assert.rejects(project.build([automaticPlugin(), failLate], { entry: {} }), /Deliberate late compilation failure/);
  assert.equal(fs.existsSync(cachePath), false, 'A failed first build must not publish its cache');
  await project.build([automaticPlugin()], { entry: {} });
  project.write('ready/app.css', replacement);
  await assert.rejects(project.build([automaticPlugin(), failLate], { entry: {} }), /Deliberate late compilation failure/);
  assert.deepEqual(fs.readFileSync(cachePath), original, 'A failed rotation must retain the last successful dictionary');
});

test('production: independent instances persist and rotate their own automatic dictionaries', async (t) => {
  const first = sampleBytes(7);
  const second = sampleBytes(8);
  const replacement = sampleBytes(9);
  const project = fixture(t, { 'ready/first.css': first, 'ready/second.css': second });
  const makePlugins = () => ['first', 'second'].map((name) => new CompressionDictionaryPlugin({
    input: `ready/${name}.css`, dictionarySource: `.dictionary-cache/${name}.dat`, autoUpdate: {},
  }));
  await project.build(makePlugins(), { entry: {} });
  project.write('ready/first.css', replacement);
  const result = await project.build(makePlugins(), { entry: {} });
  assert.equal(dictionaryAssets(result.assets).length, 2);
  for (const [name, bytes] of [['first', replacement], ['second', second]]) {
    const dictionaryName = `dictionaries/${name}.${createHash('sha256').update(bytes).digest('hex')}.dat`;
    assert.deepEqual(fs.readFileSync(path.join(project.directory, `.dictionary-cache/${name}.dat`)), bytes);
    assertDcb(result.assets, `${name}.css`, dictionaryName, bytes);
  }
});

test('production: empty inputs reuse an automatic snapshot and tiny unchanged inputs do not rewrite it', async (t) => {
  await t.test('empty input without a dictionary fails without creating the cache', async (t) => {
    const project = fixture(t, { 'ready/app.css': '' });
    await assert.rejects(project.build([automaticPlugin()], { entry: {} }));
    assert.equal(fs.existsSync(path.join(project.directory, '.dictionary-cache/styles.dat')), false);
  });
  await t.test('empty input with a cached dictionary can round-trip', async (t) => {
    const snapshot = sampleBytes(10);
    const project = fixture(t, { 'ready/app.css': '', '.dictionary-cache/styles.dat': snapshot });
    const result = await project.build([automaticPlugin()], { entry: {} });
    assert.deepEqual(result.assets.get(dictionaryAssets(result.assets)[0]), snapshot);
    assertDcb(result.assets, 'app.css', dictionaryAssets(result.assets)[0], Buffer.alloc(0));
  });
  await t.test('an unattainable threshold does not rewrite identical bytes', async (t) => {
    const tiny = Buffer.from('a');
    const project = fixture(t, { 'ready/app.css': tiny, '.dictionary-cache/styles.dat': tiny });
    const cachePath = path.join(project.directory, '.dictionary-cache/styles.dat');
    fs.utimesSync(cachePath, 1, 1);
    const oldMtime = fs.statSync(cachePath).mtimeMs;
    const result = await project.build([automaticPlugin()], { entry: {} });
    assert.equal(fs.statSync(cachePath).mtimeMs, oldMtime);
    assert.ok(1 - result.assets.get('app.css.dcb').length / tiny.length < 0.9);
    assertDcb(result.assets, 'app.css', dictionaryAssets(result.assets)[0], tiny);
  });
});

test('production: automatic dictionary options require a source and a valid threshold', () => {
  for (const autoUpdate of [true, false, null, 'cache.dat', [],
    { minSavings: -0.01 }, { minSavings: 1.01 }, { minSavings: NaN },
    { minSavings: Infinity }, { minSavings: '0.9' }]) {
    assert.throws(() => automaticPlugin({ autoUpdate }));
  }
  for (const dictionarySource of [undefined, '', 123]) {
    assert.throws(() => automaticPlugin({ dictionarySource }));
  }
  assert.throws(() => automaticPlugin({ autoUpdate: { cachePath: '.cache/obsolete.dat' } }), /cachePath/);
  assert.doesNotThrow(() => automaticPlugin({ autoUpdate: {} }));
  for (const minSavings of [0, 1]) {
    assert.doesNotThrow(() => automaticPlugin({ autoUpdate: { minSavings } }));
  }
});

test('production: automatic dictionarySource cannot overlap output or input files', async (t) => {
  const original = sampleBytes(11);
  for (const dictionarySource of ['build', 'build/dictionaries/latest.dat', 'ready/app.css']) {
    await t.test(dictionarySource, async (t) => {
      const project = fixture(t, { 'ready/app.css': original });
      await assert.rejects(project.build([automaticPlugin({ dictionarySource })], { entry: {} }));
      assert.deepEqual(fs.readFileSync(path.join(project.directory, 'ready/app.css')), original);
    });
  }
  await t.test('Windows path collision checks ignore casing', { skip: process.platform !== 'win32' }, async (t) => {
    const project = fixture(t, { 'ready/app.css': original });
    await assert.rejects(project.build([automaticPlugin({
      dictionarySource: 'READY/APP.CSS',
    })], { entry: {} }));
    assert.deepEqual(fs.readFileSync(path.join(project.directory, 'ready/app.css')), original);
  });
});

test('production: writable dictionary sources cannot be shared with other instances in either registration order', async (t) => {
  const snapshot = sampleBytes(17);
  const current = sampleBytes(18);
  const dictionarySource = 'snapshots/shared.dat';
  for (const kind of ['input', 'fixed dictionary', 'automatic dictionary']) {
    for (const autoFirst of [true, false]) {
      await t.test(`${kind}, automatic instance ${autoFirst ? 'first' : 'last'}`, async (t) => {
        const project = fixture(t, {
          'ready/app.css': current, 'ready/other.css': current, [dictionarySource]: snapshot,
        });
        const automatic = automaticPlugin({ dictionarySource });
        const other = kind === 'input'
          ? new CompressionDictionaryPlugin({ input: dictionarySource, dcbFilename: 'other.dcb' })
          : new CompressionDictionaryPlugin({
            input: 'ready/other.css', dictionarySource,
            ...(kind === 'automatic dictionary' ? { autoUpdate: {} } : {}),
          });
        await assert.rejects(project.build(autoFirst ? [automatic, other] : [other, automatic], { entry: {} }));
        assert.deepEqual(fs.readFileSync(path.join(project.directory, dictionarySource)), snapshot);
        assert.deepEqual(fs.readFileSync(path.join(project.directory, 'ready/app.css')), current);
        assert.deepEqual(fs.readFileSync(path.join(project.directory, 'ready/other.css')), current);
      });
    }
  }
});

test('production: multiple fixed instances may share a read-only dictionarySource', async (t) => {
  const snapshot = sampleBytes(19);
  const first = sampleBytes(20);
  const second = sampleBytes(21);
  const dictionarySource = 'snapshots/shared.dat';
  const project = fixture(t, {
    'ready/first.css': first, 'ready/second.css': second, [dictionarySource]: snapshot,
  });
  const snapshotPath = path.join(project.directory, dictionarySource);
  fs.utimesSync(snapshotPath, 1, 1);
  const oldMtime = fs.statSync(snapshotPath).mtimeMs;
  const result = await project.build(['first', 'second'].map((name) => new CompressionDictionaryPlugin({
    input: `ready/${name}.css`, dictionarySource,
  })), { entry: {} });
  const names = dictionaryAssets(result.assets);
  assert.equal(names.length, 1);
  assert.deepEqual(result.assets.get(names[0]), snapshot);
  assert.deepEqual(fs.readFileSync(snapshotPath), snapshot);
  assert.equal(fs.statSync(snapshotPath).mtimeMs, oldMtime);
  assert.ok(result.fileDependencies.has(snapshotPath));
  assertDcb(result.assets, 'first.css', names[0], first);
  assertDcb(result.assets, 'second.css', names[0], second);
});

test('production: automatic dictionary instances require exactly one matching asset', async (t) => {
  const project = fixture(t);
  await assert.rejects(project.build([
    new EmitAssetsPlugin({ 'first.css': sampleBytes(12), 'second.css': sampleBytes(13) }),
    new CompressionDictionaryPlugin({
      test: /\.css$/, dictionarySource: '.dictionary-cache/styles.dat', autoUpdate: {},
    }),
  ]));
  assert.equal(fs.existsSync(path.join(project.directory, '.dictionary-cache/styles.dat')), false);
});

test('production: an additional pass that fails cannot persist the first pass dictionary', async (t) => {
  const original = sampleBytes(14);
  const replacement = sampleBytes(15);
  const project = fixture(t, { 'ready/app.css': replacement, '.dictionary-cache/styles.dat': original });
  let passes = 0;
  let emissions = 0;
  const additionalPass = {
    apply(compiler) {
      compiler.hooks.afterEmit.tap('CountIntermediateEmissions', () => { emissions += 1; });
      compiler.hooks.thisCompilation.tap('FailAdditionalPass', (compilation) => {
        const pass = ++passes;
        compilation.hooks.needAdditionalPass.tap('FailAdditionalPass', () => pass === 1);
        compilation.hooks.processAssets.tap({
          name: 'FailAdditionalPass', stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_REPORT + 1,
        }, () => {
          if (pass === 2) compilation.errors.push(new Error('Deliberate additional pass failure'));
        });
      });
    },
  };
  await assert.rejects(project.build([automaticPlugin(), additionalPass], { entry: {} }), /Deliberate additional pass failure/);
  assert.equal(passes, 2);
  assert.ok(emissions >= 1, 'The first pass must actually emit before requesting another pass');
  assert.deepEqual(fs.readFileSync(path.join(project.directory, '.dictionary-cache/styles.dat')), original);
});

test('production: a successful compilation with emission disabled does not persist its dictionary', async (t) => {
  const project = fixture(t, { 'ready/app.css': sampleBytes(16) });
  const compiler = webpack({
    mode: 'production', context: project.directory, entry: {}, cache: false,
    output: { path: path.join(project.directory, 'build'), clean: true },
    plugins: [automaticPlugin(), {
      apply(compiler) { compiler.hooks.shouldEmit.tap('SkipDictionaryEmission', () => false); },
    }],
  });
  try {
    const stats = await new Promise((resolve, reject) => {
      compiler.run((error, result) => error ? reject(error) : resolve(result));
    });
    assert.equal(stats.hasErrors(), false, stats.toString({ all: false, errors: true }));
    assert.ok(stats.compilation.getAsset('app.css.dcb'));
    assert.equal(fs.existsSync(path.join(project.directory, 'build/app.css.dcb')), false);
    assert.equal(fs.existsSync(path.join(project.directory, '.dictionary-cache/styles.dat')), false);
  } finally {
    await new Promise((resolve, reject) => compiler.close((error) => error ? reject(error) : resolve()));
  }
});
