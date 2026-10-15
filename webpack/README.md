# CompressionDictionaryPlugin

Plugin per **Webpack 5** che emette dizionari raw `.dat`, rappresentazioni Shared Brotli `.dcb` e `dist/compression-dictionary-manifest.json`. Il file `webpack/CompressionDictionaryPlugin.cjs` conserva il codice del plugin di produzione. Richiede `brotli-wasm-custom-dictionary`, presente nelle dipendenze di build.

## Configurazione della demo

```js
const CompressionDictionaryPlugin = require('./webpack/CompressionDictionaryPlugin.cjs');

new CompressionDictionaryPlugin({
  test: /^dist\/styles\.[a-f0-9]+\.css$/,
  dictionarySource: '.dictionary-cache/styles.dat',
  autoUpdate: { minSavings: 0.9 },
});
```

`test` seleziona il nome finale dell'asset, relativo a `output.path`. Il plugin legge i byte dopo minificazione e calcolo del content hash. Con la configurazione della demo produce:

```text
build/dictionaries/styles.<sha256>.dat
build/dist/styles.<contenthash>.css.dcb
build/dist/compression-dictionary-manifest.json
```

Il CSS originale rimane disponibile. Il plugin non modifica l'HTML; discovery, header e compressione HTTP standard sono gestiti dal server.

## Persistenza e aggiornamento

Con `autoUpdate`, `dictionarySource` è il file persistente da leggere e aggiornare. Deve stare fuori da `output.path` per sopravvivere a `output.clean`.

1. Se il file manca, il plugin crea il dizionario dai byte della risorsa corrente.
2. Se esiste, prova a comprimere la risorsa con quel dizionario.
3. Calcola `1 - dcb.length / resource.length`, includendo i 36 byte dell'header DCB. Sotto `minSavings` rigenera il dizionario dalla risorsa corrente e ricomprime.

La cache viene scritta atomicamente dopo una build riuscita e non viene riscritta quando i byte sono invariati. Conserva `.dictionary-cache/styles.dat` tra le build e ripristinalo in CI. Il nome pubblicato deriva dal nome di questo file e dal SHA-256 completo dei suoi byte; rimane stabile quando il dizionario viene riutilizzato.

La soglia predefinita `0.9` confronta DCB con i byte non compressi, non con Brotli standard, ed esclude il costo iniziale del dizionario. Su risorse piccole l'header può impedire di raggiungerla anche con un dizionario nuovo. La modalità automatica richiede una sola risorsa per istanza.

## Manifest e integrazione HTTP

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

Le chiavi sono percorsi relativi a `output.path`. `sha256Base64` è il SHA-256 dei byte raw del dizionario in Base64; `availableDictionary` contiene lo stesso valore tra `:`. Il manifest raccoglie i dizionari delle istanze del plugin e non contiene una mappa delle risorse.

Ogni DCB inizia con `ff 44 43 42`, seguito dai 32 byte del digest del dizionario e dallo stream Shared Brotli. Il server della demo usa questo digest per associare il CSS alla voce del manifest e verifica l'hash del `.dat` pubblicato.

Il server legge il manifest a ogni richiesta e inserisce il link al dizionario nell'`head` prima di comprimere l'HTML. Serve DCB quando `Accept-Encoding` lo accetta e `Available-Dictionary` corrisponde al `sha256Base64` del dizionario associato. Gestisce `Use-As-Dictionary`, `Vary` e i fallback Brotli/gzip generati a runtime con `node:zlib`.

Il manifest pubblico è `/dist/compression-dictionary-manifest.json`. `/api/demo-stats` contiene soltanto le misure della demo, calcolate dal server.

## Opzioni supportate

| Opzione | Significato |
| --- | --- |
| `test` | Nome esatto o regex per gli asset finali; alternativo a `input`. Nessuna corrispondenza fa fallire la build. |
| `input` | File pronto da comprimere, assoluto o relativo al `context`; letto senza loader o minificazione. Alternativo a `test`. |
| `dcbFilename` | Percorso di output disponibile con `input`; default `<nome-file>.dcb`. Con `test` il nome è sempre `<nome-asset>.dcb`. |
| `dictionarySource` | Dizionario raw da leggere; con `autoUpdate` è obbligatorio e viene creato o aggiornato dal plugin. Senza questa opzione il dizionario contiene i byte della risorsa. |
| `autoUpdate` | `{ minSavings: 0.9 }`: abilita riuso e rotazione del dizionario persistente. |
| `quality` | Qualità Brotli da `0` a `11`; default `11`. |

Specifica esattamente uno tra `input` e `test`. Senza `autoUpdate`, `dictionarySource` è letto senza essere modificato. I percorsi di output sono relativi, usano `/` e non possono contenere attraversamenti `..`. I dizionari devono contenere da 1 a `2**22 - 16` byte. Per più risorse con aggiornamento automatico, usa istanze con selettori e file persistenti distinti.

Esegui `npm test` dalla radice per verificare il plugin insieme al server; `npm run test:browser` verifica il trasferimento e la decodifica nativa nella demo.
