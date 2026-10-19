# Vue + Webpack example

This example uses [`CompressionDictionaryPlugin`](../../README.md) to compress a Vue application's CSS with Compression Dictionary Transport. It imports the plugin as `require('use-as-dictionary')` through the repository's npm workspace dependency.

The build emits dictionary assets and a manifest. The [shared HTTP server](../shared/server/index.cjs) uses those assets for dictionary discovery, encoding negotiation, and standard Brotli/gzip fallback responses. This example and the [Vite example](../vue-vite/README.md) use the same Vue interface and server.

## Run the example

Use Node.js **22.12 or later**. From the repository root:

```sh
npm ci
npm start
```

Open **http://localhost:8080** in a browser supporting Compression Dictionary Transport. The page also works with fallback compression when DCB is unavailable. `npm start` builds the example and starts its server.

The example is the `@use-as-dictionary/example-vue-webpack` workspace. Root scripts delegate build and server commands to it. For example, from the root:

```sh
npm run build --workspace=@use-as-dictionary/example-vue-webpack
npm run serve --workspace=@use-as-dictionary/example-vue-webpack
```

You can also run `npm run build`, `npm run serve`, or `npm start` inside `examples/vue-webpack/` after installing dependencies from the root.

The Vue component and stylesheet live in [examples/shared/ui](../shared/ui). This workspace keeps its own [src/main.js](src/main.js), Webpack configuration, build directory, and dictionary cache. Its `serve` script runs `node ../shared/server/index.cjs` from the workspace directory, which selects this example's `build/` output.

## Build and dictionary persistence

[webpack.config.cjs](webpack.config.cjs) selects the minified CSS emitted by Webpack:

```js
const path = require('node:path');
const CompressionDictionaryPlugin = require('use-as-dictionary');

new CompressionDictionaryPlugin({
  test: /^dist\/styles\.[a-f0-9]+\.css$/,
  dictionarySource: path.resolve(__dirname, '.dictionary-cache/styles.dat'),
  autoUpdate: { minSavings: 0.9 },
});
```

When the cache is missing, the current CSS becomes the first dictionary. Later builds reuse it while `1 - dcb.length / css.length` is at least `0.9`. Below that threshold, the plugin uses the new CSS as the dictionary and updates the persistent file after a successful build.

This measurement includes the 36-byte DCB header and compares DCB with minified, uncompressed CSS. It excludes the initial dictionary download and does not compare DCB with ordinary Brotli.

Preserve `examples/vue-webpack/.dictionary-cache/styles.dat` between builds, including in CI. It is excluded from Git and sits outside `build/`, so cleaning the Webpack output does not remove it. To try reuse, edit [the shared stylesheet](../shared/ui/styles.css) and rebuild without deleting the cache.

Paths below are relative to `examples/vue-webpack/`:

```text
.dictionary-cache/
  styles.dat
build/
  index.html
  dictionaries/styles.<sha256>.dat
  dist/
    app.<contenthash>.js
    styles.<contenthash>.css
    styles.<contenthash>.css.dcb
    compression-dictionary-manifest.json
```

The plugin generates `.dat`, `.dcb`, and the manifest. The server generates ordinary Brotli and gzip representations at request time with `node:zlib`; there are no `.br` or `.gz` build files. The CSS retains its original URL, and the server selects its representation.

## Manifest and discovery

The public manifest is available at `/dist/compression-dictionary-manifest.json`:

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

The server reads the manifest on each request and checks the published dictionaries against their SHA-256 digests. The manifest lists dictionaries; the CSS association comes from the 32-byte digest in each `.dcb` header, matched against `sha256Base64`.

When serving HTML, the server inserts `<link rel="compression-dictionary">` into the head before the stylesheet and also sets a `Link` response header. The link is present in the HTTP response rather than the generated `build/index.html`. HTML compression happens after insertion.

The dictionary response includes `Use-As-Dictionary: match="/dist/styles.*.css"`, an `id`, and an immutable two-week cache policy. The server sends DCB only when the browser accepts it and `Available-Dictionary` matches the digest of the dictionary used by that CSS resource. Otherwise, it negotiates Brotli, gzip, or identity. CSS responses use `Vary: Accept-Encoding, Available-Dictionary`; a dictionary ID does not replace the hash comparison.

See [the shared server's build.cjs](../shared/server/build.cjs) for manifest loading and resource association, [negotiation.cjs](../shared/server/negotiation.cjs) for encoding selection, and [index.cjs](../shared/server/index.cjs) for HTTP responses.

## Measurements and manual browser check

The page reads `/api/demo-stats`, which reports the CSS size, the build's DCB size, and ordinary compressed sizes calculated by the server. This endpoint only supplies measurements. The **Open the production manifest** link opens the actual manifest used for discovery and negotiation.

The initial dictionary contains the entire current CSS. A very small DCB response does not eliminate that initial download: the page also shows the combined cost of **dictionary in Brotli + CSS in DCB**. Assess savings across transfers that reuse the dictionary. Measurements exclude HTTP headers and any initial CSS received as a fallback response.

To inspect a transfer:

1. Open DevTools and select **Network**. Leave **Disable cache** unchecked so the browser can retain the dictionary.
2. Click **Test the transfer** on the page.
3. Inspect the CSS request containing `?probe=...`. A DCB transfer has `dcb` in `Accept-Encoding`, `Available-Dictionary: :<sha256Base64>:`, and a response with `Content-Encoding: dcb`.

The browser negotiates and decodes the response natively. If it has not registered the dictionary yet, repeat the test after the dictionary download completes.

## Commands

Run these from the repository root:

```sh
npm run build          # Build the Webpack example and create/update its dictionary
npm run build:watch    # Watch example sources and rebuild with Webpack
npm run serve          # Serve the existing Webpack build
npm start              # Build and serve the Webpack example
npm test               # Build both examples and run Node tests
npm run test:plugin    # Run Webpack adapter tests
npm run test:browser   # Build both examples and run both browser projects
npm run test:package   # Check the package in separate Webpack and Vite consumers
```

For development, run `npm run build:watch` and `npm run serve` in separate terminals. Refresh the page after a build finishes. Local output replacement is not atomic, so requests during a rebuild may fail.

### Browser tests

The Node tests verify the DCB format, manifest, discovery, and HTTP negotiation. Browser tests additionally verify native CSS decoding and application for the Webpack and Vite builds. To select just this example, run `npm run test:browser -- --project=webpack` from the root.

`npm run test:browser` uses an installed Chrome browser by default. To use Playwright's Chromium, run these commands from the repository root in PowerShell:

```powershell
npx playwright install chromium
$env:PLAYWRIGHT_CHANNEL = 'chromium'
npm run test:browser
```

`PLAYWRIGHT_CHANNEL` also accepts `chrome` and `msedge` when those browsers are installed. The Webpack browser test server runs on port `4174`; the Vite project uses port `4175`.

## Remote deployment

Use HTTPS on a remote domain. The example server accepts `TLS_CERT` and `TLS_KEY` paths for the certificate and key; both must be supplied together. `HOST` and `PORT` override the default `localhost:8080` address.

Publish the manifest, dictionaries, and DCB representations together. Preserve immutable dictionary and resource URLs for their cache lifetime, and configure the origin/CDN to apply the same dictionary-hash checks and encoding negotiation as the example server.

## License

[MIT](../../LICENSE).
