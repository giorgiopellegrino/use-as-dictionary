const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const brotli = require('brotli-wasm-custom-dictionary');

const PLUGIN_NAME = 'CompressionDictionaryPlugin';
const MAGIC = Buffer.from([0xff, 0x44, 0x43, 0x42]);
const MAX_DICTIONARY_BYTES = 2 ** 22 - 16; // Window used by this WASM encoder.
const MANIFEST_FILENAME = 'dist/compression-dictionary-manifest.json';

const pathKey = (filename) => process.platform === 'win32' ? filename.toLowerCase() : filename;

function validateOutputName(name) {
  if (typeof name !== 'string' || /[\\:\x00-\x1f?#]/.test(name)
    || name.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${PLUGIN_NAME}: output must be a relative asset path using /: ${name}`);
  }
}

function validateDictionary(dictionary, name) {
  if (!dictionary.length || dictionary.length > MAX_DICTIONARY_BYTES) {
    throw new Error(`${PLUGIN_NAME}: dictionary for ${name} must contain 1 to ${MAX_DICTIONARY_BYTES} bytes (4 MiB - 16).`);
  }
}

async function saveDictionary(filename, dictionary) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, dictionary, { flag: 'wx' });
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function normalizeOptions({
  input, test, dcbFilename, dictionarySource,
  dictionaryFilename, quality = 11, autoUpdate,
} = {}) {
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
  if (dictionarySource !== undefined && (typeof dictionarySource !== 'string' || !dictionarySource.trim())) {
    throw new TypeError(`${PLUGIN_NAME}: dictionarySource must be a non-empty file path.`);
  }
  if (!Number.isInteger(quality) || quality < 0 || quality > 11) {
    throw new RangeError(`${PLUGIN_NAME}: quality must be an integer from 0 to 11.`);
  }
  if (dictionaryFilename !== undefined) {
    throw new TypeError(`${PLUGIN_NAME}: dictionaryFilename has been removed; the output name is derived automatically from dictionarySource and the dictionary hash.`);
  }
  if (autoUpdate !== undefined) {
    if (!autoUpdate || typeof autoUpdate !== 'object' || Array.isArray(autoUpdate)) {
      throw new TypeError(`${PLUGIN_NAME}: autoUpdate must be an object with an optional minSavings.`);
    }
    if ('cachePath' in autoUpdate) {
      throw new TypeError(`${PLUGIN_NAME}: autoUpdate.cachePath has been removed; use dictionarySource as the persistent dictionary path.`);
    }
    if (dictionarySource === undefined) {
      throw new TypeError(`${PLUGIN_NAME}: autoUpdate requires dictionarySource as the persistent dictionary path.`);
    }
    const minSavings = autoUpdate.minSavings === undefined ? 0.9 : autoUpdate.minSavings;
    if (!Number.isFinite(minSavings) || minSavings < 0 || minSavings > 1) {
      throw new RangeError(`${PLUGIN_NAME}: autoUpdate.minSavings must be a number from 0 to 1.`);
    }
    autoUpdate = { minSavings };
  }

  return {
    input,
    test: test instanceof RegExp ? new RegExp(test.source, test.flags) : test,
    dcbFilename,
    dictionarySource,
    quality,
    autoUpdate,
  };
}

/** Compress exact resource bytes and describe their dictionary without publishing build state. */
function compressResource({ name, content, snapshot, dictionaryPrefix = '', quality = 11, autoUpdate }) {
  let dictionary = snapshot === undefined ? content : snapshot;
  validateDictionary(dictionary, name);
  const compress = () => Buffer.from(brotli.compress(content, { quality, customDictionary: dictionary }));
  let compressed = compress();
  if (autoUpdate) {
    const previousSavings = content.length ? 1 - (MAGIC.length + 32 + compressed.length) / content.length : undefined;
    // An empty resource has no meaningful saving ratio and cannot seed a dictionary.
    if (previousSavings !== undefined && previousSavings < autoUpdate.minSavings && !dictionary.equals(content)) {
      validateDictionary(content, name);
      dictionary = content;
      compressed = compress();
    }
  }

  const hash = createHash('sha256').update(dictionary).digest();
  const sha256Base64 = hash.toString('base64');
  return {
    dictionary,
    dictionaryName: `dictionaries/${dictionaryPrefix}${hash.toString('hex')}.dat`,
    dcb: Buffer.concat([MAGIC, hash, compressed]),
    manifestEntry: { sha256Base64, availableDictionary: `:${sha256Base64}:` },
    changed: snapshot === undefined || !snapshot.equals(dictionary),
    action: snapshot === undefined ? 'created' : dictionary === snapshot ? 'reused' : 'updated',
    saving: content.length
      ? `${((1 - (MAGIC.length + 32 + compressed.length) / content.length) * 100).toFixed(2)}%`
      : 'n/a (empty input)',
  };
}

function serializeManifest(entries) {
  const dictionaries = Object.fromEntries([...entries.entries()]
    .sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0));
  return Buffer.from(`${JSON.stringify({ dictionaries }, null, 2)}\n`);
}

module.exports = {
  PLUGIN_NAME,
  MAGIC,
  MAX_DICTIONARY_BYTES,
  MANIFEST_FILENAME,
  pathKey,
  validateOutputName,
  validateDictionary,
  saveDictionary,
  normalizeOptions,
  compressResource,
  serializeManifest,
};
