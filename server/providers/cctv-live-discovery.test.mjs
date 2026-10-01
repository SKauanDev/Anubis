import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cctvLiveDiscoveryProxy,
  liveDiscoverySearchText,
  normalizeLiveDiscoveryQuery,
  normalizeYouTubeLiveResults,
} from './cctv-live-discovery.js';

test('live discovery accepts useful places and adds a webcam intent only when needed', () => {
  assert.equal(
    normalizeLiveDiscoveryQuery('  Rio de Janeiro  '),
    'Rio de Janeiro',
  );
  assert.equal(normalizeLiveDiscoveryQuery('<x>'), '');
  assert.equal(normalizeLiveDiscoveryQuery('x'), '');
  assert.equal(liveDiscoverySearchText('Copacabana'), 'Copacabana live webcam');
  assert.equal(
    liveDiscoverySearchText('Copacabana ao vivo'),
    'Copacabana ao vivo webcam',
  );
  assert.equal(
    liveDiscoverySearchText('Copacabana camera'),
    'Copacabana camera',
  );
});

test('YouTube results are reduced to fixed official URLs and trusted thumbnails', () => {
  const results = normalizeYouTubeLiveResults({
    items: [
      {
        id: { videoId: 'abcdef12345' },
        snippet: {
          title: 'Praia &amp; avenida',
          channelTitle: 'Canal Público',
          publishedAt: '2026-09-30T10:00:00Z',
          thumbnails: {
            medium: { url: 'https://i.ytimg.com/vi/id/mqdefault.jpg' },
          },
        },
      },
      {
        id: { videoId: '../not-video' },
        snippet: { title: 'Unsafe' },
      },
      {
        id: { videoId: 'abcdef12345' },
        snippet: { title: 'Duplicate' },
      },
    ],
  });
  assert.deepEqual(results, [
    {
      id: 'abcdef12345',
      title: 'Praia & avenida',
      channel: 'Canal Público',
      publishedAt: '2026-09-30T10:00:00Z',
      thumbnailUrl: 'https://i.ytimg.com/vi/id/mqdefault.jpg',
      embedUrl:
        'https://www.youtube-nocookie.com/embed/abcdef12345?autoplay=1&mute=1',
      sourceUrl: 'https://www.youtube.com/watch?v=abcdef12345',
    },
  ]);
});

function responseRecorder() {
  return {
    destroyed: false,
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

test('proxy requires a key and caches normalized official live results', async (t) => {
  const previous = process.env.YOUTUBE_DATA_API_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.YOUTUBE_DATA_API_KEY;
    else process.env.YOUTUBE_DATA_API_KEY = previous;
  });
  let handler;
  let calls = 0;
  const plugin = cctvLiveDiscoveryProxy({
    now: () => Date.parse('2026-09-30T12:00:00Z'),
    fetchImpl: async (url) => {
      calls++;
      assert.match(
        url,
        /^https:\/\/www\.googleapis\.com\/youtube\/v3\/search\?/,
      );
      assert.equal(new URL(url).searchParams.get('eventType'), 'live');
      assert.equal(new URL(url).searchParams.get('videoEmbeddable'), 'true');
      return new Response(
        JSON.stringify({
          items: [
            {
              id: { videoId: 'livevideo01' },
              snippet: { title: 'Live One', channelTitle: 'Channel' },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });
  plugin.configureServer({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/cctv-live-discovery');
        handler = callback;
      },
    },
  });
  const req = {
    method: 'GET',
    url: '/?q=Lisboa',
    socket: { remoteAddress: '127.0.0.1' },
  };

  delete process.env.YOUTUBE_DATA_API_KEY;
  const missing = responseRecorder();
  await handler(req, missing);
  assert.equal(missing.status, 503);
  assert.equal(JSON.parse(missing.body).error, 'youtube_key_missing');

  process.env.YOUTUBE_DATA_API_KEY = 'test-secret-key';
  const first = responseRecorder();
  await handler(req, first);
  assert.equal(first.status, 200);
  assert.equal(JSON.parse(first.body).cached, false);
  assert.ok(!first.body.includes('test-secret-key'));

  const second = responseRecorder();
  await handler(req, second);
  assert.equal(JSON.parse(second.body).cached, true);
  assert.equal(calls, 1);
});
