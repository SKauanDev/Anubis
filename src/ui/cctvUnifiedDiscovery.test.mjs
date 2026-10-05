import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CctvUnifiedDiscovery,
  osmWebcamCameraSource,
  youtubeBroadcastCameraSource,
} from './cctvUnifiedDiscovery.js';

test('OSM webcams become ordinary CCTV camera sources', () => {
  const source = osmWebcamCameraSource(
    {
      id: 'node-42',
      name: 'Praça central',
      lat: 38.71,
      lon: -9.13,
      sourceUrl: 'https://camera.example/live.jpg',
      embedUrl: '',
    },
    'Lisboa',
  );
  assert.equal(source.id, 'osm-webcam-node-42');
  assert.equal(source.feedType, 'image');
  assert.equal(source.directImageUrl, 'https://camera.example/live.jpg');
  assert.equal(source.city, 'Lisboa');
});

test('unified discovery widens an empty OSM city search until a nearby webcam is found', async () => {
  let overpassCalls = 0;
  let added = [];
  const discovery = new CctvUnifiedDiscovery({
    elements: {
      _queryInput: { value: 'São Paulo', focus() {}, addEventListener() {} },
      _searchButton: { disabled: false, addEventListener() {} },
      _status: { textContent: '', dataset: {} },
    },
    onSources: async (sources) => {
      added = sources;
    },
    fetchImpl: async (url) => {
      if (String(url).startsWith('/api/geocode')) {
        return new Response(
          JSON.stringify({
            results: [
              {
                formatted_address: 'São Paulo, SP, Brasil',
                geometry: { location: { lat: -23.55, lng: -46.63 } },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url === '/api/cctv-live-discovery') throw new Error('unexpected');
      if (String(url).startsWith('/api/cctv-live-discovery')) {
        return new Response(JSON.stringify({ broadcasts: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (String(url).startsWith('/api/cctv-public-discovery')) {
        return new Response(
          JSON.stringify({
            cameras: [
              {
                id: 'opencctv-nearby-1',
                name: 'Nearby public camera',
                sourceKind: 'opencctv-public',
                lat: -23.2,
                lon: -46.3,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      overpassCalls++;
      const elements =
        overpassCalls === 3
          ? [
              {
                type: 'node',
                id: 91,
                lat: -23.1,
                lon: -46.2,
                tags: { 'contact:webcam': 'https://example.com/camera.jpg' },
              },
            ]
          : [];
      return new Response(JSON.stringify({ elements }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  await discovery.search();
  assert.equal(overpassCalls, 3);
  assert.equal(added[0].id, 'osm-webcam-node-91');
  assert.ok(added.some((camera) => camera.id === 'opencctv-nearby-1'));
  discovery.destroy();
});

test('YouTube webcam broadcasts become contextual CCTV sources', () => {
  const source = youtubeBroadcastCameraSource(
    {
      id: 'abcdef12345',
      title: 'Lisboa live webcam',
      channel: 'Webcams públicas',
      embedUrl:
        'https://www.youtube-nocookie.com/embed/abcdef12345?autoplay=1&mute=1',
      sourceUrl: 'https://www.youtube.com/watch?v=abcdef12345',
    },
    {
      formatted_address: 'Lisboa, Portugal',
      geometry: { location: { lat: 38.7223, lng: -9.1393 } },
    },
  );
  assert.equal(source.id, 'youtube-live-abcdef12345');
  assert.equal(source.feedType, 'iframe');
  assert.equal(source.city, 'Lisboa, Portugal');
  assert.ok(Math.abs(source.lat - 38.7223) < 0.01);
  assert.ok(Math.abs(source.lon + 9.1393) < 0.01);
});

test('visible globe bounds load OpenCCTV directly and deduplicate visited areas', async () => {
  const deliveries = [];
  let requests = 0;
  const discovery = new CctvUnifiedDiscovery({
    elements: {},
    onSources: async (sources, context) =>
      deliveries.push({ sources, context }),
    fetchImpl: async (url) => {
      requests++;
      if (String(url).startsWith('/api/cctv-public-discovery')) {
        return new Response(
          JSON.stringify({
            cameras: [
              {
                id: 'opencctv-visible-1',
                name: 'Visible public camera',
                sourceKind: 'opencctv-public',
                lat: -22.37,
                lon: -41.78,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ elements: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const bounds = { south: -22.8, west: -42.2, north: -22, east: -41.4 };
  await discovery.discoverBounds(bounds);
  await discovery.discoverBounds(bounds);
  assert.equal(requests, 2);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].sources[0].id, 'opencctv-visible-1');
  assert.equal(deliveries[0].context.publicCount, 1);
  assert.equal(deliveries[0].context.focus, false);
  discovery.destroy();
});
