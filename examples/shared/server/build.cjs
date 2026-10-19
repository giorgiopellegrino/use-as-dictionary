const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { encodeBody } = require('./negotiation.cjs');

const MANIFEST_NAME = 'dist/compression-dictionary-manifest.json';
const MANIFEST_URL = `/${MANIFEST_NAME}`;
const DICTIONARY_MATCH = '/dist/styles.*.css';
const DCB_MAGIC = Buffer.from([0xff, 0x44, 0x43, 0x42]);

async function readOptional(filename) {
  try {
    return await fs.readFile(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function describeAsset(rootDir, name) {
  const content = await readOptional(path.join(rootDir, name));
  if (!content) return undefined;
  return {
    url: `/${name.split('/').map(encodeURIComponent).join('/')}`,
    bytes: content.length,
    content,
  };
}

async function describeDcb(filename) {
  const content = await readOptional(filename);
  if (!content || content.length <= 36 || !content.subarray(0, 4).equals(DCB_MAGIC)) return undefined;
  return { content, bytes: content.length, sha256Base64: content.subarray(4, 36).toString('base64') };
}

// The production manifest owns dictionary identities. Resource associations come
// from the digest in each DCB header, since the manifest does not map CSS assets.
async function loadBuild(rootDir) {
  const manifestBytes = await fs.readFile(path.join(rootDir, MANIFEST_NAME));
  const manifest = JSON.parse(manifestBytes);
  if (!manifest.dictionaries || typeof manifest.dictionaries !== 'object' || Array.isArray(manifest.dictionaries)) {
    throw new Error('Production manifest is missing dictionaries.');
  }
  const dictionaries = (await Promise.all(Object.entries(manifest.dictionaries).map(async ([name, entry]) => {
    if (!/^dictionaries\/[^/\\\x00-\x1f?#:]+\.dat$/.test(name)
      || !entry || !/^[A-Za-z0-9+/]{43}=$/.test(entry.sha256Base64)) {
      throw new Error(`Invalid entry in the production manifest: ${name}`);
    }
    const asset = await describeAsset(rootDir, name);
    if (!asset) return undefined;
    const hash = createHash('sha256').update(asset.content).digest();
    // A partial deployment must never advertise an unavailable/wrong dictionary.
    if (hash.toString('base64') !== entry.sha256Base64) return undefined;
    return {
      ...asset,
      sha256Base64: entry.sha256Base64,
      availableDictionary: `:${entry.sha256Base64}:`,
      id: `styles-${hash.toString('hex').slice(0, 16)}`,
      match: DICTIONARY_MATCH,
    };
  }))).filter(Boolean);
  const byHash = new Map(dictionaries.map((dictionary) => [dictionary.sha256Base64, dictionary]));
  const files = (await fs.readdir(path.join(rootDir, 'dist'))).sort();
  const resources = (await Promise.all(files.filter((name) => /^styles\.[A-Za-z0-9_-]+\.css$/.test(name)).map(async (name) => {
    const assetName = `dist/${name}`;
    const [asset, dcb] = await Promise.all([
      describeAsset(rootDir, assetName), describeDcb(path.join(rootDir, `${assetName}.dcb`)),
    ]);
    if (!asset) return undefined;
    const dictionary = dcb && byHash.get(dcb.sha256Base64);
    return {
      ...asset,
      dcbBytes: dcb?.bytes ?? null,
      dcbContent: dictionary ? dcb.content : undefined,
      dictionaryUrl: dictionary?.url ?? null,
    };
  }))).filter(Boolean);
  const scripts = (await Promise.all(files.filter((name) => /^app\.[A-Za-z0-9_-]+\.js$/.test(name))
    .map((name) => describeAsset(rootDir, `dist/${name}`)))).filter(Boolean);
  return { manifestBytes, dictionaries, resources, scripts };
}

function measureAsset({ content, dcbContent, ...asset }) {
  return {
    ...asset,
    brotliBytes: encodeBody(content, 'br').length,
    gzipBytes: encodeBody(content, 'gzip').length,
  };
}

function demoMetrics(build) {
  const dictionary = build.dictionaries.find((item) => item.url === build.resources[0]?.dictionaryUrl);
  return {
    manifestUrl: MANIFEST_URL,
    dictionary: dictionary ? measureAsset(dictionary) : null,
    resources: build.resources.map(measureAsset),
  };
}

function renderHtml(template, dictionaries) {
  const links = dictionaries.map(({ url }) => `<link rel="compression-dictionary" href="${url}">`).join('');
  if (!/<head(?:\s[^>]*)?>/i.test(template)) throw new Error('Demo HTML is missing a head element.');
  return template.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${links}`);
}

module.exports = { MANIFEST_NAME, MANIFEST_URL, loadBuild, demoMetrics, renderHtml };
