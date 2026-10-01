import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CctvLiveDiscovery, validLiveBroadcast } from './cctvLiveDiscovery.js';

test('discovery player accepts only server-shaped official YouTube URLs', () => {
  assert.equal(
    validLiveBroadcast({
      id: 'abcdef12345',
      title: 'Live camera',
      embedUrl:
        'https://www.youtube-nocookie.com/embed/abcdef12345?autoplay=1&mute=1',
      sourceUrl: 'https://www.youtube.com/watch?v=abcdef12345',
    }),
    true,
  );
  assert.equal(
    validLiveBroadcast({
      id: 'abcdef12345',
      title: 'Live camera',
      embedUrl: 'https://evil.example/embed/abcdef12345',
      sourceUrl: 'https://www.youtube.com/watch?v=abcdef12345',
    }),
    false,
  );
});

test('CCTV markup exposes separate catalog and opt-in live discovery modes', () => {
  const markup = readFileSync(
    new URL('./templates/layer-panels.html', import.meta.url),
    'utf8',
  );
  assert.match(markup, /id="cctv-mode-catalog"/);
  assert.match(markup, /id="cctv-mode-discovery"/);
  assert.match(markup, /id="cctv-catalog-view"/);
  assert.match(markup, /id="cctv-discovery-player"/);
  assert.match(markup, /Os resultados não representam coordenadas verificadas/);
});

test('live discovery default fetch keeps the browser global as its receiver', async (t) => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  globalThis.fetch = async function (url) {
    calls++;
    assert.equal(this, globalThis);
    assert.match(url, /q=Lisboa/);
    return new Response(JSON.stringify({ broadcasts: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const status = { textContent: '', dataset: {} };
  const searchButton = { disabled: false, addEventListener() {} };
  const discovery = new CctvLiveDiscovery({
    elements: {
      _queryInput: { value: 'Lisboa', focus() {}, addEventListener() {} },
      _searchButton: searchButton,
      _status: status,
    },
  });
  await discovery.search();
  assert.equal(calls, 1);
  assert.equal(searchButton.disabled, false);
  assert.equal(status.dataset.state, 'empty');
  discovery.destroy();
});

test('missing YouTube key exposes the in-app setup action', async () => {
  let setupClicks = 0;
  let setupHandler = null;
  const setupButton = {
    hidden: true,
    addEventListener(_type, handler) {
      setupHandler = handler;
    },
  };
  const status = { textContent: '', dataset: {} };
  const discovery = new CctvLiveDiscovery({
    elements: {
      _queryInput: {
        value: 'Rio de Janeiro',
        focus() {},
        addEventListener() {},
      },
      _searchButton: { disabled: false, addEventListener() {} },
      _setupButton: setupButton,
      _status: status,
    },
    onSetupRequest: () => setupClicks++,
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: 'youtube_key_missing' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
  });
  await discovery.search();
  assert.equal(setupButton.hidden, false);
  assert.equal(status.dataset.state, 'error');
  setupHandler();
  assert.equal(setupClicks, 1);
  discovery.destroy();
});
