const path = require('node:path');
const { createHash } = require('node:crypto');
const brotli = require('brotli-wasm-custom-dictionary');

const PLUGIN_NAME = 'CompressionDictionaryPlugin';
const MAGIC = Buffer.from([0xff, 0x44, 0x43, 0x42]);
const MAX_DICTIONARY_BYTES = 2 ** 22 - 16; // Window used by this WASM encoder.

const pathKey = (filename) => process.platform === 'win32' ? filename.toLowerCase() : filename;

function validateOutputName(name) {
  if (typeof name !== 'string' || /[\\:\x00-\x1f?#]/.test(name)
    || name.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${PLUGIN_NAME}: output must be a relative asset path using /: ${name}`);
  }
}

/**
 * Webpack 5: emit raw dictionaries and DCB representations of files or final assets.
 * HTTP headers, discovery, fallback compression and deployment belong to the caller.
 */
class CompressionDictionaryPlugin {
  /**
   * @param {object} options
   * @param {string} [options.input] Ready-to-compress file; relative to compiler.context.
   * @param {string|RegExp} [options.test] Alternative to input: exact emitted asset name or pattern.
   * @param {string} [options.dcbFilename] Output path for input mode; defaults to <basename>.dcb.
   * @param {string} [options.dictionarySource] Raw snapshot; relative to compiler.context.
   * @param {string} [options.dictionaryFilename] Output template; [hash] is dictionary SHA-256 hex.
   * @param {number} [options.quality] Brotli quality, an integer from 0 through 11.
   */
  constructor({ input, test, dcbFilename, dictionarySource, dictionaryFilename = 'dictionaries/[hash].dat', quality = 11 } = {}) {
    if ((input === undefined) === (test === undefined)) {
      throw new TypeError(`${PLUGIN_NAME}: provide exactly one of input (file path) or test (emitted assets).`);
    }
    if (input !== undefined && (typeof input !== 'string' || !input)) {
      throw new TypeError(`${PLUGIN_NAME}: input must be a non-empty file path.`);
    }
    if (test !== undefined && !(test instanceof RegExp) && (typeof test !== 'string' || !test)) {
      throw new TypeError(`${PLUGIN_NAME}: test must be an asset name or a RegExp.`);
    }
    if (dcbFilename !== undefined) {
      if (input === undefined) throw new TypeError(`${PLUGIN_NAME}: dcbFilename requires input.`);
      validateOutputName(dcbFilename);
    }
    if (dictionarySource !== undefined && (typeof dictionarySource !== 'string' || !dictionarySource)) {
      throw new TypeError(`${PLUGIN_NAME}: dictionarySource must be a non-empty file path.`);
    }
    if (!Number.isInteger(quality) || quality < 0 || quality > 11) {
      throw new RangeError(`${PLUGIN_NAME}: quality must be an integer from 0 to 11.`);
    }
    if (typeof dictionaryFilename !== 'string') {
      throw new TypeError(`${PLUGIN_NAME}: dictionaryFilename must be a string.`);
    }
    const preview = dictionaryFilename.replaceAll('[hash]', 'hash');
    validateOutputName(preview);
    if (/[\[\]]/.test(preview)) {
      throw new Error(`${PLUGIN_NAME}: dictionaryFilename only supports the [hash] placeholder.`);
    }

    this.input = input;
    this.test = test instanceof RegExp ? new RegExp(test.source, test.flags) : test;
    this.dcbFilename = dcbFilename;
    this.dictionarySource = dictionarySource;
    this.dictionaryFilename = dictionaryFilename;
    this.quality = quality;
  }

  apply(compiler) {
    const { Compilation, sources: { RawSource } } = compiler.webpack;
    const inputPath = this.input === undefined ? undefined : path.resolve(compiler.context, this.input);
    const dictionaryPath = this.dictionarySource === undefined
      ? undefined : path.resolve(compiler.context, this.dictionarySource);
    const sourcePaths = new Set([inputPath, dictionaryPath].filter(Boolean).map(pathKey));

    compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
      if (inputPath) compilation.fileDependencies.add(inputPath);
      if (dictionaryPath) compilation.fileDependencies.add(dictionaryPath);

      compilation.hooks.processAssets.tapPromise({
        name: PLUGIN_NAME,
        // Read minified bytes and final filenames, after real content hashing.
        stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_TRANSFER,
      }, async () => {
        const readFile = async (filePath, option) => {
          try {
            return await new Promise((resolve, reject) => {
              compiler.inputFileSystem.readFile(filePath, (error, data) => {
                if (error) reject(error);
                else resolve(Buffer.from(data));
              });
            });
          } catch (error) {
            if (error.code === 'ENOENT') compilation.missingDependencies.add(filePath);
            throw new Error(`${PLUGIN_NAME}: cannot read ${option} ${filePath}: ${error.message}`, { cause: error });
          }
        };

        const assets = inputPath
          ? [{ name: path.basename(inputPath), source: new RawSource(await readFile(inputPath, 'input')) }]
          : compilation.getAssets().filter(({ name, info }) => {
            // Multiple instances must never use generated dictionaries/DCB as inputs.
            if (info.compressionDictionary) return false;
            if (typeof this.test === 'string') return name === this.test;
            this.test.lastIndex = 0;
            return this.test.test(name);
          });
        if (!assets.length) {
          throw new Error(`${PLUGIN_NAME}: no emitted assets match ${this.test}.`);
        }
        const snapshot = dictionaryPath ? await readFile(dictionaryPath, 'dictionarySource') : undefined;

        // Check every output before publishing any assets from this instance.
        const outputs = new Map();
        const queue = (name, bytes, kind) => {
          validateOutputName(name);
          if (sourcePaths.has(pathKey(path.resolve(compiler.outputPath, name)))) {
            throw new Error(`${PLUGIN_NAME}: output ${name} would overwrite an input file.`);
          }
          const existing = outputs.get(name) || compilation.getAsset(name);
          if (existing) {
            const existingKind = existing.kind || existing.info.compressionDictionary;
            const existingBytes = existing.bytes || existing.source.buffer();
            // A raw snapshot may intentionally be shared by several instances/assets.
            if (kind === 'dictionary' && existingKind === kind && existingBytes.equals(bytes)) return;
            throw new Error(`${PLUGIN_NAME}: output collision at ${name}; use disjoint tests and dictionary filenames.`);
          }
          outputs.set(name, { bytes, kind });
        };

        for (const { name, source } of assets) {
          const content = source.buffer();
          const dictionary = snapshot === undefined ? content : snapshot;
          if (!dictionary.length || dictionary.length > MAX_DICTIONARY_BYTES) {
            throw new Error(`${PLUGIN_NAME}: dictionary for ${name} must contain 1 to ${MAX_DICTIONARY_BYTES} bytes (4 MiB - 16).`);
          }
          const hash = createHash('sha256').update(dictionary).digest();
          const dictionaryName = this.dictionaryFilename.replaceAll('[hash]', hash.toString('hex'));
          queue(dictionaryName, dictionary, 'dictionary');

          const compressed = Buffer.from(brotli.compress(content, {
            quality: this.quality,
            customDictionary: dictionary,
          }));
          queue(this.dcbFilename || `${name}.dcb`, Buffer.concat([MAGIC, hash, compressed]), 'dcb');
        }

        for (const [name, { bytes, kind }] of outputs) {
          compilation.emitAsset(name, new RawSource(bytes), { compressionDictionary: kind });
        }
      });
    });
  }
}

module.exports = CompressionDictionaryPlugin;
