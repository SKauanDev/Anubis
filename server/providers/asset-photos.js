import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const CACHE_TTL_MS = 24 * 60 * 60_000;
const MAX_CACHE_ENTRIES = 500;
const MIB = 1024 * 1024;

function cleanText(value, max = 80) {
  return String(value ?? '')
    .replace(/[<>|{}[\]"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function plainMetadata(value, max = 180) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function folded(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function words(value) {
  return folded(value)
    .split(' ')
    .filter((word) => word.length > 1);
}

export function assetPhotoRequest(searchParams) {
  const kind = searchParams.get('kind');
  if (kind !== 'aircraft' && kind !== 'vessel') return null;
  const request = {
    kind,
    icao24: cleanText(searchParams.get('icao24'), 8).toLowerCase(),
    registration: cleanText(searchParams.get('registration'), 16).toUpperCase(),
    model: cleanText(searchParams.get('model'), 72),
    name: cleanText(searchParams.get('name'), 72),
    imo: cleanText(searchParams.get('imo'), 12),
    mmsi: cleanText(searchParams.get('mmsi'), 12),
    type: cleanText(searchParams.get('type'), 48),
  };
  if (request.icao24 && !/^[0-9a-f]{6}$/.test(request.icao24))
    request.icao24 = '';
  if (request.registration && !/^[A-Z0-9-]{2,16}$/.test(request.registration))
    request.registration = '';
  if (request.imo && !/^\d{7}$/.test(request.imo)) request.imo = '';
  if (request.mmsi && !/^\d{5,10}$/.test(request.mmsi)) request.mmsi = '';
  const hasIdentity =
    kind === 'aircraft'
      ? request.registration || request.model || request.icao24
      : request.name || request.imo || request.type || request.mmsi;
  return hasIdentity ? request : null;
}

export function assetPhotoQueries(request) {
  const queries = [];
  if (request.kind === 'aircraft') {
    if (request.registration)
      queries.push({
        text: `intitle:"${request.registration}"`,
        exact: request.registration,
      });
    if (request.model)
      queries.push({
        text: `"${request.model}" aircraft`,
        representative: request.model,
      });
    const broadModel = broadAircraftModel(request.model);
    if (broadModel && folded(broadModel) !== folded(request.model))
      queries.push({
        text: `"${broadModel}" aircraft`,
        representative: broadModel,
      });
  } else {
    if (request.imo)
      queries.push({ text: `"IMO ${request.imo}" ship`, exact: request.imo });
    if (request.name && folded(request.name) !== 'vessel')
      queries.push({ text: `intitle:"${request.name}"`, exact: request.name });
    if (request.type)
      queries.push({
        text: `"${request.type}" ship`,
        representative: request.type,
      });
  }
  return queries.slice(0, 3);
}

function broadAircraftModel(model) {
  const text = cleanText(model, 72);
  if (!text) return '';
  const match =
    /^(airbus|boeing|embraer|cessna|bombardier|gulfstream|atr|beechcraft|pilatus|dassault|lockheed|antonov|bell)\s+([a-z]*\d{2,4})/i.exec(
      text,
    );
  if (match) return `${match[1]} ${match[2]}`;
  const code = /\b([a-z]\d{2,3}|\d{2,3}[a-z])\b/i.exec(text);
  return code?.[1] || text;
}

function scorePage(page, request, query) {
  const info = page?.imageinfo?.[0];
  if (!info?.thumburl || !info?.descriptionurl) return null;
  if (
    !['https://upload.wikimedia.org/', 'https://thumb.wikimedia.org/'].some(
      (origin) => String(info.thumburl).startsWith(origin),
    )
  )
    return null;
  if (!String(info.descriptionurl).startsWith('https://commons.wikimedia.org/'))
    return null;
  const metadata = info.extmetadata || {};
  const haystack = folded(
    `${page.title || ''} ${metadata.ImageDescription?.value || ''}`,
  );
  const exactNeedle = folded(query.exact);
  const exact = Boolean(exactNeedle && haystack.includes(exactNeedle));
  const representativeWords = words(query.representative);
  const representativeHits = representativeWords.filter((word) =>
    haystack.includes(word),
  ).length;
  const representative = Boolean(
    representativeWords.length &&
    representativeHits >=
      Math.max(1, Math.ceil(representativeWords.length * 0.6)),
  );
  const familyWords =
    request.kind === 'aircraft'
      ? ['aircraft', 'airplane', 'aeroplane', 'airbus', 'boeing', 'helicopter']
      : ['ship', 'vessel', 'tanker', 'ferry', 'boat', 'carrier', 'cargo'];
  const family = familyWords.some((word) => haystack.includes(word));
  if (!exact && !representative) return null;
  let score = exact ? 1000 : 200 + representativeHits * 20;
  if (family) score += 40;
  if (/\.(?:jpe?g|png|webp)$/i.test(page.title || '')) score += 5;
  return { score, exact, info, metadata };
}

export function normalizeCommonsPhoto(payload, request, query) {
  const pages = Object.values(payload?.query?.pages || {});
  const ranked = pages
    .map((page) => ({ page, match: scorePage(page, request, query) }))
    .filter((entry) => entry.match)
    .sort((a, b) => b.match.score - a.match.score);
  const selected = ranked[0];
  if (!selected) return null;
  const { page, match } = selected;
  const { info, metadata } = match;
  return {
    imageUrl: info.thumburl,
    sourceUrl: info.descriptionurl,
    title: plainMetadata(page.title?.replace(/^File:/i, ''), 120),
    author:
      plainMetadata(metadata.Artist?.value, 120) ||
      plainMetadata(info.user, 120) ||
      'Wikimedia Commons contributor',
    license:
      plainMetadata(
        metadata.LicenseShortName?.value || metadata.UsageTerms?.value,
        80,
      ) || 'See source',
    licenseUrl: String(metadata.LicenseUrl?.value || '').startsWith('https://')
      ? metadata.LicenseUrl.value
      : null,
    exact: match.exact,
    match: match.exact ? 'exact' : 'representative',
    provider: 'Wikimedia Commons',
  };
}

/** Cached, fixed-origin photo lookup with machine-readable attribution. */
export function assetPhotosProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 40, globalMax: 800 });

  async function search(request) {
    for (const query of assetPhotoQueries(request)) {
      const params = new URLSearchParams({
        action: 'query',
        format: 'json',
        formatversion: '2',
        generator: 'search',
        gsrsearch: query.text,
        gsrnamespace: '6',
        gsrlimit: '8',
        prop: 'imageinfo',
        iiprop: 'url|extmetadata|user',
        iiurlwidth: '960',
        iiextmetadatalanguage: 'en',
        iiextmetadatafilter:
          'ImageDescription|LicenseShortName|UsageTerms|LicenseUrl|Artist',
      });
      const signal = AbortSignal.timeout(12_000);
      const response = await fetchImpl(`${COMMONS_API}?${params}`, {
        signal,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'GodsEyeView/0.1.1 public geospatial viewer',
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`commons_${response.status}`);
      }
      const payload = await readResponseJsonCapped(response, 3 * MIB, signal);
      const photo = normalizeCommonsPhoto(payload, request, query);
      if (photo) return photo;
    }
    return null;
  }

  async function handler(req, res) {
    const send = (status, body) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'private, max-age=3600',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
      });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { error: 'method_not_allowed' });
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/') return send(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return send(429, { error: 'rate_limited' });
    const request = assetPhotoRequest(url.searchParams);
    if (!request) return send(400, { error: 'invalid_identity' });
    const key = JSON.stringify(request);
    const hit = cache.get(key);
    if (hit && now() - hit.savedAt < CACHE_TTL_MS)
      return send(200, { photo: hit.photo, cached: true });
    try {
      const { promise } = coalesceProxyRequest(inFlight, key, () =>
        search(request),
      );
      const photo = await promise;
      if (cache.size >= MAX_CACHE_ENTRIES)
        cache.delete(cache.keys().next().value);
      cache.set(key, { savedAt: now(), photo });
      return send(200, { photo, cached: false });
    } catch {
      return send(502, { error: 'photo_source_unavailable' });
    }
  }

  return {
    name: 'asset-photos',
    configureServer({ middlewares }) {
      middlewares.use('/api/asset-photo', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/asset-photo', handler);
    },
  };
}
