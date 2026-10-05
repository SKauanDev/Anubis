import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cctvPublicDiscoveryProxy,
  normalizeOpenCctvCamera,
  normalizePublicDiscoveryBounds,
} from './cctv-public-discovery.js';

test('public CCTV bounds are finite and geographically bounded', () => {
  assert.deepEqual(
    normalizePublicDiscoveryBounds(
      new URLSearchParams('south=-25&west=-45&north=-20&east=-39'),
    ),
    { south: -25, west: -45, north: -20, east: -39 },
  );
  assert.equal(
    normalizePublicDiscoveryBounds(
      new URLSearchParams('south=-80&west=-180&north=80&east=180'),
    ),
    null,
  );
});

test('public camera normalization keeps mapped active feeds only', () => {
  const camera = normalizeOpenCctvCamera(
    {
      id: 'windy-1',
      camera_code: 123,
      name: 'Macaé regional camera',
      city: 'Campos dos Goytacazes',
      country: 'BR',
      lat: -21.75,
      lng: -41.32,
      feed_url: 'https://images.example/camera.jpg',
      feed_type: 'image',
      source: 'windy',
      active: 1,
    },
    { lat: -22.37, lon: -41.79 },
  );
  assert.equal(camera.id, 'opencctv-windy-1');
  assert.equal(camera.feedType, 'image');
  assert.equal(camera.sourceKind, 'opencctv-public');
  assert.equal(camera.directImageUrl, 'https://images.example/camera.jpg');
  assert.ok(camera.distanceKm > 0);
});

function responseRecorder() {
  return {
    destroyed: false,
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status;
    },
    end(body) {
      this.body = body;
    },
  };
}

test('public discovery obtains the anonymous feed key and returns nearby cameras', async () => {
  let handler;
  let receivedFeedKey = '';
  const plugin = cctvPublicDiscoveryProxy({
    fetchImpl: async (url, options = {}) => {
      if (String(url).endsWith('/api/config')) {
        return new Response(JSON.stringify({ fk: 'public-test-key' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      receivedFeedKey = options.headers['X-Feed-Key'];
      if (String(url).includes('/api/cameras/feed-pool')) {
        return new Response(JSON.stringify([{ id: 'camera-1' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      assert.ok(String(url).endsWith('/api/cameras/batch'));
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { ids: ['camera-1'] });
      return new Response(
        JSON.stringify([
          {
            id: 'camera-1',
            camera_code: 987,
            name: 'Nearby live camera',
            city: 'Macaé',
            country: 'BR',
            lat: -22.37,
            lng: -41.78,
            feed_url: 'https://images.example/live.jpg',
            feed_type: 'image',
            active: 1,
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });
  plugin.configureServer({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/cctv-public-discovery');
        handler = callback;
      },
    },
  });
  const response = responseRecorder();
  await handler(
    {
      method: 'GET',
      url: '/?south=-25&west=-45&north=-20&east=-39',
      socket: { remoteAddress: '127.0.0.1' },
    },
    response,
  );
  assert.equal(response.status, 200);
  assert.equal(receivedFeedKey, 'public-test-key');
  assert.equal(JSON.parse(response.body).cameras[0].id, 'opencctv-camera-1');
  assert.ok(!response.body.includes('public-test-key'));
});
