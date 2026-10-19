const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// These helpers and checks are copied to each consumer and run in new processes.
// Their dependencies must come from the installed tarball, not this checkout.
function assertInstalled(filename) {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const modulesPath = fs.realpathSync(path.join(__dirname, 'node_modules'));
  const relative = path.relative(modulesPath, fs.realpathSync(filename));
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative), `Module resolved outside the consumer: ${filename}`);
}

function assertDcbOutput(outputPath, dcbFilename, content, brotli) {
  const assert = require('node:assert/strict');
  const { createHash } = require('node:crypto');
  const fs = require('node:fs');
  const path = require('node:path');
  const manifest = JSON.parse(fs.readFileSync(
    path.join(outputPath, 'dist/compression-dictionary-manifest.json'), 'utf8',
  ));
  const hash = createHash('sha256').update(content).digest();
  const dictionaryName = `dictionaries/${hash.toString('hex')}.dat`;
  assert.deepEqual(manifest, {
    dictionaries: {
      [dictionaryName]: {
        sha256Base64: hash.toString('base64'),
        availableDictionary: `:${hash.toString('base64')}:`,
      },
    },
  });
  const dictionary = fs.readFileSync(path.join(outputPath, dictionaryName));
  assert.deepEqual(dictionary, content);
  const dcb = fs.readFileSync(path.join(outputPath, dcbFilename));
  assert.ok(dcb.length > 36, 'DCB must contain a header and a Brotli payload');
  assert.deepEqual(dcb.subarray(0, 4), Buffer.from([0xff, 0x44, 0x43, 0x42]));
  assert.deepEqual(dcb.subarray(4, 36), hash);
  assert.deepEqual(Buffer.from(brotli.decompress(dcb.subarray(36), {
    customDictionary: dictionary,
  })), content, 'The installed plugin must produce a lossless DCB representation');
}

async function checkWebpackPackage() {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const { createRequire } = require('node:module');
  const path = require('node:path');

  const entry = require.resolve('use-as-dictionary/webpack');
  assertInstalled(entry);
  assert.throws(() => require.resolve('use-as-dictionary'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' },
    'Consumers must select an explicit bundler entry');
  assertInstalled(require.resolve('webpack'));
  assert.throws(() => require.resolve('vite'), { code: 'MODULE_NOT_FOUND' },
    'A Webpack consumer must not need Vite installed');
  const pluginRequire = createRequire(entry);
  assertInstalled(pluginRequire.resolve('brotli-wasm-custom-dictionary'));

  const CompressionDictionaryPlugin = require('use-as-dictionary/webpack');
  assert.equal((await import('use-as-dictionary/webpack')).default, CompressionDictionaryPlugin,
    'CommonJS and ESM consumers must receive the same Webpack class');
  assert.throws(() => CompressionDictionaryPlugin({ input: './styles.css' }), TypeError);
  const webpack = require('webpack');
  const brotli = pluginRequire('brotli-wasm-custom-dictionary');
  const content = Buffer.from('.card{display:grid;gap:1rem;color:#123456;padding:1rem}\n'.repeat(32));
  fs.writeFileSync(path.join(__dirname, 'styles.css'), content);
  fs.writeFileSync(path.join(__dirname, 'entry.js'), '');

  const outputPath = path.join(__dirname, 'build');
  const compiler = webpack({
    mode: 'production',
    context: __dirname,
    entry: './entry.js',
    output: { path: outputPath, filename: 'main.js' },
    devtool: false,
    optimization: { minimize: false },
    plugins: [new CompressionDictionaryPlugin({ input: './styles.css' })],
  });
  try {
    const stats = await new Promise((resolve, reject) => {
      compiler.run((error, result) => error ? reject(error) : resolve(result));
    });
    assert.equal(stats.hasErrors(), false, stats.toString({ all: false, errors: true }));
    assertDcbOutput(outputPath, 'styles.css.dcb', content, brotli);
  } finally {
    await new Promise((resolve, reject) => compiler.close((error) => error ? reject(error) : resolve()));
  }
  console.log(`Installed package: CommonJS, ESM, Webpack ${webpack.version}, constructor, dictionary manifest and DCB decoding passed.`);
}

async function checkVitePackage() {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const { createRequire } = require('node:module');
  const path = require('node:path');
  const entry = require.resolve('use-as-dictionary/vite');
  assertInstalled(entry);
  assertInstalled(require.resolve('vite'));
  assert.throws(() => require.resolve('webpack'), { code: 'MODULE_NOT_FOUND' },
    'A Vite consumer must not need Webpack installed');
  const pluginRequire = createRequire(entry);
  assert.throws(() => pluginRequire.resolve('webpack'), { code: 'MODULE_NOT_FOUND' },
    'The Vite adapter must not pull Webpack into the plugin package');
  assertInstalled(pluginRequire.resolve('brotli-wasm-custom-dictionary'));

  const CompressionDictionaryPlugin = require('use-as-dictionary/vite');
  assert.equal((await import('use-as-dictionary/vite')).default, CompressionDictionaryPlugin,
    'CommonJS and ESM consumers must receive the same Vite class');
  assert.throws(() => CompressionDictionaryPlugin({ test: /\.css$/ }), TypeError);
  const vite = await import('vite');
  const brotli = pluginRequire('brotli-wasm-custom-dictionary');
  const input = Buffer.from('/* package fixture source */\n.card {\n  color: #ffffff;\n  padding: 0px 0px 0px 0px;\n}\n');
  fs.writeFileSync(path.join(__dirname, 'styles.css'), input);
  fs.writeFileSync(path.join(__dirname, 'index.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="./styles.css"></head><body class="card">Package check</body></html>');

  const outputPath = path.join(__dirname, 'build');
  const result = await vite.build({
    configFile: false,
    root: __dirname,
    logLevel: 'error',
    build: { outDir: outputPath, cssMinify: true },
    plugins: [new CompressionDictionaryPlugin({ test: /\.css$/ })],
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(({ output }) => output);
  const cssAssets = outputs.filter(({ type, fileName }) => type === 'asset' && fileName.endsWith('.css'));
  assert.equal(cssAssets.length, 1, 'The Vite fixture must emit exactly one CSS asset');
  const content = fs.readFileSync(path.join(outputPath, cssAssets[0].fileName));
  assert.notDeepEqual(content, input, 'The fixture must exercise final transformed CSS bytes');
  assertDcbOutput(outputPath, `${cssAssets[0].fileName}.dcb`, content, brotli);
  console.log(`Installed package: CommonJS, ESM, Vite ${vite.version} without Webpack, final CSS and DCB decoding passed.`);
}

function main() {
  const checkout = path.resolve(__dirname, '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(checkout, 'package.json'), 'utf8'));
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli && fs.existsSync(npmCli), 'Run this check with npm run test:package.');
  const environment = { ...process.env, NODE_PATH: '' };
  delete environment.NODE_OPTIONS;

  const temporaryParent = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryParent, 'use-as-dictionary-package-'));
  try {
    const relative = path.relative(checkout, directory);
    assert.ok(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
      'The package consumer must be outside the checkout; set a different temporary directory.');

    const packed = JSON.parse(execFileSync(process.execPath, [
      npmCli, 'pack', '--json', '--ignore-scripts', '--workspaces=false', '--pack-destination', directory,
    ], { cwd: checkout, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
    assert.equal(packed.length, 1, 'Only the plugin package should be packed');
    const [archive] = packed;
    assert.equal(archive.name, packageJson.name);
    assert.equal(archive.version, packageJson.version);
    const files = archive.files.map(({ path: filename }) => filename);
    const required = [
      'LICENSE', 'README.md', 'package.json',
      'src/core.cjs', 'src/webpack.cjs', 'src/vite.cjs',
    ];
    for (const filename of required) assert.ok(files.includes(filename), `Missing package file: ${filename}`);
    for (const filename of files) {
      assert.ok(required.includes(filename) || filename.startsWith('src/'),
        `Development or example file leaked into the package: ${filename}`);
      assert.ok(!/\.pdf$/i.test(filename), `PDF leaked into the package: ${filename}`);
    }
    assert.equal(path.basename(archive.filename), archive.filename, 'Tarball must stay in the temporary directory');
    console.log(`Package contents verified: ${files.join(', ')}`);

    function checkConsumer(bundler, check) {
      const consumer = path.join(directory, bundler);
      fs.mkdirSync(consumer);
      fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({
        name: `use-as-dictionary-${bundler}-package-check`, version: '1.0.0', private: true,
      }, null, 2));
      // Resolve each public peer range as a fresh consumer would. The repository's
      // locked bundler versions are exercised separately by npm test.
      execFileSync(process.execPath, [
        npmCli, 'install', '--prefix', consumer, path.join(directory, archive.filename),
        `${bundler}@${packageJson.peerDependencies[bundler]}`, '--ignore-scripts', '--no-audit', '--no-fund',
        '--omit=dev', '--workspaces=false', '--package-lock=false', '--strict-peer-deps',
      ], { cwd: consumer, env: environment, stdio: 'inherit' });

      const smokeScript = path.join(consumer, 'check.cjs');
      fs.writeFileSync(smokeScript, `${assertInstalled.toString()}\n${assertDcbOutput.toString()}
(${check.toString()})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});\n`);
      execFileSync(process.execPath, ['--no-global-search-paths', smokeScript], {
        cwd: consumer, env: environment, stdio: 'inherit',
      });
    }

    checkConsumer('webpack', checkWebpackPackage);
    checkConsumer('vite', checkVitePackage);
  } finally {
    // Resolve and check the exact temporary target before recursively removing it.
    assert.equal(path.dirname(fs.realpathSync(directory)), temporaryParent);
    assert.ok(path.basename(directory).startsWith('use-as-dictionary-package-'));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
