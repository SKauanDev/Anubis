import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

const YOUTUBE_SEARCH_API = 'https://www.googleapis.com/youtube/v3/search';
const CACHE_TTL_MS = 10 * 60_000;
const MAX_CACHE_ENTRIES = 100;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

function cleanText(value, max = 120) {
  return String(value ?? '')
    .replace(/[<>\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function decodeEntities(value) {
  return cleanText(value, 180)
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

export function normalizeLiveDiscoveryQuery(value) {
  const query = cleanText(value, 80);
  return query.length >= 2 ? query : '';
}

export function liveDiscoverySearchText(query) {
  const base = /\b(?:webcam|camera|cctv|cam)\b/i.test(query)
    ? query
    : `${query} live webcam`;
  return `${base} -news -jornal -noticias -telejornal`;
}

export function isWebcamBroadcast(item) {
  const snippet = item?.snippet || {};
  const text =
    `${snippet.title || ''} ${snippet.channelTitle || ''} ${snippet.description || ''}`
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  const webcamSignal =
    /\b(?:web\s*cam|earth\s*cam|live\s*(?:cam|camera)|camera\s*(?:live|ao\s+vivo)|traffic\s*cam|beach\s*cam|city\s*cam|skyline\s*cam|airport\s*cam|harbou?r\s*cam|street\s*cam|cctv)\b/.test(
      text,
    );
  if (!webcamSignal) return false;
  const newsSignal =
    /\b(?:breaking\s+news|live\s+news|telejornal|jornalismo|noticias|news\s+(?:channel|network)|radio\s+live)\b/.test(
      text,
    );
  const title = String(snippet.title || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return (
    !newsSignal ||
    /\b(?:web\s*cam|earth\s*cam|live\s*(?:cam|camera)|camera\s*(?:live|ao\s+vivo)|traffic\s*cam|beach\s*cam|city\s*cam|skyline\s*cam|airport\s*cam|harbou?r\s*cam|street\s*cam|cctv)\b/.test(
      title,
    )
  );
}

function trustedThumbnail(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' &&
      ['i.ytimg.com', 'img.youtube.com'].includes(url.hostname)
      ? url.href
      : '';
  } catch {
    return '';
  }
}

export function normalizeYouTubeLiveResults(payload) {
  const seen = new Set();
  const broadcasts = [];
  for (const item of Array.isArray(payload?.items) ? payload.items : []) {
    if (!isWebcamBroadcast(item)) continue;
    const id = String(item?.id?.videoId || '');
    if (!YOUTUBE_ID.test(id) || seen.has(id)) continue;
    const title = decodeEntities(item?.snippet?.title);
    if (!title) continue;
    seen.add(id);
    const thumbnails = item?.snippet?.thumbnails || {};
    const thumbnailUrl = trustedThumbnail(
      thumbnails.medium?.url || thumbnails.high?.url || thumbnails.default?.url,
    );
    broadcasts.push({
      id,
      title,
      channel: decodeEntities(item?.snippet?.channelTitle) || 'YouTube',
      publishedAt: /^\d{4}-\d{2}-\d{2}T/.test(item?.snippet?.publishedAt || '')
        ? item.snippet.publishedAt
        : null,
      thumbnailUrl,
      embedUrl: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1`,
      sourceUrl: `https://www.youtube.com/watch?v=${id}`,
    });
  }
  return broadcasts;
}

function upstreamFailure(payload, status) {
  const reasons = (payload?.error?.errors || []).map((item) => item?.reason);
  if (
    status === 403 &&
    reasons.some((reason) =>
      ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded'].includes(
        reason,
      ),
    )
  ) {
    return Object.assign(new Error('youtube_quota_exhausted'), { status: 429 });
  }
  if (
    status === 400 ||
    status === 401 ||
    reasons.some((reason) =>
      ['keyInvalid', 'accessNotConfigured', 'forbidden'].includes(reason),
    )
  ) {
    return Object.assign(new Error('youtube_key_invalid'), { status: 503 });
  }
  return Object.assign(new Error('youtube_unavailable'), { status: 502 });
}

/** Official, explicit-search discovery of embeddable YouTube live broadcasts. */
export function cctvLiveDiscoveryProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 10, globalMax: 120 });

  async function search(query, apiKey) {
    const params = new URLSearchParams({
      part: 'snippet',
      type: 'video',
      eventType: 'live',
      videoEmbeddable: 'true',
      videoSyndicated: 'true',
      safeSearch: 'moderate',
      maxResults: '20',
      q: liveDiscoverySearchText(query),
      key: apiKey,
    });
    const signal = AbortSignal.timeout(12_000);
    const response = await fetchImpl(`${YOUTUBE_SEARCH_API}?${params}`, {
      signal,
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    const payload = await readResponseJsonCapped(
      response,
      MAX_RESPONSE_BYTES,
      signal,
    );
    if (!response.ok) throw upstreamFailure(payload, response.status);
    return normalizeYouTubeLiveResults(payload);
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
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/') return send(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return send(429, { error: 'rate_limited' });
    const query = normalizeLiveDiscoveryQuery(url.searchParams.get('q'));
    if (!query) return send(400, { error: 'invalid_query' });
    const apiKey = String(process.env.YOUTUBE_DATA_API_KEY || '').trim();
    if (!apiKey) return send(503, { error: 'youtube_key_missing' });

    const key = query.toLocaleLowerCase('pt-BR');
    const hit = cache.get(key);
    if (hit && now() - hit.savedAt < CACHE_TTL_MS) {
      return send(200, {
        query,
        fetchedAt: new Date(hit.savedAt).toISOString(),
        broadcasts: hit.broadcasts,
        cached: true,
      });
    }
    try {
      const { promise } = coalesceProxyRequest(inFlight, key, () =>
        search(query, apiKey),
      );
      const broadcasts = await promise;
      const savedAt = now();
      if (cache.size >= MAX_CACHE_ENTRIES)
        cache.delete(cache.keys().next().value);
      cache.set(key, { savedAt, broadcasts });
      return send(200, {
        query,
        fetchedAt: new Date(savedAt).toISOString(),
        broadcasts,
        cached: false,
      });
    } catch (error) {
      const code = String(error?.message || 'youtube_unavailable');
      const status = Number(error?.status) || 502;
      return send(status, {
        error: [
          'youtube_quota_exhausted',
          'youtube_key_invalid',
          'youtube_unavailable',
        ].includes(code)
          ? code
          : 'youtube_unavailable',
      });
    }
  }

  return {
    name: 'cctv-live-discovery',
    configureServer({ middlewares }) {
      middlewares.use('/api/cctv-live-discovery', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/cctv-live-discovery', handler);
    },
  };
}
