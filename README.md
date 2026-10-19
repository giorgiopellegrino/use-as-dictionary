# use-as-dictionary

A plugin for **Webpack 5 and Vite 8** that generates compression dictionaries and Shared Brotli (`dcb`) representations for Compression Dictionary Transport.

Both adapters read final build assets after minification and content hashing, then use the same compression core to emit raw dictionaries, compressed representations, and a dictionary manifest. They can preserve a dictionary between builds and replace it when compression savings fall below a configured threshold.

The plugin works independently of Vue. The [Vue + Webpack](examples/vue-webpack/README.md) and [Vue + Vite](examples/vue-vite/README.md) examples share a Vue interface and an HTTP server that implements dictionary discovery, encoding negotiation, and fallback compression.

## Requirements and installation

- Node.js **22.12 or later**.
- Webpack **5** or Vite **8** in the consuming project.
- A server or CDN configured to serve Compression Dictionary Transport responses; see [HTTP integration](#http-integration).

The repository is prepared for local installation. It has not been published to the npm registry. To create an installable package, run these commands in a checkout:

```sh
npm ci
npm pack
```

Install the generated tarball with the bundler your project uses. For Webpack:

```sh
npm install --save-dev /absolute/path/to/use-as-dictionary/use-as-dictionary-1.0.0.tgz "webpack@^5"
```

For Vite:

```sh
npm install --save-dev /absolute/path/to/use-as-dictionary/use-as-dictionary-1.0.0.tgz "vite@^8"
```

Webpack and Vite are optional peer dependencies. Install your chosen bundler; neither adapter requires the other bundler to be installed.

For local development, you can also install the checkout directly after running `npm ci` there:

```sh
npm install --save-dev /absolute/path/to/use-as-dictionary
```

The package includes both adapters, their shared compression core, and the documentation. `brotli-wasm-custom-dictionary` is installed as a runtime dependency; Vue and the example server belong to the repository's examples.

| Import | Export |
| --- | --- |
| `use-as-dictionary/webpack` | The `CompressionDictionaryPlugin` class for Webpack. |
| `use-as-dictionary/vite` | The `CompressionDictionaryPlugin` class for Vite. |

Import the class for your bundler and create a plugin with `new CompressionDictionaryPlugin(options)`.

## Webpack configuration

Add the plugin to your existing Webpack configuration. This example assumes your CSS extraction plugin emits one file matching `dist/styles.<hash>.css`:

```js
const path = require('node:path');
const CompressionDictionaryPlugin = require('use-as-dictionary/webpack');

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

## Vite configuration

Import the Vite adapter and add it to your `vite.config.mjs`:

```js
import { defineConfig } from 'vite';
import CompressionDictionaryPlugin from 'use-as-dictionary/vite';

export default defineConfig({
  plugins: [
    new CompressionDictionaryPlugin({
      test: /\.css$/,
      dictionarySource: '.dictionary-cache/styles.dat',
      autoUpdate: { minSavings: 0.9 },
    }),
  ],
  build: {
    cssCodeSplit: false,
  },
});
```

This configuration combines CSS into one asset so the automatic dictionary has one resource to track. Adapt the selector if your build emits different assets. The adapter runs during `vite build`, processes final assets in `generateBundle`, and preserves their original filenames. Each selected resource gets a `.dcb` representation beside it; the dictionary and manifest have the same format as the Webpack output.

Place every `CompressionDictionaryPlugin` instance after plugins that modify final assets in `generateBundle`. With `autoUpdate`, the last adapter instance must also follow other plugins with `writeBundle` hooks using `order: 'post'`; incompatible ordering fails the build. Move any such plugins from `output.plugins` into Vite's `plugins` array before the adapter.

The adapter applies only to builds. Vite's development server does not generate dictionaries or implement discovery and HTTP negotiation. The [Vite example](examples/vue-vite/README.md) builds the app and serves it through the shared Node server. Its [vite.config.js](examples/vue-vite/vite.config.js) places the CSS and JavaScript under `dist/` for that server.

Vite builds must use one directory output. Multiple outputs and `output.file` are unsupported; library builds must select one output format. `autoUpdate` cannot be combined with `build.watch`. Run completed builds to update persistent dictionaries. With `build.write: false`, compressed assets can be generated in memory, but the persistent dictionary is not written.

## Options

Both adapters accept the same options. Specify exactly one of `test` and `input`. Relative input and dictionary paths resolve against Webpack's `context` or Vite's `root`.

| Option | Type / default | Behavior |
| --- | --- | --- |
| `test` | `string` or `RegExp` | Selects final emitted asset names relative to the output directory. A string matches exactly. The build fails if no assets match. Each selected asset produces `<asset-name>.dcb`. |
| `input` | `string` | Reads a ready-to-compress file. Loaders, transforms, and minification are not applied to this file. |
| `dcbFilename` | `string`, default `<input-basename>.dcb` | Sets the output path in `input` mode. It cannot be used with `test`. |
| `dictionarySource` | `string` | Reads a raw dictionary from an absolute path or a path relative to the bundler's project root described above. With `autoUpdate`, this is the persistent file the plugin creates and updates. Without a dictionary source, the resource's own bytes form the dictionary. |
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

The same constructor options work with either bundler entry point.

## Persistent dictionaries

Keep `dictionarySource` **outside the build output directory** so that Webpack's `output.clean` or Vite's `emptyOutDir` does not delete it. Both adapters enforce this when `autoUpdate` is enabled.

1. If the persistent file is missing, the current resource becomes the first dictionary.
2. On later builds, the plugin compresses the resource using the saved dictionary.
3. It calculates `1 - dcb.length / resource.length`, including the 36-byte DCB header. If the saving is below `minSavings`, it replaces the dictionary with the current resource and recompresses it.

The persistent file is written atomically after successful asset generation and output writing. Failures during generation or output writing leave it unchanged, as do Vite builds with `build.write: false`. Errors in later Vite plugins' `closeBundle` cleanup cannot undo an already saved dictionary. Unchanged dictionary bytes are not rewritten. A reused dictionary retains the same public URL because the filename contains its content hash.

Preserve the dictionary cache between builds, including in CI. Each example stores its own `.dictionary-cache/styles.dat` outside its `build/` directory and excludes the cache from Git. Editing [examples/shared/ui/styles.css](examples/shared/ui/styles.css) while retaining the caches lets you observe reuse or replacement with either bundler.

The threshold compares DCB with **uncompressed resource bytes**, not standard Brotli, and excludes the initial dictionary download. It is a replacement trigger, not a guarantee: the DCB header can prevent small resources from reaching the threshold even with a fresh dictionary.

## Manifest and DCB format

All plugin instances in a build contribute to `dist/compression-dictionary-manifest.json`:

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

Keys are paths relative to the output directory. `sha256Base64` is the SHA-256 digest of the raw dictionary bytes, encoded as Base64. `availableDictionary` wraps that same value in colons for comparison with the request header. The manifest lists dictionary identities; it does not map resources to dictionaries.

Each `.dcb` starts with the four magic bytes `ff 44 43 42`, followed by the dictionary's 32-byte SHA-256 digest and the Shared Brotli stream. A server can match that digest to the manifest entry and verify the published `.dat` bytes before advertising or serving the representation. The manifest path is reserved by the plugin.

## HTTP integration

The plugin generates build assets. To transfer them to a browser, configure your server or CDN to:

1. Advertise the dictionary, for example with a `<link rel="compression-dictionary">` in the document head and a corresponding `Link` response header.
2. Serve the dictionary with a `Use-As-Dictionary` header whose `match` pattern covers the resource URLs that use it.
3. Serve a resource's `.dcb` bytes only when `Accept-Encoding` accepts `dcb` and `Available-Dictionary` matches the SHA-256 digest of that resource's dictionary. A dictionary ID does not replace the hash check.
4. Return `Content-Encoding: dcb` and the resource's original content type at its original URL. Vary resource responses on both `Accept-Encoding` and `Available-Dictionary`.
5. Negotiate ordinary Brotli, gzip, or identity when DCB is unavailable or unacceptable.

Use HTTPS for a remote deployment and a browser supporting Compression Dictionary Transport. Publish the manifest, dictionaries, and DCB representations together, and retain immutable asset URLs for the lifetime of their caches.

The [shared example server](examples/shared/server/index.cjs) demonstrates these steps for both bundlers. It reads the manifest and verifies dictionary hashes on each request, derives resource associations from DCB headers, and injects discovery links before compressing the HTML. Its standard Brotli and gzip responses are generated at runtime using `node:zlib`; the plugin does not emit `.br` or `.gz` files.

## Evaluating savings

An automatically created dictionary contains the entire selected resource. A small DCB representation therefore comes with an initial dictionary download. Evaluate both the first visit and later transfers that reuse a cached dictionary, and compare the result with ordinary Brotli compression.

Both examples display the uncompressed CSS size, DCB size, ordinary Brotli size, and the combined cost of a Brotli-compressed dictionary plus DCB CSS. These figures exclude HTTP headers and any initial CSS response received through fallback negotiation.

## Development

Run commands from the repository root:

```sh
npm ci
```

Run `npm run start:webpack` or `npm run start:vite`, then open **http://localhost:8080**. Both examples use the same port by default and import the plugin through their local workspace dependency.

| Action | Webpack | Vite |
| --- | --- | --- |
| Build the example and create or update its dictionary | `npm run build:webpack` | `npm run build:vite` |
| Serve an existing build through the shared Node server | `npm run serve:webpack` | `npm run serve:vite` |
| Build and serve the example | `npm run start:webpack` | `npm run start:vite` |
| Run the adapter's Node tests | `npm run test:webpack` | `npm run test:vite` |
| Run the example's browser tests | `npm run test:browser:webpack` | `npm run test:browser:vite` |
| Rebuild when source files change | `npm run build:watch:webpack` | Unsupported with `autoUpdate` |

Each browser command in this table builds both examples for the two test servers, then runs only the selected Playwright project. Browser tests require Chrome by default; see the [example instructions](examples/vue-webpack/README.md#browser-tests).

These commands cover both bundlers:

| Command | Purpose |
| --- | --- |
| `npm run build:all` | Build both examples. |
| `npm test` | Build both examples and run the Node test suite. |
| `npm run test:browser` | Build both examples and test native browser transfer and CSS decoding in both Playwright projects. |
| `npm run test:package` | Install the tarball in separate external Webpack and Vite consumers, check imports, and build and decode DCB representations. Each consumer installs only its own bundler. |

```text
use-as-dictionary/
├── src/
│   ├── core.cjs
│   ├── webpack.cjs
│   └── vite.cjs
├── examples/
│   ├── shared/             # Vue interface and HTTP server
│   ├── vue-webpack/        # Webpack config and entry point
│   └── vue-vite/           # Vite config and entry point
├── test/                   # Adapter, integration, and browser tests
├── scripts/check-package.cjs
├── package.json
├── README.md
└── LICENSE
```

The root package retains `"private": true` to prevent npm registry publication. This does not prevent publishing the repository on GitHub or creating a local tarball with `npm pack`.

## License

[MIT](LICENSE).
