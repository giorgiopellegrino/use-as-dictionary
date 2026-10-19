const path = require('node:path');
const fs = require('node:fs/promises');
const {
  PLUGIN_NAME,
  MANIFEST_FILENAME,
  pathKey,
  validateOutputName,
  saveDictionary,
  normalizeOptions,
  compressResource,
  serializeManifest,
} = require('./core.cjs');
const manifests = new WeakMap();

/**
 * Webpack 5: emit raw dictionaries, DCB representations and a dictionary hash manifest.
 * HTTP headers, discovery, fallback compression and deployment belong to the caller.
 */
class CompressionDictionaryPlugin {
  /**
   * @param {object} options
   * @param {string} [options.input] Ready-to-compress file; relative to compiler.context.
   * @param {string|RegExp} [options.test] Alternative to input: exact emitted asset name or pattern.
   * @param {string} [options.dcbFilename] Output path for input mode; defaults to <basename>.dcb.
   * @param {string} [options.dictionarySource] Raw dictionary; read and updated in place with autoUpdate.
   * @param {number} [options.quality] Brotli quality, an integer from 0 through 11.
   * @param {object} [options.autoUpdate] Reuse or refresh a persisted dictionary for one asset.
   * @param {number} [options.autoUpdate.minSavings=0.9] Minimum saving versus the uncompressed input.
   */
  constructor(options = {}) {
    const { input, test, dcbFilename, dictionarySource, quality, autoUpdate } = normalizeOptions(options);
    if (autoUpdate !== undefined) this.autoUpdate = autoUpdate;
    this.input = input;
    this.test = test;
    this.dcbFilename = dcbFilename;
    this.dictionarySource = dictionarySource;
    this.quality = quality;
  }

  apply(compiler) {
    const { Compilation, sources: { RawSource } } = compiler.webpack;
    const inputPath = this.input === undefined ? undefined : path.resolve(compiler.context, this.input);
    const dictionaryPath = this.dictionarySource === undefined
      ? undefined : path.resolve(compiler.context, this.dictionarySource);
    const dictionaryPrefix = dictionaryPath ? `${path.parse(dictionaryPath).name}.` : '';
    const sourcePaths = new Set([inputPath, dictionaryPath].filter(Boolean).map(pathKey));
    const readOnlyPaths = new Set([inputPath, this.autoUpdate ? undefined : dictionaryPath].filter(Boolean).map(pathKey));
    const pending = new WeakMap();
    if (this.autoUpdate) {
      const relative = path.relative(compiler.options.output.path, dictionaryPath);
      if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
        throw new Error(`${PLUGIN_NAME}: with autoUpdate, dictionarySource must be outside output.path so it survives output.clean.`);
      }
      const emitted = new WeakSet();
      compiler.hooks.afterEmit.tap(`${PLUGIN_NAME}:state`, (compilation) => emitted.add(compilation));
      compiler.hooks.done.tapPromise({ name: `${PLUGIN_NAME}:state`, stage: Infinity }, async (stats) => {
        const dictionary = pending.get(stats.compilation);
        if (!dictionary || stats.hasErrors() || stats.compilation.needAdditionalPass || !emitted.has(stats.compilation)) return;
        await saveDictionary(dictionaryPath, dictionary);
        pending.delete(stats.compilation);
      });
    }

    compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
      if (inputPath) compilation.fileDependencies.add(inputPath);
      // The automatic dictionary is build state; watching our own writes would trigger rebuilds.
      if (dictionaryPath && !this.autoUpdate) compilation.fileDependencies.add(dictionaryPath);

      // All instances contribute to one manifest, scoped to this compilation.
      let manifest = manifests.get(compilation);
      if (!manifest) {
        manifest = { dictionaries: new Map(), sourcePaths: new Set(), readOnlyPaths: new Set(), writablePaths: new Set() };
        manifests.set(compilation, manifest);
        compilation.hooks.processAssets.tap({
          name: `${PLUGIN_NAME}:manifest`,
          stage: Compilation.PROCESS_ASSETS_STAGE_REPORT,
        }, () => {
          if (manifest.sourcePaths.has(pathKey(path.resolve(compiler.outputPath, MANIFEST_FILENAME)))) {
            throw new Error(`${PLUGIN_NAME}: output ${MANIFEST_FILENAME} would overwrite an input file.`);
          }
          if (compilation.getAsset(MANIFEST_FILENAME)) {
            throw new Error(`${PLUGIN_NAME}: output collision at ${MANIFEST_FILENAME}; this path is reserved for the dictionary manifest.`);
          }
          compilation.emitAsset(MANIFEST_FILENAME,
            new RawSource(serializeManifest(manifest.dictionaries)),
            { compressionDictionary: 'manifest' });
        });
      }
      for (const sourcePath of readOnlyPaths) {
        if (manifest.writablePaths.has(sourcePath)) {
          throw new Error(`${PLUGIN_NAME}: an automatic dictionarySource cannot overwrite an input or a fixed dictionarySource.`);
        }
        manifest.readOnlyPaths.add(sourcePath);
      }
      for (const sourcePath of sourcePaths) manifest.sourcePaths.add(sourcePath);
      if (this.autoUpdate) {
        const key = pathKey(dictionaryPath);
        if (manifest.readOnlyPaths.has(key)) {
          throw new Error(`${PLUGIN_NAME}: an automatic dictionarySource cannot overwrite an input or a fixed dictionarySource.`);
        }
        if (manifest.writablePaths.has(key)) {
          throw new Error(`${PLUGIN_NAME}: each autoUpdate instance requires a distinct dictionarySource.`);
        }
        manifest.writablePaths.add(key);
      }

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
            // Multiple instances must never use generated assets as inputs.
            if (info.compressionDictionary) return false;
            if (typeof this.test === 'string') return name === this.test;
            this.test.lastIndex = 0;
            return this.test.test(name);
          });
        if (!assets.length) {
          throw new Error(`${PLUGIN_NAME}: no emitted assets match ${this.test}.`);
        }
        if (this.autoUpdate && assets.length !== 1) {
          throw new Error(`${PLUGIN_NAME}: autoUpdate requires exactly one asset per instance; use separate instances and dictionarySource paths.`);
        }
        let snapshot;
        if (this.autoUpdate) {
          // Read the current state directly, bypassing Webpack's cached input filesystem.
          try {
            snapshot = await fs.readFile(dictionaryPath);
          } catch (error) {
            if (error.code !== 'ENOENT') {
              throw new Error(`${PLUGIN_NAME}: cannot read dictionarySource ${dictionaryPath}: ${error.message}`, { cause: error });
            }
          }
        } else if (dictionaryPath) {
          snapshot = await readFile(dictionaryPath, 'dictionarySource');
        }

        // Check every output before publishing any assets from this instance.
        const outputs = new Map();
        const dictionaries = new Map();
        const queue = (name, bytes, kind) => {
          validateOutputName(name);
          if (manifest.sourcePaths.has(pathKey(path.resolve(compiler.outputPath, name)))) {
            throw new Error(`${PLUGIN_NAME}: output ${name} would overwrite an input file.`);
          }
          if (pathKey(name) === pathKey(MANIFEST_FILENAME)) {
            throw new Error(`${PLUGIN_NAME}: output collision at ${name}; this path is reserved for the dictionary manifest.`);
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
          const { dictionary, dictionaryName, dcb, manifestEntry, changed, action, saving } = compressResource({
            name,
            content: source.buffer(),
            snapshot,
            dictionaryPrefix,
            quality: this.quality,
            autoUpdate: this.autoUpdate,
          });
          if (this.autoUpdate) {
            if (changed) pending.set(compilation, dictionary);
            compilation.getLogger(PLUGIN_NAME).info(`${name}: dictionary ${action}; DCB saving ${saving} versus uncompressed input.`);
          }
          queue(dictionaryName, dictionary, 'dictionary');
          dictionaries.set(dictionaryName, manifestEntry);

          queue(this.dcbFilename || `${name}.dcb`, dcb, 'dcb');
        }

        for (const [name, { bytes, kind }] of outputs) {
          compilation.emitAsset(name, new RawSource(bytes), { compressionDictionary: kind });
        }
        for (const [name, entry] of dictionaries) manifest.dictionaries.set(name, entry);
      });
    });
  }
}

module.exports = CompressionDictionaryPlugin;
