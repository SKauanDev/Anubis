import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

const OPEN_CCTV_ORIGIN = 'https://opencctv.org';
const CACHE_TTL_MS = 10 * 60_000;
const CONFIG_TTL_MS = 60 * 60_000;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const MAX_RESULTS = 60;
const PRIVATE_HOST =
  /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[?::1\]?)$/i;

function finite(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max
    ? number
    : null;
}

export function normalizePublicDiscoveryBounds(searchParams) {
  const south = finite(searchParams.get('south'), -90, 90);
  const west = finite(searchParams.get('west'), -180, 180);
  const north = finite(searchParams.get('north'), -90, 90);
  const east = finite(searchParams.get('east'), -180, 180);
  if (
    [south, west, north, east].includes(null) ||
    south >= north ||
    west >= east ||
    north - south > 8 ||
    east - west > 12
  ) {
    return null;
  }
  return { south, west, north, east };
}

function publicHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || PRIVATE_HOST.test(url.hostname)) return '';
    return url.href;
  } catch {
    return '';
  }
}

function distanceKm(aLat, aLon, bLat, bLon) {
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function normalizeOpenCctvCamera(camera, center) {
  const id = String(camera?.id || '').trim();
  const lat = finite(camera?.lat, -90, 90);
  const lon = finite(camera?.lng, -180, 180);
  const cameraCode = String(camera?.camera_code || '').replace(/\D/g, '');
  if (!id || lat === null || lon === null || !cameraCode || !camera?.active)
    return null;
  const feedUrl = publicHttpsUrl(camera.feed_url);
  const upstreamType = String(camera.feed_type || '').toLowerCase();
  const directImageUrl = upstreamType === 'image' ? feedUrl : '';
  const directMediaUrl = ['hls', 'mjpeg', 'mp4', 'webm'].includes(upstreamType)
    ? feedUrl
    : '';
  const pageUrl = `${OPEN_CCTV_ORIGIN}/cam/${cameraCode}`;
  const feedType = directImageUrl
    ? 'image'
    : directMediaUrl
      ? upstreamType
      : 'iframe';
  return {
    id: `opencctv-${id}`,
    name: String(camera.name || camera.city || 'Public webcam').slice(0, 160),
    city: String(camera.city || camera.state || 'Public camera').slice(0, 120),
    country: String(camera.country || '').slice(0, 4),
    provider: `OpenCCTV${camera.source ? ` · ${String(camera.source).slice(0, 40)}` : ''}`,
    sourceKind: 'opencctv-public',
    feedType,
    embedUrl: feedType === 'iframe' ? pageUrl : '',
    externalUrl: pageUrl,
    directImageUrl,
    directMediaUrl,
    lat,
    lon,
    headingConfidence: 'low',
    headingDeg: 0,
    pitchDeg: -12,
    fovDeg: 70,
    rangeM: 300,
    mountHeightM: 12,
    credit: 'OpenCCTV public camera directory',
    category: String(camera.category || '').slice(0, 30),
    updateRateMs: Number(camera.update_rate) || null,
    distanceKm: distanceKm(center.lat, center.lon, lat, lon),
  };
}

/** Proxies the public map's bounded camera pool without exposing its feed key. */
export function cctvPublicDiscoveryProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 180 });
  let configCache = null;

  async function feedKey(signal) {
    if (configCache && now() - configCache.savedAt < CONFIG_TTL_MS)
      return configCache.key;
    const response = await fetchImpl(`${OPEN_CCTV_ORIGIN}/api/config`, {
      signal,
      headers: { Accept: 'application/json' },
    });
    const payload = await readResponseJsonCapped(response, 64 * 1024, signal);
    const key = response.ok ? String(payload?.fk || '').trim() : '';
    if (!key) throw new Error('public_catalog_unavailable');
    configCache = { key, savedAt: now() };
    return key;
  }

  async function search(bounds) {
    const signal = AbortSignal.timeout(20_000);
    const key = await feedKey(signal);
    const bbox = [bounds.south, bounds.west, bounds.north, bounds.east]
      .map((value) => value.toFixed(6))
      .join(',');
    const response = await fetchImpl(
      `${OPEN_CCTV_ORIGIN}/api/cameras/feed-pool?bounds=${bbox}`,
      {
        signal,
        headers: { Accept: 'application/json', 'X-Feed-Key': key },
      },
    );
    const pool = await readResponseJsonCapped(
      response,
      MAX_RESPONSE_BYTES,
      signal,
    );
    if (!response.ok || !Array.isArray(pool))
      throw new Error('public_catalog_unavailable');
    const ids = pool
      .map((camera) => String(camera?.id || '').trim())
      .filter(Boolean)
      .slice(0, MAX_RESULTS);
    if (!ids.length) return [];
    const detailResponse = await fetchImpl(
      `${OPEN_CCTV_ORIGIN}/api/cameras/batch`,
      {
        method: 'POST',
        signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Feed-Key': key,
        },
        body: JSON.stringify({ ids }),
      },
    );
    const payload = await readResponseJsonCapped(
      detailResponse,
      MAX_RESPONSE_BYTES,
      signal,
    );
    if (!detailResponse.ok || !Array.isArray(payload))
      throw new Error('public_catalog_unavailable');
    const center = {
      lat: (bounds.south + bounds.north) / 2,
      lon: (bounds.west + bounds.east) / 2,
    };
    return payload
      .map((camera) => normalizeOpenCctvCamera(camera, center))
      .filter(Boolean)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, MAX_RESULTS);
  }

  async function handler(req, res) {
    const send = (status, body) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'private, max-age=60',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
      });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { error: 'method_not_allowed' });
    if (!allow(clientKey(req))) return send(429, { error: 'rate_limited' });
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/') return send(404, { error: 'unknown_route' });
    const bounds = normalizePublicDiscoveryBounds(url.searchParams);
    if (!bounds) return send(400, { error: 'invalid_bounds' });
    const cacheKey = [bounds.south, bounds.west, bounds.north, bounds.east]
      .map((value) => value.toFixed(2))
      .join(':');
    const hit = cache.get(cacheKey);
    if (hit && now() - hit.savedAt < CACHE_TTL_MS)
      return send(200, { cameras: hit.cameras, cached: true });
    try {
      const { promise } = coalesceProxyRequest(inFlight, cacheKey, () =>
        search(bounds),
      );
      const cameras = await promise;
      cache.set(cacheKey, { cameras, savedAt: now() });
      return send(200, { cameras, cached: false });
    } catch {
      return send(502, { error: 'public_catalog_unavailable' });
    }
  }

  return {
    name: 'cctv-public-discovery',
    configureServer({ middlewares }) {
      middlewares.use('/api/cctv-public-discovery', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/cctv-public-discovery', handler);
    },
  };
}
