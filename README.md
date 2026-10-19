# use-as-dictionary

A **Webpack 5 plugin** that generates compression dictionaries and Shared Brotli (`dcb`) representations for Compression Dictionary Transport.

`CompressionDictionaryPlugin` reads final Webpack assets after minification and content hashing, then emits raw dictionaries, compressed representations, and a dictionary manifest. It can preserve a dictionary between builds and replace it when compression savings fall below a configured threshold.

The plugin works independently of Vue. The [Vue + Webpack example](examples/vue-webpack/README.md) includes a server that implements dictionary discovery, HTTP negotiation, and fallback compression.

## Requirements and installation

- Node.js **22.12 or later**.
- Webpack **5** in the consuming project.
- A server or CDN configured to serve Compression Dictionary Transport responses; see [HTTP integration](#http-integration).

The repository is prepared for local installation. It has not been published to the npm registry. To create an installable package, run these commands in a checkout:

```sh
npm ci
npm pack
```

Then install the generated tarball in your Webpack project:

```sh
npm install --save-dev /absolute/path/to/use-as-dictionary/use-as-dictionary-1.0.0.tgz "webpack@^5"
```

For local development, you can also install the checkout directly after running `npm ci` there:

```sh
npm install --save-dev /absolute/path/to/use-as-dictionary
```

The package includes the plugin and its documentation. `brotli-wasm-custom-dictionary` is installed as a runtime dependency; Vue and the example server are part of the repository's example workspace.

## Webpack configuration

Add the plugin to your existing Webpack configuration. This example assumes your CSS extraction plugin emits one file matching `dist/styles.<hash>.css`:

```js
const path = require('node:path');
const CompressionDictionaryPlugin = require('use-as-dictionary');

// Add this instance to the plugins array in webpack.config.cjs.
new CompressionDictionaryPlugin({
  test: /^dist\/styles\.[a-f0-9]+\.css$/,
  dictionarySource: path.resolve(__dirname, '.dictionary-cache/styles.dat'),
  autoUpdate: { minSavings: 0.9 },
});
```

With `output.path` set to `build/`, this produces:

```text
build/
├── dictionaries/
│   └── styles.<sha256>.dat
└── dist/
    ├── styles.<contenthash>.css
    ├── styles.<contenthash>.css.dcb
    └── compression-dictionary-manifest.json
```

The original CSS remains available for fallback responses. The `.dcb` file is an alternative representation of that CSS, served at the original CSS URL with `Content-Encoding: dcb`.

For a complete configuration, see [the example's webpack.config.cjs](examples/vue-webpack/webpack.config.cjs).

## Options

Specify exactly one of `test` and `input`.

| Option | Type / default | Behavior |
| --- | --- | --- |
| `test` | `string` or `RegExp` | Selects final emitted asset names relative to `output.path`. A string matches exactly. The build fails if no assets match. Each selected asset produces `<asset-name>.dcb`. |
| `input` | `string` | Reads a ready-to-compress file. Relative paths resolve against Webpack's `context`. Loaders and minification are not applied to this file. |
| `dcbFilename` | `string`, default `<input-basename>.dcb` | Sets the output path in `input` mode. It cannot be used with `test`. |
| `dictionarySource` | `string` | Reads a raw dictionary from an absolute path or a path relative to Webpack's `context`. With `autoUpdate`, this is the persistent file the plugin creates and updates. Without a dictionary source, the resource's own bytes form the dictionary. |
| `autoUpdate` | `{ minSavings?: number }` | Enables dictionary reuse and replacement for a single resource. Requires `dictionarySource`. `minSavings` defaults to `0.9` and must be between `0` and `1`, inclusive. |
| `quality` | integer, default `11` | Brotli quality from `0` through `11`. |

Output paths must be relative asset paths using `/`, without `.` or `..` segments. Dictionaries must contain between **1 and `2**22 - 16` bytes** (4 MiB minus 16 bytes).

Without `autoUpdate`, `dictionarySource` is read without being modified. A `test` selector may then match multiple resources, sharing a fixed dictionary if one is provided. Without a fixed dictionary, each resource supplies its own dictionary.

With `autoUpdate`, each plugin instance must select exactly one resource and have a distinct `dictionarySource`. Use separate instances and selectors for multiple resources. An automatic dictionary cannot overwrite an input file or another instance's fixed dictionary.

The published dictionary filename is `dictionaries/<source-name>.<sha256>.dat`, where `<source-name>` is the basename of `dictionarySource` without its extension. Without `dictionarySource`, the filename is `dictionaries/<sha256>.dat`. The hash is the full SHA-256 digest of the raw dictionary bytes.

### Compressing an existing file

Use `input` when another build step has already prepared the resource:

```js
new CompressionDictionaryPlugin({
  input: 'prepared/site.css',
  dcbFilename: 'dist/site.css.dcb',
  dictionarySource: '.dictionary-cache/site.dat',
  autoUpdate: { minSavings: 0.9 },
});
```

In this mode, the plugin emits the dictionary, DCB representation, and manifest. Your build or server must make the original input available for fallback responses.

## Persistent dictionaries

Keep `dictionarySource` **outside `output.path`** so that Webpack's `output.clean` does not delete it. The plugin enforces this when `autoUpdate` is enabled.

1. If the persistent file is missing, the current resource becomes the first dictionary.
2. On later builds, the plugin compresses the resource using the saved dictionary.
3. It calculates `1 - dcb.length / resource.length`, including the 36-byte DCB header. If the saving is below `minSavings`, it replaces the dictionary with the current resource and recompresses it.

The persistent file is written atomically after a successful build. Unchanged dictionary bytes are not rewritten. A reused dictionary retains the same public URL because the filename contains its content hash.

Preserve the dictionary cache between builds, including in CI. The example stores it in `examples/vue-webpack/.dictionary-cache/styles.dat`, outside `examples/vue-webpack/build/`, and excludes it from Git. Editing the example's `src/styles.css` while retaining this cache lets you observe reuse or replacement.

The threshold compares DCB with **uncompressed resource bytes**, not standard Brotli, and excludes the initial dictionary download. It is a replacement trigger, not a guarantee: the DCB header can prevent small resources from reaching the threshold even with a fresh dictionary.

## Manifest and DCB format

All plugin instances in a compilation contribute to `dist/compression-dictionary-manifest.json`:

```json
{
  "dictionaries": {
    "dictionaries/styles.<sha256>.dat": {
      "sha256Base64": "...=",
      "availableDictionary": ":...=:"
    }
  }
}
```

Keys are paths relative to `output.path`. `sha256Base64` is the SHA-256 digest of the raw dictionary bytes, encoded as Base64. `availableDictionary` wraps that same value in colons for comparison with the request header. The manifest lists dictionary identities; it does not map resources to dictionaries.

Each `.dcb` starts with the four magic bytes `ff 44 43 42`, followed by the dictionary's 32-byte SHA-256 digest and the Shared Brotli stream. A server can match that digest to the manifest entry and verify the published `.dat` bytes before advertising or serving the representation. The manifest path is reserved by the plugin.

## HTTP integration

The plugin generates build assets. To transfer them to a browser, configure your server or CDN to:

1. Advertise the dictionary, for example with a `<link rel="compression-dictionary">` in the document head and a corresponding `Link` response header.
2. Serve the dictionary with a `Use-As-Dictionary` header whose `match` pattern covers the resource URLs that use it.
3. Serve a resource's `.dcb` bytes only when `Accept-Encoding` accepts `dcb` and `Available-Dictionary` matches the SHA-256 digest of that resource's dictionary. A dictionary ID does not replace the hash check.
4. Return `Content-Encoding: dcb` and the resource's original content type at its original URL. Vary resource responses on both `Accept-Encoding` and `Available-Dictionary`.
5. Negotiate ordinary Brotli, gzip, or identity when DCB is unavailable or unacceptable.

Use HTTPS for a remote deployment and a browser supporting Compression Dictionary Transport. Publish the manifest, dictionaries, and DCB representations together, and retain immutable asset URLs for the lifetime of their caches.

The [example server](examples/vue-webpack/server/index.cjs) demonstrates these steps. It reads the manifest and verifies dictionary hashes on each request, derives resource associations from DCB headers, and injects discovery links before compressing the HTML. Its standard Brotli and gzip responses are generated at runtime using `node:zlib`; the plugin does not emit `.br` or `.gz` files.

## Evaluating savings

An automatically created dictionary contains the entire selected resource. A small DCB representation therefore comes with an initial dictionary download. Evaluate both the first visit and later transfers that reuse a cached dictionary, and compare the result with ordinary Brotli compression.

The example displays the uncompressed CSS size, DCB size, ordinary Brotli size, and the combined cost of a Brotli-compressed dictionary plus DCB CSS. These figures exclude HTTP headers and any initial CSS response received through fallback negotiation.

## Development

Run commands from the repository root:

```sh
npm ci
npm start
```

Open **http://localhost:8080**. `npm start` builds and serves the example workspace, which imports `use-as-dictionary` from this repository.

| Command | Purpose |
| --- | --- |
| `npm run build` | Build the example and create or update its dictionary. |
| `npm run build:watch` | Rebuild the example when source files change. |
| `npm run serve` | Serve an existing example build. |
| `npm start` | Build and serve the example. |
| `npm test` | Build the example and run the Node test suite. |
| `npm run test:plugin` | Run the plugin's Node tests. |
| `npm run test:browser` | Build the example and test native browser transfer and CSS decoding. Requires Chrome by default; see the [example instructions](examples/vue-webpack/README.md#browser-tests). |
| `npm run test:package` | Install the tarball in an external consumer, check CommonJS and ESM imports, and build and decode a DCB representation. |

```text
use-as-dictionary/
├── src/CompressionDictionaryPlugin.cjs
├── examples/vue-webpack/   # Vue app, Webpack config, and HTTP server
├── test/                  # Plugin, integration, and browser tests
├── scripts/check-package.cjs
├── package.json
├── README.md
└── LICENSE
```

The root package retains `"private": true` to prevent npm registry publication. This does not prevent publishing the repository on GitHub or creating a local tarball with `npm pack`.

## License

[MIT](LICENSE).
