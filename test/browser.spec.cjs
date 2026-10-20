const { test, expect } = require('@playwright/test');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

test('Il browser negozia DCB, decodifica il CSS e applica il foglio di stile', async ({ page }, testInfo) => {
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    browserErrors.push(`${request.url()}: ${request.failure()?.errorText}`);
  });

  try {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => window.isSecureContext)).toBe(true);

    const metrics = await page.evaluate(async () => {
      const response = await fetch('/api/demo-stats');
      if (!response.ok) throw new Error(`Statistiche HTTP ${response.status}`);
      return response.json();
    });
    expect(metrics.manifestUrl).toBe('/dictionaries/compression-dictionary-manifest.json');
    const manifest = await page.evaluate(async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Manifest produzione HTTP ${response.status}`);
      return response.json();
    }, metrics.manifestUrl);
    const resource = metrics.resources.find((item) => item.url.endsWith('.css'));
    expect(resource, 'Le statistiche devono indicare il CSS prodotto dalla build').toBeTruthy();
    const dictionary = metrics.dictionary;
    const dictionaryEntry = manifest.dictionaries[dictionary.url.slice(1)];
    expect(dictionaryEntry.sha256Base64).toBe(dictionary.sha256Base64);
    expect(resource.dictionaryUrl).toBe(dictionary.url);
    const discoveryUrls = await page.locator('head link[rel="compression-dictionary"]').evaluateAll(
      (links) => links.map((link) => link.getAttribute('href')),
    );
    expect(discoveryUrls.sort()).toEqual(Object.keys(manifest.dictionaries).map((name) => `/${name}`).sort());
    expect(await page.locator('head').evaluate((head) => {
      const dictionaryLink = head.querySelector('link[rel="compression-dictionary"]');
      const stylesheet = head.querySelector('link[rel="stylesheet"]');
      return Boolean(dictionaryLink.compareDocumentPosition(stylesheet) & Node.DOCUMENT_POSITION_FOLLOWING);
    })).toBe(true);
    const sourceCss = await readFile(path.join(testInfo.project.metadata.buildDir, resource.url.slice(1)), 'utf8');

    // Lettura completa: Chrome registra il dizionario solo dopo averne ricevuto il corpo.
    const dictionaryBytes = await page.evaluate(async (dictionaryUrl) => {
      const response = await fetch(dictionaryUrl);
      if (!response.ok) throw new Error(`Dizionario HTTP ${response.status}`);
      return (await response.arrayBuffer()).byteLength;
    }, dictionary.url);
    expect(dictionaryBytes).toBe(dictionary.bytes);

    let attempt = 0;
    let negotiated;
    await expect.poll(async () => {
      const probeUrl = new URL(resource.url, page.url());
      probeUrl.searchParams.set('dcb-e2e', `${Date.now()}-${++attempt}`);
      const requestPromise = page.waitForRequest(probeUrl.href);
      const decoded = await page.evaluate(async (url) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`CSS HTTP ${response.status}`);
        return { encoding: response.headers.get('content-encoding'), text: await response.text() };
      }, probeUrl.href);
      negotiated = { ...decoded, request: await requestPromise };
      return negotiated.encoding;
    }, {
      message: 'Chrome deve registrare il dizionario e ricevere Content-Encoding: dcb',
      timeout: 10_000,
      intervals: [100, 250, 500, 1_000],
    }).toBe('dcb');

    // La decodifica avviene nello stack HTTP nativo, senza WASM o header imposti dal test.
    expect(negotiated.text).toBe(sourceCss);
    const requestHeaders = await negotiated.request.allHeaders();
    expect(requestHeaders['available-dictionary']).toBe(`:${dictionaryEntry.sha256Base64}:`);
    expect(requestHeaders['dictionary-id']).toBe(JSON.stringify(dictionary.id));
    expect(requestHeaders['accept-encoding'].split(',').map((value) => value.trim())).toContain('dcb');

    await page.getByRole('button', { name: 'Test the transfer', exact: true }).click();
    await expect(page.getByTestId('transfer-encoding')).toHaveText('dcb');
    await expect(page.locator('.probe-status')).toHaveText('DCB received');

    // Rimuove il CSS iniziale: il controllo successivo deve dipendere dalla risposta DCB.
    await page.evaluate(() => {
      document.querySelectorAll('link[rel~="stylesheet"], style').forEach((element) => element.remove());
    });
    expect(await page.evaluate(() => getComputedStyle(document.documentElement)
      .getPropertyValue('--demo-stylesheet-version').trim())).toBe('');

    const stylesheetUrl = new URL(resource.url, page.url());
    stylesheetUrl.searchParams.set('dcb-e2e-stylesheet', String(Date.now()));
    const [stylesheetResponse, appliedStylesheet] = await Promise.all([
      page.waitForResponse(stylesheetUrl.href),
      page.evaluate(async (url) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = url;
        await new Promise((resolve, reject) => {
          link.onload = resolve;
          link.onerror = () => reject(new Error('Caricamento del CSS DCB fallito'));
          document.head.append(link);
        });
        return {
          rules: link.sheet.cssRules.length,
          version: getComputedStyle(document.documentElement)
            .getPropertyValue('--demo-stylesheet-version').trim(),
        };
      }, stylesheetUrl.href),
    ]);
    expect(stylesheetResponse.headers()['content-encoding']).toBe('dcb');
    expect(appliedStylesheet.rules).toBeGreaterThan(0);
    expect(appliedStylesheet.version).toBe('2');

    // La pagina resta utilizzabile anche sul viewport di un telefono.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(browserErrors, 'Errori JavaScript, console o richieste fallite').toEqual([]);
  } finally {
    if (browserErrors.length) {
      await testInfo.attach('browser-errors', {
        body: browserErrors.join('\n'),
        contentType: 'text/plain',
      });
    }
  }
});
