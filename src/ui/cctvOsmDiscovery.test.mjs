import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  CctvOsmDiscovery,
  normalizeOsmWebcamElement,
  osmSearchBbox,
  osmSearchBboxes,
  osmWebcamQuery,
  safeOsmWebcamUrl,
} from './cctvOsmDiscovery.js';

test('OSM webcam query is bounded and requests tags plus centers', () => {
  const query = osmWebcamQuery({
    south: 38.6,
    west: -9.3,
    north: 38.9,
    east: -9,
  });
  assert.match(
    query,
    /\["contact:webcam"\]\(38\.600000,-9\.300000,38\.900000,-9\.000000\)/,
  );
  assert.match(query, /out center tags/);
  assert.match(query, /\["webcam:url"\]/);
  assert.match(
    query,
    /\["man_made"="surveillance"\]\["surveillance:type"="camera"\]\["website"\]/,
  );
});

test('OSM webcam records require coordinates and a safe public URL', () => {
  const record = normalizeOsmWebcamElement({
    type: 'node',
    id: 42,
    lat: 38.72,
    lon: -9.14,
    tags: {
      name: 'Praça ao vivo',
      'contact:webcam': 'https://www.youtube.com/watch?v=abcdef12345',
      'camera:direction': 'NE',
      height: '18 m',
      operator: 'Município',
    },
  });
  assert.equal(record.id, 'node-42');
  assert.equal(record.kind, 'TRANSMISSÃO INCORPORÁVEL');
  assert.equal(
    record.embedUrl,
    'https://www.youtube-nocookie.com/embed/abcdef12345?autoplay=1&mute=1',
  );
  assert.equal(record.headingDeg, 45);
  assert.equal(record.mountHeightM, 18);
  assert.equal(record.operator, 'Município');
  assert.equal(safeOsmWebcamUrl('http://127.0.0.1/camera'), '');
  assert.equal(
    normalizeOsmWebcamElement({
      id: 1,
      tags: { 'contact:webcam': 'https://example.com' },
    }),
    null,
  );
});

test('geocoded viewport is clamped to a regional Overpass bbox', () => {
  const bbox = osmSearchBbox({
    geometry: {
      location: { lat: 0, lng: 0 },
      viewport: {
        southwest: { lat: -40, lng: -80 },
        northeast: { lat: 40, lng: 80 },
      },
    },
  });
  assert.deepEqual(bbox, { south: -0.6, west: -0.6, north: 0.6, east: 0.6 });
});

test('OSM search boxes widen from the city to nearby regional cameras', () => {
  const boxes = osmSearchBboxes({
    geometry: { location: { lat: -23.55, lng: -46.63 } },
  });
  assert.deepEqual(
    boxes.map((box) => box.radiusKm),
    [35, 120, 300],
  );
  assert.ok(boxes[0].north - boxes[0].south < boxes[2].north - boxes[2].south);
});

test('OSM discovery geocodes, queries Overpass, and keeps mapped webcams', async () => {
  const requests = [];
  const status = { textContent: '', dataset: {} };
  const searchButton = { disabled: false, addEventListener() {} };
  const discovery = new CctvOsmDiscovery({
    elements: {
      _queryInput: { value: 'Lisboa', focus() {}, addEventListener() {} },
      _searchButton: searchButton,
      _status: status,
    },
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (String(url).startsWith('/api/geocode')) {
        return new Response(
          JSON.stringify({
            status: 'OK',
            results: [{ geometry: { location: { lat: 38.72, lng: -9.14 } } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          elements: [
            {
              type: 'node',
              id: 7,
              lat: 38.7,
              lon: -9.1,
              tags: {
                'contact:webcam': 'https://example.com/live',
                name: 'Lisboa',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });
  await discovery.search();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, '/api/overpass');
  assert.match(requests[1].options.body, /^data=/);
  assert.equal(discovery.results.length, 1);
  assert.equal(status.dataset.state, 'ok');
  assert.equal(searchButton.disabled, false);
  discovery.destroy();
});

test('CCTV markup includes OpenStreetMap in the unified discovery surface', () => {
  const markup = readFileSync(
    new URL('./templates/layer-panels.html', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(markup, /id="cctv-mode-osm"/);
  assert.match(markup, /OPENSTREETMAP\/ODbL/);
});
