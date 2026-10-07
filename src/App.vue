<script setup>
import { computed, onMounted, ref } from 'vue';

const manifest = ref(null);
const manifestError = ref('');
const isRunning = ref(false);
const probe = ref(null);
const probeError = ref('');

const resource = computed(() => manifest.value?.resources?.[0]);
const dictionary = computed(() => manifest.value?.dictionary);
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
  if (isRunning.value) return 'Prova in corso';
  if (probeError.value) return 'Prova non riuscita';
  if (supportsDcb.value) return 'DCB ricevuto';
  if (probe.value) return 'Fallback ricevuto';
  return 'Pronto per la prova';
});

function formatBytes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${new Intl.NumberFormat('it-IT').format(value)} B`;
}

function fileName(url) {
  return url?.split('/').at(-1) || '—';
}

function barWidth(value) {
  if (!resource.value?.bytes) return '0%';
  return `${Math.max(2, Math.min(100, (value / resource.value.bytes) * 100))}%`;
}

async function loadManifest() {
  try {
    const response = await fetch('/demo-manifest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Il manifesto risponde HTTP ${response.status}.`);
    const data = await response.json();
    if (!data.dictionary?.url || !data.resources?.[0]?.url) {
      throw new Error('Il manifesto non contiene dizionario e risorsa CSS.');
    }
    manifest.value = data;
  } catch (error) {
    manifestError.value = error.message;
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
      throw new Error(`Il dizionario risponde HTTP ${dictionaryResponse.status}.`);
    }
    await dictionaryResponse.arrayBuffer();

    const cssUrl = new URL(resource.value.url, window.location.origin);
    cssUrl.searchParams.set('probe', String(Date.now()));
    // Queste intestazioni vengono negoziate dal browser, mai dal JavaScript:
    // Accept-Encoding, Available-Dictionary e Dictionary-ID.
    const cssResponse = await fetch(cssUrl, { cache: 'no-store' });
    if (!cssResponse.ok) throw new Error(`Il CSS risponde HTTP ${cssResponse.status}.`);
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

onMounted(loadManifest);
</script>

<template>
  <div class="site-shell">
    <header class="site-header">
      <a class="wordmark" href="#" aria-label="Torna all'inizio">
        <span class="brand-icon" aria-hidden="true">{ }</span>
        <span>css / <strong>con memoria</strong></span>
      </a>
      <span class="stack-label"><span class="status-dot" aria-hidden="true"></span> Vue + Webpack</span>
    </header>

    <main>
      <section class="hero" aria-labelledby="page-title">
        <div class="hero-copy">
          <p class="eyebrow">Compression Dictionary Transport</p>
          <h1 id="page-title">Il tuo CSS.<br />Con meno <span>ripetizioni.</span></h1>
          <p class="hero-description">
            Il browser conosce già una versione del foglio di stile.
            Con un dizionario condiviso, Brotli può usare quei byte
            per comprimere la versione successiva.
          </p>
          <a class="text-link" href="#browser-test">Guarda cosa riceve il tuo browser <span aria-hidden="true">↗</span></a>
        </div>
        <div class="flow-card" aria-label="Una versione precedente del CSS diventa il dizionario per la nuova versione">
          <div class="flow-card-heading"><span class="file-icon" aria-hidden="true">{ }</span><span>Un aggiornamento, meno byte</span></div>
          <div class="flow-line">
            <span class="version-chip">v1</span>
            <div><strong>CSS precedente</strong><span>Dizionario conservato dal browser</span></div>
            <span class="flow-check" aria-hidden="true">✓</span>
          </div>
          <div class="flow-connector" aria-hidden="true"><span>↓</span><small>riutilizza ciò che conosci</small></div>
          <div class="flow-line flow-line-highlight">
            <span class="version-chip version-chip-dark">v2</span>
            <div><strong>CSS aggiornato</strong><span>Compresso con il dizionario v1</span></div>
            <code>dcb</code>
          </div>
          <p class="flow-caption">Stesso CSS finale. Una rappresentazione più compatta.</p>
        </div>
      </section>

      <section class="metrics-section" aria-labelledby="metrics-title">
        <div class="section-heading">
          <div><p class="eyebrow">01 / Il risultato della build</p><h2 id="metrics-title">Byte veri, dal progetto.</h2></div>
          <span class="subtle-label">Dimensioni dei file generati</span>
        </div>
        <p v-if="manifestError" class="notice notice-error" role="alert">
          {{ manifestError }} Esegui la build e avvia il server della demo.
        </p>
        <div v-else-if="!manifest" class="notice" role="status">Caricamento dei dati della build…</div>
        <template v-else>
          <div class="metric-grid">
            <article class="metric-card">
              <span class="metric-label">CSS originale</span>
              <strong class="metric-value">{{ formatBytes(resource.bytes) }}</strong>
              <div class="metric-track" aria-hidden="true"><span class="metric-bar bar-original" style="width: 100%"></span></div>
              <p>Il file dopo la build Webpack.</p>
            </article>
            <article class="metric-card">
              <span class="metric-label">Brotli standard <code>br</code></span>
              <strong class="metric-value">{{ formatBytes(resource.brotliBytes) }}</strong>
              <div class="metric-track" aria-hidden="true"><span class="metric-bar bar-brotli" :style="{ width: barWidth(resource.brotliBytes) }"></span></div>
              <p>Compresso senza dizionario condiviso.</p>
            </article>
            <article class="metric-card metric-card-featured">
              <span class="metric-label">Brotli con dizionario <code>dcb</code></span>
              <strong class="metric-value">{{ formatBytes(resource.dcbBytes) }}</strong>
              <div class="metric-track" aria-hidden="true"><span class="metric-bar bar-dcb" :style="{ width: barWidth(resource.dcbBytes) }"></span></div>
              <p v-if="savedBytes >= 0"><strong>{{ savedPercent }}% in meno</strong> rispetto a Brotli standard.</p>
              <p v-else><strong>{{ formatBytes(-savedBytes) }} in più</strong> rispetto a Brotli standard.</p>
            </article>
          </div>
          <p class="measurement-note">
            Il dizionario ha un costo iniziale: <strong>{{ formatBytes(dictionary.bytes) }}</strong> originale,
            <strong>{{ formatBytes(dictionary.brotliBytes) }}</strong> in Brotli.
            Dizionario in Brotli + CSS in DCB: <strong>{{ formatBytes(costWithDictionary) }}</strong>.
            Il risparmio sulla singola risorsa presuppone un dizionario già disponibile; intestazioni HTTP escluse.
          </p>
        </template>
      </section>

      <section class="steps-section" aria-labelledby="steps-title">
        <div class="section-heading">
          <div><p class="eyebrow">02 / Il percorso dei byte</p><h2 id="steps-title">Tre passaggi. Un dizionario.</h2></div>
        </div>
        <div class="steps-grid">
          <article class="step-card">
            <span class="step-number">1</span>
            <h3>Pubblica il dizionario</h3>
            <p>Una snapshot del CSS v1 diventa un file immutabile. Il server lo propone con l'intestazione <code>Use-As-Dictionary</code>.</p>
            <span class="step-tag">Dizionario → browser</span>
          </article>
          <article class="step-card">
            <span class="step-number">2</span>
            <h3>Comprimi durante la build</h3>
            <p>Webpack estrae il CSS v2. La build genera le varianti <code>.br</code> e <code>.dcb</code> usando il dizionario pubblicato.</p>
            <span class="step-tag">CSS + dizionario → DCB</span>
          </article>
          <article class="step-card">
            <span class="step-number">3</span>
            <h3>Lascia negoziare il browser</h3>
            <p>Se supporta DCB e dispone del dizionario corretto, il browser lo segnala. Il server sceglie la rappresentazione adatta.</p>
            <span class="step-tag">DCB → CSS originale</span>
          </article>
        </div>
      </section>

      <section id="browser-test" class="probe-section" aria-labelledby="probe-title">
        <div class="probe-copy">
          <p class="eyebrow">03 / La prova nel browser</p>
          <h2 id="probe-title">Cosa passa sulla rete?</h2>
          <p>Scarica il dizionario, poi richiedi di nuovo il CSS. La negoziazione è nativa: JavaScript legge la risposta restituita dal server.</p>
          <button class="primary-button" type="button" :disabled="!manifest || isRunning" @click="runProbe">
            <span>{{ isRunning ? 'Richiesta in corso…' : probe ? 'Ripeti la prova' : 'Prova il trasferimento' }}</span>
            <span aria-hidden="true">↗</span>
          </button>
          <a class="text-link devtools-link" href="#devtools">Come verificarlo in DevTools <span aria-hidden="true">↓</span></a>
        </div>
        <div class="probe-result" aria-live="polite" aria-atomic="true">
          <div class="probe-status"><span class="status-dot" :class="{ 'dot-success': supportsDcb, 'dot-fallback': probe && !supportsDcb }" aria-hidden="true"></span>{{ statusText }}</div>
          <template v-if="probe">
            <dl class="result-list">
              <div><dt>Content-Encoding</dt><dd><code data-testid="transfer-encoding">{{ probe.encoding }}</code></dd></div>
              <div><dt>Corpo HTTP (Content-Length)</dt><dd>{{ formatBytes(probe.encodedBytes) }}</dd></div>
              <div><dt>CSS decodificato</dt><dd>{{ formatBytes(probe.decodedBytes) }}</dd></div>
            </dl>
            <p v-if="supportsDcb" class="result-message">Il browser ha ricevuto DCB e ha ricostruito il CSS usando il dizionario.</p>
            <p v-else class="result-message">Il server ha restituito {{ probe.encoding }}. Il browser potrebbe non supportare DCB oppure non aver ancora registrato il dizionario. Puoi riprovare e controllare le intestazioni in Network.</p>
          </template>
          <p v-else-if="probeError" class="result-message error-message">{{ probeError }}</p>
          <div v-else class="probe-placeholder">
            <span class="placeholder-icon" aria-hidden="true">↓</span>
            <p>La risposta della prossima richiesta<br />apparirà qui.</p>
            <code>Content-Encoding: ?</code>
          </div>
        </div>
      </section>

      <section id="devtools" class="details-section" aria-labelledby="details-title">
        <h2 id="details-title">Verifica, senza indovinare.</h2>
        <p>Apri DevTools → Network, lascia disattivato <strong>Disable cache</strong> e avvia la prova. Sulla richiesta CSS con <code>?probe=</code> cerca <code>Available-Dictionary</code> e <code>Accept-Encoding</code> nelle intestazioni della richiesta, poi <code>Content-Encoding: dcb</code> nella risposta. L'eventuale <code>Dictionary-ID</code> identifica il dizionario.</p>
        <p>Il primo caricamento può usare Brotli standard o il CSS originale. Per usare un dizionario servono un browser compatibile e un contesto sicuro, come HTTPS o localhost.</p>
        <details v-if="manifest" class="artifact-details">
          <summary>Esplora i file di questa build <span aria-hidden="true">+</span></summary>
          <dl class="artifact-list">
            <div><dt>Dizionario</dt><dd><a :href="dictionary.url">{{ fileName(dictionary.url) }}</a></dd></div>
            <div><dt>ID</dt><dd><code>{{ dictionary.id }}</code></dd></div>
            <div><dt>SHA-256</dt><dd><code>{{ dictionary.sha256 }}</code></dd></div>
            <div><dt>Match</dt><dd><code>{{ dictionary.match }}</code></dd></div>
            <div><dt>CSS</dt><dd><a :href="resource.url">{{ fileName(resource.url) }}</a></dd></div>
          </dl>
          <a class="text-link" href="/demo-manifest.json">Apri il manifesto JSON <span aria-hidden="true">↗</span></a>
        </details>
      </section>
    </main>

    <footer class="site-footer"><span>CSS, con memoria.</span><span>Un esperimento con Vue, Webpack e Brotli.</span></footer>
  </div>
</template>
