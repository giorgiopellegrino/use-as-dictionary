const path = require('node:path');
const fs = require('node:fs/promises');
const { realpathSync } = require('node:fs');
const {
  PLUGIN_NAME, MANIFEST_FILENAME, pathKey, validateOutputName,
  normalizeOptions, compressResource, serializeManifest, saveDictionary,
} = require('./core.cjs');

const groups = new WeakMap();

function canonicalPath(filename) {
  // Vite resolves root through realpath; output paths may still use a Windows
  // short name or a symlink. Compare the same physical paths, even before a
  // new cache or output directory exists.
  let ancestor = path.resolve(filename);
  const missing = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(ancestor), ...missing.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return path.resolve(filename);
      missing.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function isWithin(directory, filename) {
  const relative = path.relative(directory, filename);
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function bytesOf(asset) {
  return Buffer.from(asset.type === 'chunk' ? asset.code : asset.source);
}

function checkWriteOrdering(plugins, coordinator) {
  const position = plugins.indexOf(coordinator);
  if (position === -1) throw new Error(`${PLUGIN_NAME}: configure new CompressionDictionaryPlugin() in Vite's plugins array.`);
  for (const candidate of plugins.slice(position + 1)) {
    if (candidate.writeBundle?.order === 'post') {
      throw new Error(`${PLUGIN_NAME}: autoUpdate requires new CompressionDictionaryPlugin() after ${candidate.name}'s post writeBundle hook; move it after that plugin.`);
    }
  }
}

async function readFile(filename, option, missingAllowed = false) {
  try {
    return await fs.readFile(filename);
  } catch (error) {
    if (missingAllowed && error.code === 'ENOENT') return undefined;
    throw new Error(`${PLUGIN_NAME}: cannot read ${option} ${filename}: ${error.message}`, { cause: error });
  }
}

/** Create a Vite 8 build plugin. Original assets and their filenames are preserved. */
class CompressionDictionaryPlugin {
  constructor(options = {}) {
    const normalized = normalizeOptions(options);
    const member = { ...normalized };
    let group;
    const isCoordinator = () => group.members.at(-1) === member;
    const invalidate = () => {
      if (group?.state) {
        group.state.failed = true;
        group.state.pending.clear();
      }
    };

    const plugin = this;
    Object.assign(plugin, {
      name: 'use-as-dictionary',
      apply: 'build',
      enforce: 'post',

      configResolved(config) {
        const output = config.build.rolldownOptions?.output ?? config.build.rollupOptions?.output;
        if (Array.isArray(output) && output.length !== 1) {
          throw new Error(`${PLUGIN_NAME}: Vite requires exactly one output configuration; use separate builds for multiple outputs.`);
        }
        if (config.build.lib && !output && (config.build.lib.formats?.length ?? 2) !== 1) {
          throw new Error(`${PLUGIN_NAME}: Vite library builds require one explicit output format.`);
        }
        if (config.build.watch && member.autoUpdate) {
          throw new Error(`${PLUGIN_NAME}: Vite autoUpdate requires a completed build; build.watch is not supported with autoUpdate.`);
        }
        group = groups.get(config);
        if (!group) {
          group = { config, members: [], state: undefined };
          groups.set(config, group);
        }
        if (group.members.includes(member)) {
          throw new Error(`${PLUGIN_NAME}: create a separate Vite plugin instance for each configuration entry.`);
        }
        member.inputPath = member.input === undefined ? undefined : canonicalPath(path.resolve(config.root, member.input));
        member.dictionaryPath = member.dictionarySource === undefined ? undefined : canonicalPath(path.resolve(config.root, member.dictionarySource));
        member.dictionaryPrefix = member.dictionaryPath ? `${path.parse(member.dictionaryPath).name}.` : '';
        group.members.push(member);
        // Reject this before Vite can empty its output directory.
        const outputConfig = Array.isArray(output) ? output[0] : output;
        const outputDirectory = canonicalPath(path.resolve(config.root, outputConfig?.dir || config.build.outDir));
        if (member.autoUpdate && isWithin(outputDirectory, member.dictionaryPath)) {
          throw new Error(`${PLUGIN_NAME}: with autoUpdate, dictionarySource must be outside build.outDir so it survives emptyOutDir.`);
        }
      },

      buildStart: {
        order: 'pre',
        sequential: true,
        handler() {
          if (isCoordinator()) {
            group.state = {
              pending: new Map(), sourcePaths: new Set(), renderCount: 0,
              failed: false, written: false, committed: false,
            };
            if (group.members.some((current) => current.autoUpdate)) {
              checkWriteOrdering(this.environment.plugins, plugin);
            }
            const readOnly = new Set();
            const writable = new Set();
            for (const current of group.members) {
              for (const filename of [current.inputPath, current.dictionaryPath].filter(Boolean)) {
                group.state.sourcePaths.add(pathKey(filename));
              }
              for (const filename of [current.inputPath, current.autoUpdate ? undefined : current.dictionaryPath].filter(Boolean)) {
                readOnly.add(pathKey(filename));
              }
              if (current.autoUpdate) {
                const filename = pathKey(current.dictionaryPath);
                if (writable.has(filename)) {
                  throw new Error(`${PLUGIN_NAME}: each autoUpdate instance requires a distinct dictionarySource.`);
                }
                writable.add(filename);
              }
            }
            for (const filename of writable) {
              if (readOnly.has(filename)) {
                throw new Error(`${PLUGIN_NAME}: an automatic dictionarySource cannot overwrite an input or a fixed dictionarySource.`);
              }
            }
          }
          if (member.inputPath) this.addWatchFile(member.inputPath);
          // Automatic dictionaries are build state; watching our writes would loop.
          if (member.dictionaryPath && !member.autoUpdate) this.addWatchFile(member.dictionaryPath);
        },
      },

      renderStart: {
        order: 'pre',
        sequential: true,
        handler(outputOptions) {
          if (!isCoordinator()) return;
          if (++group.state.renderCount !== 1 || outputOptions.file) {
            invalidate();
            throw new Error(`${PLUGIN_NAME}: Vite requires one directory output per build; multiple outputs and output.file are not supported.`);
          }
          group.state.outputDirectory = canonicalPath(path.resolve(group.config.root, outputOptions.dir || group.config.build.outDir));
          if (group.members.some((current) => current.autoUpdate)) {
            // These plugins are resolved here, including promised/nested options.
            // Output plugins run after input plugins, and Rolldown does not notify
            // renderError or closeBundle(error) about a writeBundle hook failure.
            for (const outputPlugin of outputOptions.plugins) {
              if (outputPlugin.writeBundle?.order === 'post') {
                throw new Error(`${PLUGIN_NAME}: autoUpdate does not support post writeBundle hooks in output.plugins; configure ${outputPlugin.name} before new CompressionDictionaryPlugin() in Vite's plugins instead.`);
              }
            }
          }
          for (const current of group.members) {
            if (current.autoUpdate && isWithin(group.state.outputDirectory, current.dictionaryPath)) {
              invalidate();
              throw new Error(`${PLUGIN_NAME}: with autoUpdate, dictionarySource must be outside the output directory.`);
            }
          }
        },
      },

      generateBundle: {
        // Vite's CSS processing and final content hashes are ready at this point.
        order: 'post',
        async handler(outputOptions, bundle, isWrite) {
          if (!isCoordinator()) return;
          const state = group.state;
          state.isWrite = isWrite;
          const originals = Object.values(bundle);
          const existing = new Map(originals.map((asset) => [pathKey(asset.fileName), asset]));
          const outputs = new Map();
          const dictionaries = new Map();
          const queue = async (name, bytes, kind) => {
            validateOutputName(name);
            const key = pathKey(name);
            if (state.sourcePaths.has(pathKey(canonicalPath(path.resolve(state.outputDirectory, name))))) {
              throw new Error(`${PLUGIN_NAME}: output ${name} would overwrite an input file.`);
            }
            if (kind !== 'manifest' && key === pathKey(MANIFEST_FILENAME)) {
              throw new Error(`${PLUGIN_NAME}: output collision at ${name}; this path is reserved for the dictionary manifest.`);
            }
            const previous = outputs.get(key);
            if (previous || existing.has(key)) {
              if (kind === 'dictionary' && previous?.kind === kind && previous.bytes.equals(bytes)) return;
              throw new Error(`${PLUGIN_NAME}: output collision at ${name}; use disjoint tests and dictionary filenames.`);
            }
            // publicDir files are copied by Vite without appearing in the bundle.
            if (group.config.publicDir && group.config.build.copyPublicDir) {
              try {
                await fs.access(path.resolve(group.config.publicDir, name));
                throw new Error(`${PLUGIN_NAME}: output collision at ${name}; it already exists in publicDir.`);
              } catch (error) {
                if (error.code !== 'ENOENT') throw error;
              }
            }
            outputs.set(key, { name, bytes, kind });
          };

          try {
            for (const current of group.members) {
              const assets = current.inputPath
                ? [{ fileName: path.basename(current.inputPath), type: 'asset', source: await readFile(current.inputPath, 'input') }]
                : originals.filter(({ fileName }) => {
                  if (typeof current.test === 'string') return current.test === fileName;
                  current.test.lastIndex = 0;
                  return current.test.test(fileName);
                });
              if (!assets.length) throw new Error(`${PLUGIN_NAME}: no emitted assets match ${current.test}.`);
              if (current.autoUpdate && assets.length !== 1) {
                throw new Error(`${PLUGIN_NAME}: autoUpdate requires exactly one asset per instance; use separate instances and dictionarySource paths.`);
              }
              const snapshot = current.dictionaryPath
                ? await readFile(current.dictionaryPath, 'dictionarySource', Boolean(current.autoUpdate)) : undefined;
              for (const asset of assets) {
                const result = compressResource({
                  name: asset.fileName,
                  content: bytesOf(asset),
                  snapshot,
                  dictionaryPrefix: current.dictionaryPrefix,
                  quality: current.quality,
                  autoUpdate: current.autoUpdate,
                });
                await queue(result.dictionaryName, result.dictionary, 'dictionary');
                await queue(current.dcbFilename || `${asset.fileName}.dcb`, result.dcb, 'dcb');
                dictionaries.set(result.dictionaryName, result.manifestEntry);
                if (current.autoUpdate && result.changed) state.pending.set(current.dictionaryPath, result.dictionary);
              }
            }
            await queue(MANIFEST_FILENAME, serializeManifest(dictionaries), 'manifest');
            for (const { name, bytes } of outputs.values()) this.emitFile({ type: 'asset', fileName: name, source: bytes });
          } catch (error) {
            invalidate();
            throw error;
          }
        },
      },

      buildEnd(error) {
        if (error) invalidate();
      },

      renderError() {
        // Generation failures must discard any planned dictionary rotation.
        invalidate();
      },

      writeBundle: {
        order: 'post',
        sequential: true,
        handler() {
          if (isCoordinator() && !group.state.failed) group.state.written = true;
        },
      },

      closeBundle: {
        order: 'post',
        sequential: true,
        async handler(error) {
          if (!isCoordinator()) return;
          if (error) invalidate();
          const state = group.state;
          if (!state || state.failed || !state.written || !state.isWrite || state.committed || group.config.build.write === false) return;
          state.committed = true;
          for (const [filename, dictionary] of state.pending) await saveDictionary(filename, dictionary);
          state.pending.clear();
        },
      },
    });
  }
}

module.exports = CompressionDictionaryPlugin;
