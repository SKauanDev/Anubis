import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  loadOsirisWorldWebcamSources,
  osirisWebcamToSource,
} from '../../server/providers/cctv/osirisSources.js';
import {
  extractYouTubeLiveState,
  resolvePublicWebcam,
} from '../../server/providers/cctv/resolve.js';

test('worldwide public webcam catalog preserves live, embed, and external modes', () => {
  const sources = loadOsirisWorldWebcamSources();
  const counts = sources.reduce((result, source) => {
    result[source.feedType] = (result[source.feedType] || 0) + 1;
    return result;
  }, {});
  assert.equal(sources.length, 917);
  assert.deepEqual(counts, { external: 904, hls: 10, iframe: 3 });
  assert.ok(sources.every((source) => source.lat >= -90 && source.lat <= 90));
  assert.ok(sources.every((source) => source.lon >= -180 && source.lon <= 180));
});

test('OSIRIS proxy-shaped previews are decoded only to HTTPS upstreams', () => {
  const source = osirisWebcamToSource({
    id: 'sky-test',
    lat: 1,
    lng: 2,
    name: 'Test',
    city: 'Test City',
    country: 'Test Country',
    feed_url:
      '/api/cctv/proxy?url=https%3A%2F%2Fcdn.skylinewebcams.com%2Flive1.jpg',
    external_url: 'https://www.skylinewebcams.com/en/webcam/test.html',
    source: 'SkylineWebcams',
  });
  assert.equal(source.feedType, 'external');
  assert.equal(source.snapshotUrl, 'https://cdn.skylinewebcams.com/live1.jpg');
  assert.equal(
    osirisWebcamToSource({
      id: 'unsafe',
      lat: 1,
      lng: 2,
      feed_url: '/api/cctv/proxy?url=http%3A%2F%2Fexample.test%2Fcam.jpg',
    })?.snapshotUrl,
    '',
  );
});

test('YouTube live parsing rejects offline and non-embeddable broadcasts', () => {
  const live =
    '"playabilityStatus":{"status":"OK","playableInEmbed":true}' +
    '"videoDetails":{"videoId":"LosHr1bonAA","isLive":true}' +
    '"liveBroadcastDetails":{"isLiveNow":true}';
  assert.deepEqual(extractYouTubeLiveState(live), {
    live: true,
    embeddable: true,
    videoId: 'LosHr1bonAA',
  });
  assert.equal(
    extractYouTubeLiveState(live.replace('true}', 'false}')).embeddable,
    false,
  );
  assert.equal(
    extractYouTubeLiveState(live.replace('"isLiveNow":true', '')).live,
    false,
  );
});

test('resolver returns a player only for a live YouTube channel that permits embeds', async () => {
  const page =
    '"playabilityStatus":{"status":"OK","playableInEmbed":true}' +
    '"videoDetails":{"videoId":"LosHr1bonAA","isLive":true}' +
    '"liveBroadcastDetails":{"isLiveNow":true}';
  const result = await resolvePublicWebcam(
    { externalUrl: 'https://www.youtube.com/@test-live-camera/live' },
    { fetchImpl: async () => new Response(page) },
  );
  assert.equal(result.embeddable, true);
  assert.match(result.embedUrl, /youtube-nocookie\.com\/embed\/LosHr1bonAA/);

  const blocked = await resolvePublicWebcam(
    { externalUrl: 'https://www.youtube.com/@test-blocked-camera/live' },
    {
      fetchImpl: async () =>
        new Response(
          page.replace('"playableInEmbed":true', '"playableInEmbed":false'),
        ),
    },
  );
  assert.deepEqual(blocked, {
    embeddable: false,
    kind: 'embed-disabled',
  });
});
