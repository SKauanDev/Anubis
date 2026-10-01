import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  taiwanCameraToSource,
  singaporeCameraToSource,
  icelandCameraToSource,
} from '../../server/providers/cctv/sources.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';
import { SINGAPORE_LTA_CCTV_URL } from '../../server/providers/cctv/constants.js';

test('Taiwan THB rows become pinned snapshot sources', () => {
  const source = taiwanCameraToSource({
    id: 'CCTV-35-0090-446-003',
    stakenumber: '台9線446K+500',
    gisx: 120.74472,
    gisy: 22.20391,
    html: 'https://cctv-ss05.thb.gov.tw:443/T9-446K+500',
  });
  assert.equal(source?.id, 'taiwan-thb-cctv-35-0090-446-003');
  assert.equal(source?.feedType, 'mjpeg');
  assert.equal(source?.url, 'https://cctv-ss05.thb.gov.tw/T9-446K+500');
  assert.equal(
    source?.snapshotUrl,
    'https://cctv-ss05.thb.gov.tw/T9-446K+500/snapshot',
  );
  assert.equal(source?.provider, 'Taiwan Highway Bureau');
  assert.equal(
    taiwanCameraToSource({
      id: 'safe-id',
      gisx: 121,
      gisy: 24,
      html: 'https://cctv-ss05.thb.gov.tw.evil.example/cam',
    }),
    null,
  );
});

test('Singapore LTA rows allow only the official image CDN', () => {
  const row = {
    camera_id: '2701',
    location: { latitude: 1.29531332, longitude: 103.871146 },
    image:
      'https://images.data.gov.sg/api/traffic-images/2026/09/01234567-89ab-cdef-0123-456789abcdef.jpg',
  };
  const source = singaporeCameraToSource(row);
  assert.equal(source?.id, 'singapore-lta-2701');
  assert.equal(source?.contentTypeHint, 'image/jpeg');
  assert.equal(
    singaporeCameraToSource({
      ...row,
      image:
        'https://images.data.gov.sg.evil.example/api/traffic-images/2026/09/a.jpg',
    }),
    null,
  );
});

test('Iceland rows use the image filename to distinguish station views', () => {
  const row = {
    Maelist_nr: 7001,
    Myndavel: 'Hellisheiði',
    Skyring: 'Austur',
    NrVegur: '1',
    Slod: 'https://www.vegagerdin.is/vgdata/vefmyndavelar/hellisheidi_1.jpg',
    Breidd: 64.035,
    Lengd: -21.4,
  };
  const source = icelandCameraToSource(row);
  assert.equal(source?.id, 'iceland-7001-hellisheidi_1');
  assert.equal(source?.provider, 'Vegagerðin');
  assert.equal(
    icelandCameraToSource({
      ...row,
      Slod: 'https://attacker.example/vgdata/vefmyndavelar/cam.jpg',
    }),
    null,
  );
});

test('the shipped default catalog complements rather than suppresses live packs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-cctv-global-'));
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(
    path.join(root, 'config', 'cctv_sources.austin.json'),
    JSON.stringify([
      {
        id: 'local-camera',
        name: 'Local camera',
        lat: 30.2,
        lon: -97.7,
        url: 'https://example.test/local.jpg',
      },
    ]),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  });
  delete process.env.CCTV_SOURCES_FILE;
  delete process.env.CCTV_SOURCES_JSON;
  delete process.env.CCTV_PREFER_AUSTIN;
  delete process.env.CCTV_FORCE_AUSTIN;

  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url) === SINGAPORE_LTA_CCTV_URL) {
      return Response.json({
        items: [
          {
            cameras: [
              {
                camera_id: '2701',
                location: { latitude: 1.2953, longitude: 103.8711 },
                image:
                  'https://images.data.gov.sg/api/traffic-images/2026/09/01234567-89ab-cdef-0123-456789abcdef.jpg',
              },
            ],
          },
        ],
      });
    }
    return Response.json([]);
  });

  const sources = await createCctvCatalog({ sourceRoot: root })();
  assert.ok(sources.some((source) => source.id === 'local-camera'));
  assert.ok(sources.some((source) => source.id === 'singapore-lta-2701'));
});
