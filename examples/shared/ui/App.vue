<script setup>
import { computed, onMounted, ref } from 'vue';

defineProps({ bundler: { type: String, required: true } });

const metrics = ref(null);
const metricsError = ref('');
const isRunning = ref(false);
const probe = ref(null);
const probeError = ref('');

const resource = computed(() => metrics.value?.resources?.[0]);
const dictionary = computed(() => metrics.value?.dictionary);
const savedBytes = computed(() => {
  if (!resource.value) return 0;
  return resource.value.brotliBytes - resource.value.dcbBytes;
});
const savedPercent = computed(() => {
  if (!resource.value?.brotliBytes) return 0;
  return Math.round((savedBytes.value / resource.value.brotliBytes) * 100);
});
const costWithDictionary = computed(() => {
  if (!dictionary.value || !resource.value) return 0;
  return dictionary.value.brotliBytes + resource.value.dcbBytes;
});
const supportsDcb = computed(() => probe.value?.encoding === 'dcb');
const statusText = computed(() => {
  if (isRunning.value) return 'Test in progress';
  if (probeError.value) return 'Test failed';
  if (supportsDcb.value) return 'DCB received';
  if (probe.value) return 'Fallback received';
  return 'Ready to test';
});

function formatBytes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${new Intl.NumberFormat('en-US').format(value)} B`;
}

function fileName(url) {
  return url?.split('/').at(-1) || '—';
}

function barWidth(value) {
  if (!resource.value?.bytes) return '0%';
  return `${Math.max(2, Math.min(100, (value / resource.value.bytes) * 100))}%`;
}

async function loadMetrics() {
  try {
    const response = await fetch('/api/demo-stats', { cache: 'no-store' });
    if (!response.ok) throw new Error(`The statistics request returned HTTP ${response.status}.`);
    const data = await response.json();
    if (!data.dictionary?.url || !data.resources?.[0]?.url) {
      throw new Error('The statistics are missing the dictionary or CSS resource.');
    }
    metrics.value = data;
  } catch (error) {
    metricsError.value = error.message;
  }
}

async function runProbe() {
  if (!dictionary.value || !resource.value || isRunning.value) return;
  isRunning.value = true;
  probe.value = null;
  probeError.value = '';

  try {
    const dictionaryResponse = await fetch(dictionary.value.url, { cache: 'default' });
    if (!dictionaryResponse.ok) {
      throw new Error(`The dictionary request returned HTTP ${dictionaryResponse.status}.`);
    }
    await dictionaryResponse.arrayBuffer();

    const cssUrl = new URL(resource.value.url, window.location.origin);
    cssUrl.searchParams.set('probe', String(Date.now()));
    // These headers are negotiated by the browser, never by JavaScript:
    // Accept-Encoding, Available-Dictionary and Dictionary-ID.
    const cssResponse = await fetch(cssUrl, { cache: 'no-store' });
    if (!cssResponse.ok) throw new Error(`The CSS request returned HTTP ${cssResponse.status}.`);
    const decodedCss = await cssResponse.text();
    const contentLength = cssResponse.headers.get('content-length');
    probe.value = {
      encoding: cssResponse.headers.get('content-encoding') || 'identity',
      encodedBytes: contentLength === null ? null : Number(contentLength),
      decodedBytes: new TextEncoder().encode(decodedCss).byteLength,
    };
  } catch (error) {
    probeError.value = error.message;
  } finally {
    isRunning.value = false;
  }
}

onMounted(loadMetrics);
</script>

<template>
  <div class="site-shell">
    <header class="site-header">
      <a class="wordmark" href="#" aria-label="Back to top">
        <span class="brand-icon" aria-hidden="true">{ }</span>
        <span>css / <strong>with memory</strong></span>
      </a>
      <span class="stack-label"><span class="status-dot" aria-hidden="true"></span> Vue + {{ bundler }}</span>
    </header>

    <main>
      <section class="hero" aria-labelledby="page-title">
        <div class="hero-copy">
          <p class="eyebrow">Compression Dictionary Transport</p>
          <h1 id="page-title">Your CSS.<br />With less <span>repetition.</span></h1>
          <p class="hero-description">
            The first dictionary is created from the build's CSS.
            The browser can store it, and Brotli can reuse those bytes
            to compress future updates.
          </p>
          <a class="text-link" href="#browser-test">See what your browser receives <span aria-hidden="true">↗</span></a>
        </div>
        <div class="flow-card" aria-label="A persistent dictionary compresses the current build's CSS">
          <div class="flow-card-heading"><span class="file-icon" aria-hidden="true">{ }</span><span>A dictionary to reuse</span></div>
          <div class="flow-line">
            <span class="version-chip">dat</span>
            <div><strong>Shared dictionary</strong><span>Created from CSS, kept across builds</span></div>
            <span class="flow-check" aria-hidden="true">✓</span>
          </div>
          <div class="flow-connector" aria-hidden="true"><span>↓</span><small>reuse what you know</small></div>
          <div class="flow-line flow-line-highlight">
            <span class="version-chip version-chip-dark">css</span>
            <div><strong>Build CSS</strong><span>Compressed with the published dictionary</span></div>
            <code>dcb</code>
          </div>
          <p class="flow-caption">The same final CSS. A more compact representation.</p>
        </div>
      </section>

      <section class="metrics-section" aria-labelledby="metrics-title">
        <div class="section-heading">
          <div><p class="eyebrow">01 / Transfer cost</p><h2 id="metrics-title">Real bytes, from the project.</h2></div>
          <span class="subtle-label">HTTP representation sizes</span>
        </div>
        <p v-if="metricsError" class="notice notice-error" role="alert">
          {{ metricsError }} Build the project and start the demo server.
        </p>
        <div v-else-if="!metrics" class="notice" role="status">Loading measurements…</div>
        <template v-else>
          <div class="metric-grid">
            <article class="metric-card">
              <span class="metric-label">Original CSS</span>
              <strong class="metric-value">{{ formatBytes(resource.bytes) }}</strong>
              <div class="metric-track" aria-hidden="true"><span class="metric-bar bar-original" style="width: 100%"></span></div>
              <p>The file after the {{ bundler }} build.</p>
            </article>
            <article class="metric-card">
              <span class="metric-label">Standard Brotli <code>br</code></span>
              <strong class="metric-value">{{ formatBytes(resource.brotliBytes) }}</strong>
              <div class="metric-track" aria-hidden="true"><span class="metric-bar bar-brotli" :style="{ width: barWidth(resource.brotliBytes) }"></span></div>
              <p>Compressed by the server without a shared dictionary.</p>
            </article>
            <article class="metric-card metric-card-featured">
              <span class="metric-label">Brotli with a dictionary <code>dcb</code></span>
              <strong class="metric-value">{{ formatBytes(resource.dcbBytes) }}</strong>
              <div class="metric-track" aria-hidden="true"><span class="metric-bar bar-dcb" :style="{ width: barWidth(resource.dcbBytes) }"></span></div>
              <p v-if="savedBytes >= 0"><strong>{{ savedPercent }}% smaller</strong> than standard Brotli.</p>
              <p v-else><strong>{{ formatBytes(-savedBytes) }} larger</strong> than standard Brotli.</p>
            </article>
          </div>
          <p class="measurement-note">
            The dictionary has an initial cost: <strong>{{ formatBytes(dictionary.bytes) }}</strong> uncompressed,
            <strong>{{ formatBytes(dictionary.brotliBytes) }}</strong> with Brotli.
            Brotli dictionary + DCB CSS: <strong>{{ formatBytes(costWithDictionary) }}</strong>.
            Savings for an individual resource assume the dictionary is already available; HTTP headers are excluded.
            On the first build, the dictionary contains the current CSS: its benefit should be assessed through reuse.
          </p>
        </template>
      </section>

      <section class="steps-section" aria-labelledby="steps-title">
        <div class="section-heading">
          <div><p class="eyebrow">02 / From manifest to browser</p><h2 id="steps-title">Three steps. One dictionary.</h2></div>
        </div>
        <div class="steps-grid">
          <article class="step-card">
            <span class="step-number">1</span>
            <h3>The build writes the manifest</h3>
            <p>The production plugin generates the dictionary and DCB CSS. It records the dictionary's path and <code>sha256Base64</code> in the manifest.</p>
            <span class="step-tag">Build → manifest</span>
          </article>
          <article class="step-card">
            <span class="step-number">2</span>
            <h3>The server prepares the head</h3>
            <p>It reads the manifest and inserts a dictionary link into the HTML before the stylesheet. The browser registers it via <code>Use-As-Dictionary</code>.</p>
            <span class="step-tag">Manifest → head → browser</span>
          </article>
          <article class="step-card">
            <span class="step-number">3</span>
            <h3>The hash determines the transfer</h3>
            <p>The server compares <code>Available-Dictionary</code> with the <code>sha256Base64</code> of the dictionary used by DCB. If the hash matches and DCB is accepted, it sends the compressed CSS.</p>
            <span class="step-tag">Verified hash → DCB</span>
          </article>
        </div>
      </section>

      <section id="browser-test" class="probe-section" aria-labelledby="probe-title">
        <div class="probe-copy">
          <p class="eyebrow">03 / The browser test</p>
          <h2 id="probe-title">What travels over the network?</h2>
          <p>Download the dictionary, then request the CSS again. Negotiation is native: JavaScript reads the response returned by the server.</p>
          <button class="primary-button" type="button" :disabled="!metrics || isRunning" @click="runProbe">
            <span>{{ isRunning ? 'Request in progress…' : probe ? 'Run the test again' : 'Test the transfer' }}</span>
            <span aria-hidden="true">↗</span>
          </button>
          <a class="text-link devtools-link" href="#devtools">How to check in DevTools <span aria-hidden="true">↓</span></a>
        </div>
        <div class="probe-result" aria-live="polite" aria-atomic="true">
          <div class="probe-status"><span class="status-dot" :class="{ 'dot-success': supportsDcb, 'dot-fallback': probe && !supportsDcb }" aria-hidden="true"></span>{{ statusText }}</div>
          <template v-if="probe">
            <dl class="result-list">
              <div><dt>Content-Encoding</dt><dd><code data-testid="transfer-encoding">{{ probe.encoding }}</code></dd></div>
              <div><dt>HTTP body (Content-Length)</dt><dd>{{ formatBytes(probe.encodedBytes) }}</dd></div>
              <div><dt>Decoded CSS</dt><dd>{{ formatBytes(probe.decodedBytes) }}</dd></div>
            </dl>
            <p v-if="supportsDcb" class="result-message">The browser received DCB and reconstructed the CSS using the dictionary.</p>
            <p v-else class="result-message">The server returned {{ probe.encoding }}. Your browser may not support DCB or may not have registered the dictionary yet. Try again and check the headers in Network.</p>
          </template>
          <p v-else-if="probeError" class="result-message error-message">{{ probeError }}</p>
          <div v-else class="probe-placeholder">
            <span class="placeholder-icon" aria-hidden="true">↓</span>
            <p>The response to the next request<br />will appear here.</p>
            <code>Content-Encoding: ?</code>
          </div>
        </div>
      </section>

      <section id="devtools" class="details-section" aria-labelledby="details-title">
        <h2 id="details-title">Verify without guesswork.</h2>
        <p>Open DevTools → Network, leave <strong>Disable cache</strong> unchecked, and start the test. On the CSS request with <code>?probe=</code>, look for <code>Available-Dictionary</code> and <code>Accept-Encoding</code> in the request headers, then <code>Content-Encoding: dcb</code> in the response. If present, <code>Dictionary-ID</code> identifies the dictionary.</p>
        <p>The first load may use standard Brotli or the original CSS. Using a dictionary requires a compatible browser and a secure context, such as HTTPS or localhost.</p>
        <details v-if="metrics" class="artifact-details">
          <summary>Explore this build's files <span aria-hidden="true">+</span></summary>
          <dl class="artifact-list">
            <div><dt>Dictionary</dt><dd><a :href="dictionary.url">{{ fileName(dictionary.url) }}</a></dd></div>
            <div><dt>ID</dt><dd><code>{{ dictionary.id }}</code></dd></div>
            <div><dt>SHA-256 (Base64)</dt><dd><code>{{ dictionary.sha256Base64 }}</code></dd></div>
            <div><dt>Match</dt><dd><code>{{ dictionary.match }}</code></dd></div>
            <div><dt>CSS</dt><dd><a :href="resource.url">{{ fileName(resource.url) }}</a></dd></div>
          </dl>
          <p>The manifest drives discovery and hash comparison. DCB is generated during the build; Brotli measurements refer to the HTTP compression performed by the server.</p>
          <p><a class="text-link" :href="metrics.manifestUrl">Open the production manifest <span aria-hidden="true">↗</span></a></p>
          <a class="text-link" href="/api/demo-stats">Open the demo statistics <span aria-hidden="true">↗</span></a>
        </details>
      </section>
    </main>

    <footer class="site-footer"><span>CSS, with memory.</span><span>An experiment with Vue, {{ bundler }} and Brotli.</span></footer>
  </div>
</template>
