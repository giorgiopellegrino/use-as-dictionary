# Vue + Webpack: CSS con Compression Dictionary Transport

Esempio funzionante basato su **CBP-Performance _ Use-As-Dictionary-080926-173936.pdf**, presente nella cartella del progetto. Vue usa un normale foglio di stile; Webpack genera il dizionario e le rappresentazioni compresse; un server Node sceglie quella compatibile con il browser.

Per integrare la generazione di **dizionari `.dat` e risorse `.dcb`** nella tua applicazione, usa il [plugin per la produzione](webpack/production/README.md). Accetta un file già pronto tramite `input` oppure gli asset della build tramite `test`, supporta più istanze e genera `dist/compression-dictionary-manifest.json` con gli hash Base64 dei dizionari per il deploy. Lascia gli header al server e non modifica l'HTML. Il plugin della demo resta dedicato alla pagina Vue e alle sue statistiche.

Il plugin di produzione supporta anche l'[aggiornamento automatico del dizionario](webpack/production/README.md#aggiornamento-automatico-sotto-il-90): con `autoUpdate: { minSavings: 0.9 }` riutilizza il file `dictionarySource` finché il DCB risparmia almeno il 90% rispetto al CSS minificato non compresso, poi aggiorna quello stesso file. L'esempio Ray-Ban usa `.dictionary-cache/rayban-styles.dat`, da conservare tra le build e ripristinare in CI; se manca, il plugin lo crea dal CSS corrente.

Il nome pubblicato deriva automaticamente da `dictionarySource` e dall'hash del dizionario: nell'esempio è `dictionaries/rayban-styles.<sha256>.dat`, relativo alla directory di output della build.

## Avvio

Serve Node.js **22.12 o successivo**; verificato con Node 24. Non sono necessari Python, OpenSSL o un compilatore C per la build.

```sh
npm ci
npm start
```

Apri **http://localhost:8080** in Chrome o Edge aggiornato. `npm start` esegue la build e avvia il server. Le dipendenze sono già state installate durante la preparazione del progetto; `npm ci` permette di riprodurre l'installazione dal lockfile.

La pagina mostra dimensioni effettive e il pulsante **Prova il trasferimento**. Il pulsante scarica il dizionario e richiede nuovamente il CSS, quindi legge `Content-Encoding`, `Content-Length` e la dimensione decodificata. La decompressione avviene nello stack HTTP del browser: il bundle Vue non contiene un decoder WASM.

In DevTools → Network lascia **Disable cache disattivato**. Sulla richiesta CSS con `?probe=...` verifica:

```http
Accept-Encoding: gzip, deflate, br, zstd, dcb, dcz
Available-Dictionary: :<SHA-256 del dizionario, in base64>:
Dictionary-ID: "styles-<hash>"
```

```http
Content-Type: text/css; charset=utf-8
Content-Encoding: dcb
Vary: Accept-Encoding, Available-Dictionary
```

Le intestazioni di richiesta sono inserite dal browser. Il primo CSS può arrivare in Brotli standard: il link di discovery lascia al browser decidere quando acquisire il dizionario. Se la registrazione non è ancora terminata, ripeti la prova; la pagina distingue DCB e fallback.

## Come segue il PDF

| Indicazione | Implementazione |
| --- | --- |
| Plugin Webpack durante `processAssets` | `webpack/CompressionDictionaryPlugin.cjs`, fase `OPTIMIZE_TRANSFER`, dopo minificazione e calcolo dei nomi definitivi |
| Dizionario `.dat` versionato | Snapshot `dictionaries/styles.v1.css`, minificata e pubblicata con hash nel nome |
| CSS compresso con dizionario esterno | Encoder `brotli-wasm-custom-dictionary`, dizionario raw/prefix, qualità 11 |
| Header binario DCB | `ff 44 43 42` + SHA-256 binario del dizionario (32 byte) + stream Shared Brotli |
| `Use-As-Dictionary` | `match="/dist/styles.*.css", id="styles-<hash>"` sulla risposta del dizionario |
| Cache di almeno due settimane | `Cache-Control: public, max-age=1209600, immutable` sul dizionario |
| Discovery dal documento | `<link rel="compression-dictionary">` generato nell'HTML; anche intestazione HTTP `Link` |
| Negoziazione lato server | DCB solo se esplicitamente accettato con `q > 0` e hash corrispondente; altrimenti `br`, `gzip` o identity |
| Cache delle varianti | `Vary: Accept-Encoding, Available-Dictionary` su tutte le rappresentazioni CSS |

Due precisazioni rispetto agli esempi del documento:

1. Il riferimento HTML resta `/dist/styles.<hash>.css`. Il file `.css.dcb` è una rappresentazione interna scelta dal server. Collegarlo direttamente nel markup non gestirebbe da solo la disponibilità del dizionario.
2. `node:zlib` produce le varianti standard `.br` e `.gz`, ma non espone il dizionario esterno necessario a questa implementazione Brotli. Per DCB il plugin usa un encoder WASM che supporta davvero `customDictionary`, equivalente al flusso `brotli -D` mostrato nel PDF. Aggiungere un header DCB a normale Brotli non dimostrerebbe la compressione con dizionario.

## Dizionario e aggiornamenti CSS

Il dizionario è una **snapshot precedente**, non una copia rigenerata ogni volta dal CSS corrente. La v1 e la v2 incluse condividono quasi tutto il foglio, con poche differenze di tema: rappresentano intenzionalmente un aggiornamento piccolo. La build minifica entrambe con la stessa configurazione cssnano. Il file `.dat` contiene i byte minificati della v1: il suo hash viene calcolato prima dell'eventuale compressione HTTP del dizionario.

Modifica `src/styles.css`, poi esegui `npm run build`. Il CSS e il relativo nome cambiano; il dizionario resta stabile finché non modifichi `dictionaries/styles.v1.css`. Puoi sostituire questa snapshot con il CSS di una release precedente del tuo progetto. Non servono un formato di training o un file dizionario proprietario: è un dizionario raw.

Questa scelta rende molto favorevole il rapporto DCB/Brotli della demo. **Il risparmio non è una garanzia per CSS diversi**, e il costo del download iniziale del dizionario va incluso. La pagina espone sia il costo del dizionario in Brotli sia `dizionario.br + CSS.dcb`. Nel flusso a cache vuota può arrivare prima anche il CSS in Brotli: quel totale non rappresenta il costo complessivo della prima visita. Il beneficio emerge quando il dizionario è già disponibile e viene riutilizzato per aggiornamenti o altre risorse simili; ricaricare un CSS già in cache normalmente non trasferisce nulla.

## File e output

```text
src/App.vue                         UI, misure e prova nativa
src/styles.css                      CSS della versione attuale
dictionaries/styles.v1.css           Snapshot usata come dizionario
webpack.config.cjs                  Vue SFC, estrazione e minificazione CSS
webpack/CompressionDictionaryPlugin.cjs
server/index.cjs                    Server HTTP/HTTPS e header
server/negotiation.cjs               Scelta della rappresentazione
test/dcb.test.cjs                    Round-trip, header e fallback HTTP
test/browser.spec.cjs               Decodifica e applicazione native in Chrome

build/
  index.html                        Include discovery e link stylesheet
  demo-manifest.json                 URL, hash e dimensioni reali
  dictionaries/
    dictionary_style_<hash>.dat      Dizionario versionato
    ...dat.br / ...dat.gz
  dist/
    app.<hash>.js                    Bundle Vue
    styles.<hash>.css                CSS minificato
    styles.<hash>.css.br             Brotli senza dizionario
    styles.<hash>.css.gz             gzip
    styles.<hash>.css.dcb            Header DCB + stream con dizionario
```

Anche HTML e JavaScript vengono precompressi in Brotli/gzip. Tutta la compressione avviene durante la build. Le URL pubbliche non espongono direttamente i file laterali `.br`, `.gz` e `.dcb`.

## Comandi e test

```sh
npm run build          # Genera tutti gli artefatti
npm run serve          # Serve una build esistente su localhost:8080
npm test               # Build + test Node del formato e delle risposte HTTP
npm run test:browser   # Build + test end-to-end con Google Chrome installato
```

Il test browser parte con un profilo pulito e un server dedicato su `localhost:4174`. Verifica gli header inviati automaticamente da Chrome, confronta il CSS decodificato con l'artefatto locale, rimuove il foglio iniziale e verifica l'applicazione di un nuovo `<link rel="stylesheet">` ricevuto in DCB. Controlla anche il pulsante della demo e l'assenza di overflow su schermo mobile.

Se Chrome non è installato, puoi usare il Chromium di Playwright:

```powershell
npx playwright install chromium
$env:PLAYWRIGHT_CHANNEL = 'chromium'
npm run test:browser
```

Oppure imposta `PLAYWRIGHT_CHANNEL=msedge` per Edge. Su shell POSIX: `PLAYWRIGHT_CHANNEL=chromium npm run test:browser`. Le tracce di eventuali errori browser vengono salvate nella directory temporanea indicata dal test.

Per lavorare sui file, usa due terminali con `npm run build:watch` e `npm run serve`, poi aggiorna la pagina dopo il completamento della build. Il server rilegge il manifesto a ogni richiesta. La scrittura locale non è atomica: richieste durante una ricompilazione possono fallire, e una scheda non aggiornata può riferirsi a file della build precedente. Non è configurato HMR: la demo verifica gli artefatti reali di produzione e il relativo trasporto HTTP.

## HTTPS e infrastruttura

La demo è stata verificata su HTTP **localhost**, considerato un contesto sicuro dal browser usato. Per un dominio remoto usa **HTTPS**. Puoi terminare TLS sul reverse proxy oppure passare certificato e chiave al server:

```powershell
$env:TLS_CERT = 'C:\percorso\localhost.pem'
$env:TLS_KEY = 'C:\percorso\localhost-key.pem'
$env:PORT = '8443'
npm run serve
```

Il certificato deve essere valido e attendibile per il browser. `HOST` permette di cambiare l'indirizzo di ascolto; il default è `localhost`.

Per portare il flusso nell'infrastruttura descritta dal PDF:

- Pubblica insieme manifesto, dizionario e varianti CSS con uno switch atomico della release.
- Configura origin/CDN affinché scelga il file DCB solo con hash e codifica compatibili e rispetti `Vary`. Evita che una compressione automatica ricomprima i file già codificati.
- Mantieni i vecchi URL immutabili per la durata delle cache e dei rollout. La demo gestisce un dizionario corrente: un hash precedente riceve il fallback. Un ambiente con più release può mantenere una tabella hash → dizionario/varianti.
- Usa lo stesso origin per HTML, dizionario e CSS, come in questo esempio. Un passaggio a origin diversi richiede ulteriore gestione CORS e delle regole del browser.

Il server incluso è un esempio locale, non una configurazione già applicata alla vostra CDN. Non usa `Dictionary-ID` come prova dell'identità del dizionario: controlla sempre l'hash. L'encoder scelto usa una finestra di 4 MiB e il plugin rifiuta dizionari oltre `2**22 - 16` byte.

## Riferimenti

- [RFC 9842 — Compression Dictionary Transport](https://www.rfc-editor.org/rfc/rfc9842.html): formato DCB, discovery, negoziazione e cache.
- [RFC 9841 — Shared Brotli](https://www.rfc-editor.org/rfc/rfc9841.html): formato Brotli con dizionari condivisi.
- [Chrome Developers — Improving Google Search with Compression Dictionaries](https://developer.chrome.com/blog/search-compression-dictionaries): flusso nel browser e supporto Chromium.
- [Encoder brotli-wasm con custom dictionary](https://github.com/kyr0/brotli-wasm): API e semantica del dizionario raw.
- [CLI Brotli ufficiale](https://github.com/google/brotli/blob/master/c/tools/brotli.md): alternativa nativa `brotli -D` proposta dal PDF.
