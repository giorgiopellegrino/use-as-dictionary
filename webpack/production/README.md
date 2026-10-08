# CompressionDictionaryPlugin per la produzione

Plugin per **Webpack 5** che aggiunge alla build soltanto dizionari raw `.dat` e rappresentazioni compresse `.dcb`. Usa `brotli-wasm-custom-dictionary`, già presente nelle dipendenze del progetto. Per copiarlo in un altro progetto serve anche questa dipendenza di build.

## Un file già pronto in input

Per elaborare un CSS già pronto, indica direttamente il suo percorso con `input`. Esempio per il file presente nel progetto:

```js
const path = require('node:path');
const CompressionDictionaryPlugin = require('./webpack/production/CompressionDictionaryPlugin.cjs');

// Nell'array plugins della configurazione:
new CompressionDictionaryPlugin({
  input: path.resolve(__dirname, 'src/styles.3772401f5d.css'),
  dcbFilename: 'dist/styles.3772401f5d.css.dcb',
  dictionaryFilename: 'dictionaries/styles.[hash].dat',
});
```

La build produce questi due file, relativi a `output.path`:

```text
dist/styles.3772401f5d.css.dcb
dictionaries/styles.<sha256>.dat
```

Con `input` **non serve `test`**. Il file viene letto come byte, senza importarlo nel bundle, passarlo ai loader o risolvere `url()` e `@import`. Il dizionario contiene quei byte e il DCB si decomprime nel file originale esatto. La pubblicazione del CSS originale resta a carico della tua applicazione.

`input` può essere assoluto o relativo al `context` di Webpack. Se ometti `dcbFilename`, l'output è `<nome-file>.dcb` nella radice di `output.path`; se ometti `dictionaryFilename`, l'output è `dictionaries/<sha256>.dat`. Puoi usare più istanze con input e percorsi DCB diversi. Il file viene seguito anche in modalità watch.

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
```

Sia con `input` sia con `test`, senza altre opzioni il `.dat` contiene gli stessi byte della risorsa da comprimere. Non c'è un processo di training: quei byte sono il dizionario esterno usato dall'encoder. Il suo nome usa il SHA-256 completo, in esadecimale; lo stesso hash, nei suoi 32 byte binari, è incluso nell'header DCB.

In questa modalità, se cambia la risorsa cambia anche il dizionario. Un DCB molto piccolo non elimina il costo di scaricare il dizionario, che contiene l'intera risorsa. Per riutilizzare un dizionario già disponibile tra diverse release, configura una snapshot stabile.

## Riutilizzare una snapshot precedente

```js
new CompressionDictionaryPlugin({
  test: /^dist\/styles\.[a-f0-9]+\.css$/,
  dictionarySource: 'dictionaries/styles.v1.css',
});
```

`dictionarySource` è un percorso assoluto o relativo al `context` di Webpack. Il plugin legge e pubblica **esattamente quei byte**, senza minificarli o convertirli in testo. Puoi indicare direttamente il CSS minificato di una release precedente, oppure un `.dat` già prodotto. Questa opzione funziona anche insieme a `input`: `input` è il file corrente da comprimere, `dictionarySource` è la snapshot da usare come dizionario.

Tutti gli asset selezionati da questa istanza usano la stessa snapshot. Finché la snapshot resta invariata, il dizionario mantiene contenuto, hash e nome; i DCB vengono ricreati dal contenuto corrente. Il file è registrato tra le dipendenze di Webpack, anche in modalità watch.

## Più istanze

```js
plugins: [
  new CompressionDictionaryPlugin({
    test: /^dist\/main\.[a-f0-9]+\.css$/,
    dictionarySource: 'snapshots/main.css',
    dictionaryFilename: 'dictionaries/main.[hash].dat',
  }),
  new CompressionDictionaryPlugin({
    test: /^dist\/vendor\.[a-f0-9]+\.js$/,
    dictionarySource: 'snapshots/vendor.js',
    dictionaryFilename: 'dictionaries/vendor.[hash].dat',
  }),
]
```

Ogni istanza seleziona i propri asset. Il plugin lavora su byte e può comprimere anche JavaScript e altre risorse. I selettori devono essere disgiunti: due istanze che tentano di produrre lo stesso `.dcb` fanno fallire la build. Dizionari identici con lo stesso nome di output vengono invece condivisi.

## Opzioni

| Opzione | Valore predefinito | Significato |
| --- | --- | --- |
| `input` | Alternativo a `test` | Percorso del file già pronto da comprimere, assoluto o relativo al `context`. |
| `test` | Alternativo a `input` | Nome esatto o `RegExp` per gli asset finali da comprimere. Nessuna corrispondenza fa fallire la build. |
| `dcbFilename` | `<nome-file>.dcb` | Percorso DCB relativo a `output.path`, disponibile solo con `input`. |
| `dictionarySource` | Byte della risorsa da comprimere | Snapshot raw comune alle risorse dell'istanza. |
| `dictionaryFilename` | `dictionaries/[hash].dat` | Percorso relativo a `output.path`; l'unico segnaposto supportato è `[hash]`, SHA-256 completo del dizionario. |
| `quality` | `11` | Qualità Brotli, intero da `0` a `11`. |

Devi specificare esattamente uno tra `input` e `test`. Con `test` il nome del DCB è sempre `<nome-asset>.dcb`; con `input` puoi impostarlo tramite `dcbFilename`, che è un percorso letterale senza segnaposto. I percorsi di output usano `/`; percorsi assoluti, attraversamenti `..`, collisioni e sovrascritture dei file di input sono rifiutati. Ogni dizionario deve contenere da 1 a `2**22 - 16` byte, limite della finestra dell'encoder utilizzato. Una risorsa vuota può essere compressa se è configurata una snapshot non vuota.

## Integrazione HTTP e demo

La configurazione del server gestisce `Use-As-Dictionary` e il relativo `match`, la discovery del dizionario e la selezione della rappresentazione sulla base di `Accept-Encoding` e `Available-Dictionary`. Per una risposta DCB usa `Content-Encoding: dcb` e gestisci `Vary`; la risorsa originale resta disponibile per il fallback. Il formato e la negoziazione sono descritti nella [RFC 9842](https://www.rfc-editor.org/rfc/rfc9842.html#section-6).

Il plugin non genera manifest, ID HTTP, link HTML, varianti `.br`/`.gz` o configurazioni del server. Non richiede `HtmlWebpackPlugin` e non modifica gli altri asset. Il nome esadecimale del dizionario non è il valore di `Available-Dictionary`: quell'header usa il SHA-256 dei byte del `.dat` codificato in base64.

La demo esistente usa il plugin in `webpack/CompressionDictionaryPlugin.cjs`, con manifest e statistiche per la pagina Vue. La configurazione include anche un'istanza di questo plugin di produzione per elaborare `src/styles.3772401f5d.css`: i suoi output sono separati dal manifest e dalla negoziazione del server della demo.

## Verifica

```sh
node --test test/production-plugin.test.cjs
```

I test eseguono build Webpack reali e verificano la decompressione dei DCB con i dizionari emessi. La fase usata è [`PROCESS_ASSETS_STAGE_OPTIMIZE_TRANSFER`](https://webpack.js.org/api/compilation-hooks/#processassets), successiva alla minificazione e al calcolo degli hash degli asset.
