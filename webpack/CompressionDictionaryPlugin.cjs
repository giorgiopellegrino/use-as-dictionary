const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { brotliCompressSync, gzipSync, constants } = require('node:zlib');
const postcss = require('postcss');
const cssnano = require('cssnano');
const brotli = require('brotli-wasm-custom-dictionary');

const MAGIC = Buffer.from([0xff, 0x44, 0x43, 0x42]);

class CompressionDictionaryPlugin {
  constructor({ dictionarySource, match = '/dist/styles.*.css' }) {
    this.dictionarySource = dictionarySource;
    this.match = match;
  }

  apply(compiler) {
    const { Compilation, sources: { RawSource } } = compiler.webpack;
    compiler.hooks.thisCompilation.tap('CompressionDictionaryPlugin', (compilation) => {
      compilation.fileDependencies.add(this.dictionarySource);
      compilation.hooks.processAssets.tapPromise({
        name: 'CompressionDictionaryPlugin',
        // After CSS minification and Webpack's real content hash calculation.
        stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_TRANSFER,
      }, async () => {
        const cssAssets = compilation.getAssets().filter(({ name }) => /^dist\/styles\..+\.css$/.test(name));
        if (!cssAssets.length) throw new Error('Nessun CSS estratto da comprimere.');

        // A frozen previous release is a valid raw prefix dictionary; no training is needed.
        const baseline = await fs.readFile(this.dictionarySource, 'utf8');
        const minified = await postcss([cssnano({
          preset: ['default', { discardComments: { all: true } }],
        })]).process(baseline, { from: this.dictionarySource, map: false });
        const dictionary = Buffer.from(minified.css);
        if (!dictionary.length || dictionary.length > 2 ** 22 - 16) {
          throw new Error('Il dizionario deve contenere da 1 a 4 MiB - 16 byte (finestra dell’encoder WASM).');
        }
        const hash = createHash('sha256').update(dictionary).digest();
        const id = `styles-${hash.toString('hex').slice(0, 16)}`;
        const dictionaryName = `dictionaries/dictionary_style_${hash.toString('hex').slice(0, 16)}.dat`;
        const emit = (name, bytes) => compilation.emitAsset(name, new RawSource(bytes));
        const standardVariants = (name, bytes) => {
          const br = brotliCompressSync(bytes, {
            params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
          });
          const gzip = gzipSync(bytes, { level: 9 });
          emit(`${name}.br`, br);
          emit(`${name}.gz`, gzip);
          return { brotliBytes: br.length, gzipBytes: gzip.length };
        };

        emit(dictionaryName, dictionary);
        const manifest = {
          format: 'dcb',
          dictionary: {
            url: `/${dictionaryName}`,
            id,
            sha256: hash.toString('base64'),
            match: this.match,
            bytes: dictionary.length,
            ...standardVariants(dictionaryName, dictionary),
          },
          resources: [],
        };

        for (const { name, source } of cssAssets) {
          const css = Buffer.from(source.source());
          // This encoder really attaches the external dictionary. node:zlib does not.
          const stream = Buffer.from(brotli.compress(css, { quality: 11, customDictionary: dictionary }));
          const dcb = Buffer.concat([MAGIC, hash, stream]);
          emit(`${name}.dcb`, dcb);
          manifest.resources.push({
            url: `/${name}`,
            bytes: css.length,
            ...standardVariants(name, css),
            dcbBytes: dcb.length, // Includes the 36-byte transport header.
          });
        }

        const htmlAsset = compilation.getAsset('index.html');
        if (!htmlAsset) throw new Error('HtmlWebpackPlugin deve generare index.html.');
        const link = `<link rel="compression-dictionary" href="${manifest.dictionary.url}">`;
        compilation.updateAsset('index.html', new RawSource(
          htmlAsset.source.source().toString().replace('</head>', `${link}</head>`),
        ));
        // Also precompress ordinary JS/HTML: compression work remains at build time.
        for (const { name, source } of compilation.getAssets()) {
          if (/\.(js|html)$/.test(name)) standardVariants(name, Buffer.from(source.source()));
        }
        emit('demo-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
      });
    });
  }
}

module.exports = CompressionDictionaryPlugin;
