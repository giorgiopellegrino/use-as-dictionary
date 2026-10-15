# Vue + Webpack: CSS con Compression Dictionary Transport

Demo basata su **CBP-Performance _ Use-As-Dictionary-131026-172707.pdf**. Usa un unico [CompressionDictionaryPlugin](webpack/README.md), con il codice del plugin di produzione invariato. Il manifest prodotto dalla build guida la discovery del dizionario e la negoziazione HTTP.

## Avvio

Serve Node.js **22.12 o successivo**.

```sh
npm ci
npm start
```

Apri **http://localhost:8080** in Chrome o Edge con supporto Compression Dictionary Transport. `npm start` esegue la build e avvia il server.

## Build e dizionario persistente

La configurazione seleziona il CSS minificato estratto da Webpack:

```js
const CompressionDictionaryPlugin = require('./webpack/CompressionDictionaryPlugin.cjs');

new CompressionDictionaryPlugin({
  test: /^dist\/styles\.[a-f0-9]+\.css$/,
  dictionarySource: '.dictionary-cache/styles.dat',
  autoUpdate: { minSavings: 0.9 },
});
```

Quando la cache manca, il plugin crea il primo dizionario **dal CSS corrente**. Nelle build successive lo riutilizza finché `1 - dcb.length / css.length` resta almeno `0.9`; sotto la soglia lo rigenera dal nuovo CSS e aggiorna la cache dopo una build riuscita. La misura include i 36 byte dell'header DCB e confronta DCB con il CSS minificato non compresso.

Conserva `.dictionary-cache/styles.dat` tra le build, anche in CI. È escluso da Git e si trova fuori da `build/`, quindi sopravvive alla pulizia dell'output. Per provare il riuso, modifica `src/styles.css` e ricompila mantenendo la cache.

```text
build/
  index.html
  dictionaries/styles.<sha256>.dat
  dist/
    app.<contenthash>.js
    styles.<contenthash>.css
    styles.<contenthash>.css.dcb
    compression-dictionary-manifest.json
```

Il plugin genera `.dat`, `.dcb` e manifest. Il server genera le rappresentazioni HTTP Brotli e gzip con `node:zlib`: **non sono file `.br` e `.gz` della build**. Il CSS mantiene il suo URL originale; il server seleziona la rappresentazione appropriata.

## Manifest, head e confronto dell'hash

Il manifest pubblico è `/dist/compression-dictionary-manifest.json`:

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

Il server lo rilegge a ogni richiesta e verifica i byte dei dizionari. Il manifest elenca i dizionari; l'associazione al CSS deriva dal digest di 32 byte nell'header del relativo `.dcb`, confrontato con `sha256Base64`.

Per servire l'HTML, il server inserisce `<link rel="compression-dictionary">` nell'`head`, prima del foglio di stile, e imposta anche l'header `Link`. Il link è presente nella risposta HTTP, non nel file `build/index.html`. L'HTML viene compresso dopo l'inserimento.

Il dizionario viene pubblicato con `Use-As-Dictionary: match="/dist/styles.*.css"`, un `id` e una cache di due settimane. Il server invia DCB solo quando il browser lo accetta e `Available-Dictionary` corrisponde al `sha256Base64` del dizionario usato da quella risorsa. Altrimenti negozia Brotli, gzip o identity. Le risposte CSS usano `Vary: Accept-Encoding, Available-Dictionary`; `Dictionary-ID` non sostituisce il controllo dell'hash.

## Misure e prova nel browser

La pagina legge `/api/demo-stats`: l'endpoint espone le dimensioni del CSS, del DCB della build e delle rappresentazioni Brotli generate dal server. Non governa discovery o negoziazione; il link **Apri il manifest di produzione** mostra il manifest effettivo.

Il primo dizionario contiene l'intero CSS corrente. Un DCB molto piccolo non elimina quel download iniziale: la pagina mostra anche **dizionario in Brotli + CSS in DCB**. Il risparmio va valutato quando il dizionario è riutilizzato; le misure escludono le intestazioni e l'eventuale primo CSS ricevuto in fallback.

In DevTools → Network lascia **Disable cache disattivato** e premi **Prova il trasferimento**. Sulla richiesta CSS con `?probe=...`, verifica `Accept-Encoding: ... dcb ...`, `Available-Dictionary: :<sha256Base64>:` e la risposta `Content-Encoding: dcb`. Il browser negozia e decodifica nativamente. Se non ha ancora registrato il dizionario, ripeti la prova.

## Comandi

```sh
npm run build          # Compila e aggiorna il dizionario se necessario
npm run serve          # Serve una build esistente
npm start              # Build + server
npm test               # Build + test Node
npm run test:browser   # Build + test browser con Chrome installato
```

I test verificano formato DCB, manifest, discovery e negoziazione; il test browser verifica anche decodifica e applicazione native del CSS. Per usare il Chromium di Playwright:

```powershell
npx playwright install chromium
$env:PLAYWRIGHT_CHANNEL = 'chromium'
npm run test:browser
```

Per lavorare sui sorgenti, usa `npm run build:watch` e `npm run serve` in due terminali; aggiorna la pagina a build conclusa. La pubblicazione locale non è atomica, quindi richieste durante una ricompilazione possono fallire.

Per un dominio remoto usa HTTPS. Il server accetta `TLS_CERT` e `TLS_KEY` per certificato e chiave, oltre a `HOST` e `PORT`. In un deploy pubblica manifest, dizionario e DCB insieme, conserva gli URL immutabili per la durata delle cache e configura origin/CDN con gli stessi controlli di hash e codifica.
