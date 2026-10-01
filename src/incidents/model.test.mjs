import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deduplicateIncidents,
  geometryAnchor,
  normalizeAirQualityPayload,
  normalizeEonetPayload,
  normalizeGdacsPayload,
  normalizeNdbcLatestObservations,
  normalizeNwsAlertsPayload,
} from './model.js';

test('geometryAnchor resolves Point and polygon geometry', () => {
  assert.deepEqual(geometryAnchor({ coordinates: [-46.63, -23.55] }), {
    lon: -46.63,
    lat: -23.55,
  });
  assert.deepEqual(
    geometryAnchor({
      coordinates: [
        [
          [10, 20],
          [12, 22],
        ],
      ],
    }),
    { lon: 11, lat: 21 },
  );
});

test('EONET normalizer uses the newest valid geometry', () => {
  const rows = normalizeEonetPayload({
    events: [
      {
        id: 'EONET_1',
        title: 'Example wildfire',
        categories: [{ id: 'wildfires' }],
        sources: [{ id: 'Source', url: 'https://example.com/event' }],
        geometry: [
          { date: '2026-09-01T00:00:00Z', coordinates: [1, 2] },
          { date: '2026-09-02T00:00:00Z', coordinates: [3, 4] },
        ],
      },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'eonet:EONET_1');
  assert.equal(rows[0].category, 'fire');
  assert.equal(rows[0].lon, 3);
  assert.equal(rows[0].lat, 4);
});

test('GDACS normalizer maps alert level and event category', () => {
  const rows = normalizeGdacsPayload({
    features: [
      {
        geometry: { type: 'Point', coordinates: [140.2, 35.4] },
        properties: {
          eventtype: 'EQ',
          eventid: '123',
          name: 'M 6.3 earthquake',
          alertlevel: 'Red',
          fromdate: '2026-09-29T00:00:00Z',
        },
      },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, 'earthquake');
  assert.equal(rows[0].severity, 'high');
  assert.match(rows[0].url, /gdacs\.org/);
});

test('air quality normalizer maps AQI thresholds and readings', () => {
  const rows = normalizeAirQualityPayload([
    {
      latitude: -23.5,
      longitude: -46.6,
      current: {
        time: '2026-09-30T12:00',
        us_aqi: 122,
        pm2_5: 41.2,
        pm10: 58.1,
        ozone: 77,
      },
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, 'air-quality');
  assert.equal(rows[0].severity, 'medium');
  assert.match(rows[0].summary, /PM2\.5 41\.2/);
});

test('NDBC normalizer parses current buoy observations', () => {
  const rows = normalizeNdbcLatestObservations(
    '# header\n41002 31.743 -74.955 2026 09 30 17 10 90 20.0 26.0 6.5 12 8.0 114 1018.8 MM 26.5 28.0 23.5 MM MM',
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'ndbc:41002');
  assert.equal(rows[0].category, 'ocean');
  assert.equal(rows[0].severity, 'high');
  assert.match(rows[0].summary, /ondas 6\.5 m/);
});

test('NWS normalizer keeps georeferenced official alerts', () => {
  const rows = normalizeNwsAlertsPayload({
    features: [
      {
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-80, 25],
              [-78, 25],
              [-78, 27],
              [-80, 27],
            ],
          ],
        },
        properties: {
          id: 'alert-1',
          event: 'Hurricane Warning',
          headline: 'Hurricane Warning issued',
          severity: 'Extreme',
          sent: '2026-09-30T12:00:00Z',
          description: 'Dangerous conditions expected.',
          '@id': 'https://api.weather.gov/alerts/alert-1',
        },
      },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, 'alert');
  assert.equal(rows[0].severity, 'high');
  assert.equal(rows[0].lat, 26);
  assert.equal(rows[0].lon, -79);
});

test('deduplication merges similar cross-provider events but keeps sources', () => {
  const common = {
    title: 'Major flood near Sample City',
    category: 'flood',
    categoryLabel: 'Enchente',
    severity: 'medium',
    lat: 10,
    lon: 20,
    occurredAt: 1,
    updatedAt: 2,
    summary: '',
    status: 'active',
    url: null,
  };
  const result = deduplicateIncidents([
    {
      ...common,
      id: 'gdacs:1',
      source: 'GDACS',
      sourceCode: 'gdacs',
      sources: [{ code: 'gdacs', name: 'GDACS', url: null }],
    },
    {
      ...common,
      id: 'eonet:1',
      source: 'NASA EONET',
      sourceCode: 'eonet',
      lat: 10.1,
      lon: 20.1,
      sources: [{ code: 'eonet', name: 'NASA EONET', url: null }],
    },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].sources.length, 2);
});
