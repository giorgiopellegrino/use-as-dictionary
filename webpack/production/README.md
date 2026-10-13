# CompressionDictionaryPlugin per la produzione

Plugin per **Webpack 5** che aggiunge alla build dizionari raw `.dat`, rappresentazioni compresse `.dcb` e un manifest con gli hash dei dizionari. Usa `brotli-wasm-custom-dictionary`, già presente nelle dipendenze del progetto. Per copiarlo in un altro progetto serve anche questa dipendenza di build.

## Un file già pronto in input

Per elaborare un CSS già pronto, indica direttamente il suo percorso con `input`. Esempio per il file presente nel progetto:

```js
const path = require('node:path');
const CompressionDictionaryPlugin = require('./webpack/production/CompressionDictionaryPlugin.cjs');
const cssInput = path.resolve(__dirname, 'src/styles.3772401f5d.css');

// Nell'array plugins della configurazione:
new CompressionDictionaryPlugin({
  input: cssInput,
  dcbFilename: `dist/${path.basename(cssInput)}.dcb`,
});
```

La build produce questi tre file, relativi a `output.path`:

```text
dist/styles.3772401f5d.css.dcb
dictionaries/<sha256>.dat
dist/compression-dictionary-manifest.json
```

Con `input` **non serve `test`**. Il file viene letto come byte, senza importarlo nel bundle, passarlo ai loader o risolvere `url()` e `@import`. Il dizionario contiene quei byte e il DCB si decomprime nel file originale esatto. La pubblicazione del CSS originale resta a carico della tua applicazione.

`input` può essere assoluto o relativo al `context` di Webpack. Se ometti `dcbFilename`, l'output è `<nome-file>.dcb` nella radice di `output.path`. Senza `dictionarySource`, il nome del dizionario è `dictionaries/<sha256>.dat`. Puoi usare più istanze con input e percorsi DCB diversi. Il file viene seguito anche in modalità watch.

L'esempio deriva `dcbFilename` dal nome dell'input: cambiando `cssInput`, anche l'output mantiene automaticamente lo stesso hash nel nome (`styles.3772401f5d.css` → `dist/styles.3772401f5d.css.dcb`). Quel valore identifica la risorsa originale; il digest calcolato sui byte compressi è distinto. L'hash del dizionario continua a dipendere dai byte del dizionario stesso.

## Comprimere gli asset della build

Per elaborare invece i CSS estratti dalla build corrente, usa `test`:

```js
new CompressionDictionaryPlugin({
  test: /^dist\/styles\.[a-f0-9]+\.css$/,
});
```

`test` seleziona il **nome finale dell'asset emesso da Webpack**, relativo a `output.path`, senza `/` iniziale. Può essere una regex oppure un nome esatto, per esempio `test: 'dist/styles.css'`. Non è il percorso del sorgente `src/styles.css`: estrazione e minificazione restano compito della configurazione Webpack.

Per ogni asset selezionato, il plugin legge i byte finali, dopo minificazione e calcolo del nome con content hash, e produce:

```text
dist/styles.<contenthash>.css          Asset originale, conservato
dist/styles.<contenthash>.css.dcb      Risorsa compressa con il dizionario
dictionaries/<sha256>.dat              Dizionario raw
dist/compression-dictionary-manifest.json  Manifest degli hash
```

Sia con `input` sia con `test`, senza altre opzioni il `.dat` contiene gli stessi byte della risorsa da comprimere. Non c'è un processo di training: quei byte sono il dizionario esterno usato dall'encoder. Il suo nome usa il SHA-256 completo, in esadecimale; lo stesso hash, nei suoi 32 byte binari, è incluso nell'header DCB.

In questa modalità, se cambia la risorsa cambia anche il dizionario. Un DCB molto piccolo non elimina il costo di scaricare il dizionario, che contiene l'intera risorsa. Per riutilizzare un dizionario già disponibile tra diverse release, configura una snapshot stabile oppure l'aggiornamento automatico a soglia.

## Riutilizzare una snapshot precedente

```js
new CompressionDictionaryPlugin({
  test: /^dist\/styles\.[a-f0-9]+\.css$/,
  dictionarySource: 'dictionaries/styles.v1.css',
});
```

`dictionarySource` è un percorso assoluto o relativo al `context` di Webpack. Il plugin legge e pubblica **esattamente quei byte**, senza minificarli o convertirli in testo. Puoi indicare direttamente il CSS minificato di una release precedente, oppure un `.dat` già prodotto. Questa opzione funziona anche insieme a `input`: `input` è il file corrente da comprimere, `dictionarySource` è la snapshot da usare come dizionario.

Il nome del dizionario pubblicato viene ricavato automaticamente da `dictionarySource`: il plugin prende il nome del file senza l'ultima estensione e aggiunge `.<sha256>.dat`, nella directory `dictionaries/` di `output.path`. Per esempio, `snapshots/styles.v1.css` produce `dictionaries/styles.v1.<sha256>.dat`. L'output ha sempre estensione `.dat`; l'hash è calcolato dai byte del dizionario e resta stabile finché il contenuto non cambia.

Senza `autoUpdate`, il plugin legge questa snapshot senza modificarla. Tutti gli asset selezionati da questa istanza usano la stessa snapshot. Finché la snapshot resta invariata, il dizionario mantiene contenuto, hash e nome; i DCB vengono ricreati dal contenuto corrente. Il file è registrato tra le dipendenze di Webpack, anche in modalità watch.

## Aggiornamento automatico sotto il 90%

Con `autoUpdate` il plugin riutilizza l'ultimo dizionario finché il DCB fa risparmiare almeno il 90% rispetto al CSS minificato non compresso. Quando il risparmio scende sotto la soglia, genera un nuovo dizionario dai byte della risorsa corrente e ricrea il DCB. Questa è la configurazione dell'esempio Ray-Ban in `webpack.config.cjs`:

```js
const path = require('node:path');
const CompressionDictionaryPlugin = require('./webpack/production/CompressionDictionaryPlugin.cjs');
const cssInput = path.resolve(__dirname, 'src/styles.3772401f5d.css');

// Nell'array plugins della configurazione:
new CompressionDictionaryPlugin({
  input: cssInput,
  dictionarySource: '.dictionary-cache/rayban-styles.dat',
  autoUpdate: {
    minSavings: 0.9,
  },
  dcbFilename: `dist/${path.basename(cssInput)}.dcb`,
});
```

Con `autoUpdate`, **`dictionarySource` è l'unico percorso del dizionario da leggere e aggiornare** ed è obbligatorio. Indica un file raw `.dat`, assoluto o relativo al `context` di Webpack. Scegli un percorso stabile, indipendente dal content hash del CSS, **fuori da `output.path`**: `output.clean` deve poter pulire gli artefatti senza cancellare il dizionario da riutilizzare. Puoi anche scrivere `autoUpdate: {}` per usare la soglia predefinita `0.9`.

Nell'esempio il file persistente è `.dictionary-cache/rayban-styles.dat`; la build pubblica automaticamente `dictionaries/rayban-styles.<sha256>.dat` dentro `output.path`. Basta configurare `dictionarySource`: il nome pubblicato deriva da quel file e dal suo contenuto. L'hash del dizionario è indipendente dal content hash del CSS e rimane invariato quando viene riutilizzato lo stesso dizionario.

La scelta del dizionario avviene così:

1. Se esiste `dictionarySource`, usa quei byte come dizionario iniziale.
2. Se il file manca, crea il primo dizionario dai byte della risorsa corrente.
3. Comprime la risorsa e calcola `1 - dcb.length / css.length`, includendo i **36 byte dell'header DCB**. Se il risparmio è almeno `minSavings` (predefinito `0.9`), conserva il dizionario; sotto la soglia lo rigenera dai byte correnti e ricomprime.

Con `test`, `css.length` è la dimensione dell'asset finale già minificato. Con `input`, è la dimensione del file letto: il plugin non lo minifica, quindi fornisci un CSS già minificato per ottenere quel confronto. La metrica riguarda il solo DCB e non comprende il trasferimento iniziale del dizionario. Su file piccoli l'header può impedire di raggiungere la soglia anche con un dizionario nuovo; la rigenerazione non garantisce il 90%. Una risorsa vuota riutilizza il dizionario esistente.

Il plugin crea o aggiorna **lo stesso file `dictionarySource`** con scrittura atomica solo dopo che gli artefatti di una build riuscita sono stati emessi. Non lo riscrive quando i byte sono invariati: un risparmio almeno pari alla soglia mantiene contenuto e hash del dizionario. Il file persistente contiene un solo dizionario corrente. Il formato del manifest resta invariato; il suo hash identifica il dizionario effettivamente emesso.

La modalità automatica gestisce **una sola risorsa per istanza**: usa `input`, oppure un `test` che selezioni esattamente un asset. Per più risorse usa più istanze, ciascuna con un `dictionarySource` distinto. Il percorso stabile permette di ritrovare il dizionario anche quando il content hash nel nome dell'asset cambia.

Escludi `.dictionary-cache/` da Git e conserva il file `dictionarySource` tra le build. In CI ripristinalo prima della build e salvalo dopo il completamento riuscito, usando una chiave che permetta di recuperarlo anche per la release successiva. Senza questa persistenza ogni ambiente crea un nuovo dizionario dalla risorsa corrente.

Per migrare dalla configurazione precedente, sposta il valore di `autoUpdate.cachePath` in `dictionarySource`, conservando lo stesso file, e rimuovi `cachePath` dall'oggetto `autoUpdate`. `cachePath` non è più supportato e causa un errore con le indicazioni di migrazione. L'eventuale vecchia snapshot iniziale separata non viene più usata.

L'opzione `dictionaryFilename` è stata rimossa: eliminala dalla configurazione. Il nome pubblicato viene ora generato automaticamente dal nome di `dictionarySource` e dall'hash del contenuto; senza `dictionarySource` resta `dictionaries/<sha256>.dat`.

## Più istanze

```js
plugins: [
  new CompressionDictionaryPlugin({
    test: /^dist\/main\.[a-f0-9]+\.css$/,
    dictionarySource: 'snapshots/main.css',
  }),
  new CompressionDictionaryPlugin({
    test: /^dist\/vendor\.[a-f0-9]+\.js$/,
    dictionarySource: 'snapshots/vendor.js',
  }),
]
```

Ogni istanza seleziona i propri asset. Il plugin lavora su byte e può comprimere anche JavaScript e altre risorse. I selettori devono essere disgiunti: due istanze che tentano di produrre lo stesso `.dcb` fanno fallire la build. Dizionari identici con lo stesso nome di output vengono invece condivisi.

Queste istanze pubblicano rispettivamente `dictionaries/main.<sha256>.dat` e `dictionaries/vendor.<sha256>.dat`.

## Manifest degli hash

Il plugin genera sempre `dist/compression-dictionary-manifest.json`, relativo a `output.path`. Nella configurazione di questo progetto il file si trova quindi in `build/dist/compression-dictionary-manifest.json`.

```json
{
  "dictionaries": {
    "dictionaries/rayban-styles.<sha256>.dat": {
      "sha256Base64": "...=",
      "availableDictionary": ":...=:"
    }
  }
}
```

Ogni chiave è il percorso del dizionario **emesso**, relativo a `output.path`. `sha256Base64` è il SHA-256 dei byte raw del `.dat`, codificato in Base64; `availableDictionary` contiene lo stesso valore tra due `:`, nel formato dell'header HTTP. Entrambi derivano dagli stessi 32 byte di hash inseriti nel DCB.

Il manifest raccoglie i dizionari di **tutte le istanze del plugin di produzione** della compilazione, ordinati per percorso, senza duplicare quelli condivisi. Viene ricreato a ogni build, anche in watch: una snapshot invariata mantiene lo stesso hash, mentre una snapshot modificata aggiorna la relativa voce. Il percorso del manifest è riservato; una collisione fa fallire la build.

La pipeline di deploy può leggere `availableDictionary` per configurare su Akamai il valore atteso per il dizionario associato al DCB da servire. Il manifest non configura automaticamente la CDN e non sostituisce il controllo di `Accept-Encoding`. Il manifest della demo rimane separato.

## Opzioni

| Opzione | Valore predefinito | Significato |
| --- | --- | --- |
| `input` | Alternativo a `test` | Percorso del file già pronto da comprimere, assoluto o relativo al `context`. |
| `test` | Alternativo a `input` | Nome esatto o `RegExp` per gli asset finali da comprimere. Nessuna corrispondenza fa fallire la build. |
| `dcbFilename` | `<nome-file>.dcb` | Percorso DCB relativo a `output.path`, disponibile solo con `input`. |
| `dictionarySource` | Byte della risorsa da comprimere | Snapshot raw da leggere, da cui deriva anche il nome del `.dat` pubblicato; con `autoUpdate` è obbligatorio e indica l'unico file persistente da leggere, creare o aggiornare. |
| `autoUpdate` | Disattivato | Oggetto `{ minSavings: 0.9 }`, anche vuoto per la soglia predefinita: riutilizza `dictionarySource` e lo rigenera sotto la soglia di risparmio. Richiede una sola risorsa per istanza. |
| `quality` | `11` | Qualità Brotli, intero da `0` a `11`. |

Devi specificare esattamente uno tra `input` e `test`. Con `test` il nome del DCB è sempre `<nome-asset>.dcb`; con `input` puoi impostarlo tramite `dcbFilename`, che è un percorso letterale senza segnaposto. I percorsi di output usano `/`; percorsi assoluti, attraversamenti `..`, collisioni e sovrascritture dei file di input sono rifiutati. Ogni dizionario deve contenere da 1 a `2**22 - 16` byte, limite della finestra dell'encoder utilizzato. Una risorsa vuota può essere compressa se è configurata una snapshot non vuota.

## Integrazione HTTP e demo

La configurazione del server gestisce `Use-As-Dictionary` e il relativo `match`, la discovery del dizionario e la selezione della rappresentazione sulla base di `Accept-Encoding` e `Available-Dictionary`. Per una risposta DCB usa `Content-Encoding: dcb` e gestisci `Vary`; la risorsa originale resta disponibile per il fallback. Il formato e la negoziazione sono descritti nella [RFC 9842](https://www.rfc-editor.org/rfc/rfc9842.html#section-6).

Il plugin non genera ID HTTP, link HTML, varianti `.br`/`.gz` o configurazioni del server. Non richiede `HtmlWebpackPlugin` e non modifica gli altri asset. Il nome esadecimale del dizionario non è il valore di `Available-Dictionary`: per quel confronto usa il campo `availableDictionary` del manifest.

La demo esistente usa il plugin in `webpack/CompressionDictionaryPlugin.cjs`, con manifest e statistiche per la pagina Vue. La configurazione include anche un'istanza di questo plugin di produzione per elaborare `src/styles.3772401f5d.css`, con aggiornamento automatico del dizionario sotto il 90% di risparmio e `dictionarySource` in `.dictionary-cache/rayban-styles.dat`: i suoi output sono separati dal manifest e dalla negoziazione del server della demo.

## Verifica

```sh
node --test test/production-plugin.test.cjs
```

I test eseguono build Webpack reali e verificano la decompressione dei DCB con i dizionari emessi e la corrispondenza degli hash nel manifest. I dizionari e i DCB sono generati nella fase [`PROCESS_ASSETS_STAGE_OPTIMIZE_TRANSFER`](https://webpack.js.org/api/compilation-hooks/#processassets), successiva alla minificazione e al calcolo degli hash degli asset. Il manifest viene emesso nella fase `PROCESS_ASSETS_STAGE_REPORT`, dopo aver raccolto i risultati di tutte le istanze.
