# Vue + Vite example

This example uses the [`CompressionDictionaryPlugin` Vite class](../../README.md#vite-configuration) to compress a Vue application's CSS with Compression Dictionary Transport. It imports `use-as-dictionary/vite` through the repository's npm workspace dependency.

The example uses Vite **8** and shares its [Vue interface](../shared/ui) and [HTTP server](../shared/server/index.cjs) with the [Webpack example](../vue-webpack/README.md). Each workspace has its own entry point, build output, and persistent dictionary cache.

## Run the example

Use Node.js **22.12 or later**. From the repository root:

```sh
npm ci
npm run start:vite
```

Open **http://localhost:8080** in a browser supporting Compression Dictionary Transport. The page also works with fallback compression when DCB is unavailable. The command builds the app with Vite and starts the shared Node server.

This example is the `@use-as-dictionary/example-vue-vite` workspace. From the root, you can also run:

```sh
npm run build --workspace=@use-as-dictionary/example-vue-vite
npm run serve --workspace=@use-as-dictionary/example-vue-vite
```

After installing dependencies from the root, `npm run build`, `npm run serve`, and `npm start` also work inside `examples/vue-vite/`. The workspace's `serve` script runs `node ../shared/server/index.cjs`; its working directory selects this example's `build/` output.

The Webpack example uses the same default port. Stop it before starting this example, or set a different `PORT`.

## Vite configuration and build output

[vite.config.js](vite.config.js) adds the Vue plugin and the dictionary adapter. The dictionary options follow this form:

```js
import CompressionDictionaryPlugin from 'use-as-dictionary/vite';

new CompressionDictionaryPlugin({
  test: /^dist\/styles\.[A-Za-z0-9_-]+\.css$/,
  dictionarySource: '.dictionary-cache/styles.dat',
  autoUpdate: { minSavings: 0.9 },
});
```

Relative paths resolve against Vite's `root`. The example disables CSS code splitting so the selector matches one final CSS resource, and sets the output names expected by the shared server. The adapter processes final assets during `generateBundle`, after CSS minification and content hashing. It preserves the original CSS and emits its DCB representation beside it.

When extending the configuration, place every dictionary adapter after plugins that modify final assets in `generateBundle`. With `autoUpdate`, the last adapter must also follow other plugins whose `writeBundle` hook uses `order: 'post'`; incompatible ordering fails the build. Move such plugins from `output.plugins` into Vite's `plugins` array before the adapter.

Paths below are relative to `examples/vue-vite/`:

```text
.dictionary-cache/
  styles.dat
build/
  index.html
  dictionaries/
    styles.<sha256>.dat
    compression-dictionary-manifest.json
  dist/
    app.<hash>.js
    styles.<hash>.css
    styles.<hash>.css.dcb
```

The adapter applies only to `vite build`. Vite's development server does not generate dictionaries or handle dictionary discovery and HTTP negotiation. This example uses completed builds and the shared Node server for the transfer demonstration.

Only one directory output is supported. Multiple outputs and `output.file` are rejected; library builds must choose one output format. `autoUpdate` is incompatible with `build.watch`. To update the demo after editing its sources, run `npm run build:vite` from the root and refresh the browser after the build finishes.

## Persistent dictionary

Builds reuse the versioned dictionary while `1 - dcb.length / css.length` remains at least `0.9`. Below that threshold, the current CSS becomes the new dictionary. If the dictionary file is missing, the build creates it from the current CSS.

The measurement includes the 36-byte DCB header and compares DCB with minified, uncompressed CSS. It excludes the initial dictionary download and does not compare DCB with ordinary Brotli. The threshold triggers replacement; small resources may still fall short after replacement.

`examples/vue-vite/.dictionary-cache/styles.dat` is versioned in Git so developers and CI checkouts reuse the same saved dictionary. When `autoUpdate` creates or replaces it, commit the updated file together with the related source changes. It is kept outside `build/` so Vite's output cleanup does not delete it; do not delete it as disposable cache. `.gitattributes` preserves its exact bytes across platforms.

The persistent file is written atomically after successful asset generation and output writing. Failures during generation or output writing and builds using `build.write: false` leave it unchanged; unchanged dictionary bytes are not rewritten. A later plugin's `closeBundle` cleanup error cannot undo a dictionary already saved.

Edit [the shared stylesheet](../shared/ui/styles.css) and rebuild while retaining the cache to observe reuse or replacement. The same source is used by the Webpack example, which maintains a separate dictionary cache.

## Discovery, negotiation, and measurements

The public manifest is `/dictionaries/compression-dictionary-manifest.json`. Its dictionary identities and the digest in each `.dcb` header let the server associate the CSS with its dictionary and verify the published `.dat` bytes. The [root documentation](../../README.md#manifest-and-dcb-format) describes the format shared by both adapters.

The server inserts `<link rel="compression-dictionary">` into the HTML head, sets the corresponding `Link` header, and serves the dictionary with `Use-As-Dictionary: match="/dist/styles.*.css"`, an `id`, and an immutable two-week cache policy. Discovery links appear in the HTTP response, rather than in the built HTML file.

CSS retains its original URL. The server sends the `.dcb` representation with `Content-Encoding: dcb` only when `Accept-Encoding` accepts DCB and `Available-Dictionary` matches the dictionary digest for that resource. CSS responses use `Vary: Accept-Encoding, Available-Dictionary`. Otherwise, the server negotiates Brotli, gzip, or identity. Standard Brotli and gzip representations are generated at request time with `node:zlib`; they are not extra build files.

The page reads `/api/demo-stats` for measurements. It shows the CSS, DCB, and ordinary Brotli sizes, including the combined cost of **dictionary in Brotli + CSS in DCB**. The first dictionary contains the entire current CSS, so a small DCB response still carries that initial dictionary-download cost. Evaluate savings across transfers that reuse the dictionary. Measurements exclude HTTP headers and any initial CSS received through fallback negotiation.

To inspect a transfer, open DevTools **Network**, leave **Disable cache** unchecked, and click **Test the transfer**. Inspect the CSS request containing `?probe=...`: a DCB transfer includes `dcb` in `Accept-Encoding`, `Available-Dictionary: :<sha256Base64>:`, and a response with `Content-Encoding: dcb`. Repeat after the dictionary download if the browser has not registered it yet. Decoding happens natively in the browser.

## Commands and tests

Run these from the repository root:

```sh
npm run build:vite         # Build the Vite example and create/update its dictionary
npm run serve:vite         # Serve an existing Vite build through the shared Node server
npm run start:vite         # Build and serve the Vite example
npm run test:vite          # Run Vite adapter tests
npm run test:browser:vite  # Build both examples and run the Vite browser project
npm run build:all          # Build the Webpack and Vite examples
npm test                   # Build both examples and run Node tests
npm run test:browser       # Build both examples and run both browser projects
npm run test:package       # Check the package in separate Webpack and Vite consumers
```

Browser tests use an installed Chrome browser by default. Run `npm run test:browser:vite` to select this example. It builds both examples for the two test servers, then runs only the Vite Playwright project. Its test server runs on port `4175`. `npm run test:browser` runs both projects.

To use Playwright's Chromium, run these commands from the repository root in PowerShell:

```powershell
npx playwright install chromium
$env:PLAYWRIGHT_CHANNEL = 'chromium'
npm run test:browser:vite
```

`PLAYWRIGHT_CHANNEL` also accepts `chrome` and `msedge` when installed. Browser tests verify native CSS transfer, decoding, and application using the built Vite output.

## Remote deployment

Use HTTPS on a remote domain. The shared server accepts both `TLS_CERT` and `TLS_KEY` paths to enable HTTPS; `HOST` and `PORT` override `localhost:8080`.

Publish the manifest, dictionary, and DCB representation together and retain immutable URLs for their cache lifetime. Configure your origin/CDN with the same dictionary-hash checks and encoding negotiation as the shared server. Local build output replacement is not atomic, so requests during a rebuild may fail.

## License

[MIT](../../LICENSE).
