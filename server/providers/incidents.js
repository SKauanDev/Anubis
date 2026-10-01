import {
  deduplicateIncidents,
  normalizeAirQualityPayload,
  normalizeEonetPayload,
  normalizeGdacsPayload,
  normalizeNdbcLatestObservations,
  normalizeNwsAlertsPayload,
} from '../../src/incidents/model.js';
import {
  readResponseJsonCapped,
  readResponseTextCapped,
  coalesceProxyRequest,
} from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

const MIB = 1024 * 1024;
const STALE_TTL_MS = 6 * 60 * 60_000;
const MODE_TTL_MS = Object.freeze({
  events: 5 * 60_000,
  environment: 30 * 60_000,
  ocean: 10 * 60_000,
  alerts: 2 * 60_000,
});
const MODES = new Set(Object.keys(MODE_TTL_MS));
const NDBC_LATEST = 'https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt';
const NWS_ACTIVE =
  'https://api.weather.gov/alerts/active?status=actual&message_type=alert,update';

function airQualityCoordinates() {
  const latitudes = [];
  const longitudes = [];
  for (let lat = -60; lat <= 60; lat += 20) {
    for (let lon = -170; lon <= 170; lon += 20) {
      latitudes.push(String(lat));
      longitudes.push(String(lon));
    }
  }
  return { latitudes, longitudes };
}

function airQualityUrl() {
  const { latitudes, longitudes } = airQualityCoordinates();
  const params = new URLSearchParams({
    latitude: latitudes.join(','),
    longitude: longitudes.join(','),
    current: 'us_aqi,pm2_5,pm10,ozone',
    timezone: 'GMT',
  });
  return `https://air-quality-api.open-meteo.com/v1/air-quality?${params}`;
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Fixed-origin, cached aggregation of public global incident feeds. */
export function incidentsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const caches = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });

  async function upstream(url, headers = {}) {
    const signal = AbortSignal.timeout(25_000);
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: { Accept: 'application/json', ...headers },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`upstream_${response.status}`);
    }
    return readResponseJsonCapped(response, 8 * MIB, signal);
  }

  async function upstreamText(url) {
    const signal = AbortSignal.timeout(25_000);
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: {
        Accept: 'text/plain',
        'User-Agent': 'GodsEyeView/0.1 public-data-monitor',
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`upstream_${response.status}`);
    }
    return readResponseTextCapped(response, 2 * MIB, signal);
  }

  async function loadEvents() {
    const end = now();
    const start = end - 30 * 24 * 60 * 60_000;
    const gdacsQuery = new URLSearchParams({
      eventlist: 'EQ;TC;FL;VO;DR;WF',
      fromdate: isoDate(start),
      todate: isoDate(end),
      alertlevel: 'green;orange;red',
      limit: '500',
    });
    const requests = await Promise.allSettled([
      upstream(
        'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=500',
      ),
      upstream(
        `https://www.gdacs.org/gdacsapi/api/Events/geteventlist/SEARCH?${gdacsQuery}`,
      ),
    ]);
    const providers = {};
    const rows = [];
    const eonet =
      requests[0].status === 'fulfilled'
        ? normalizeEonetPayload(requests[0].value)
        : null;
    const gdacs =
      requests[1].status === 'fulfilled'
        ? normalizeGdacsPayload(requests[1].value)
        : null;
    providers.eonet = { ok: Array.isArray(eonet), count: eonet?.length || 0 };
    providers.gdacs = { ok: Array.isArray(gdacs), count: gdacs?.length || 0 };
    if (eonet) rows.push(...eonet);
    if (gdacs) rows.push(...gdacs);
    if (!eonet && !gdacs) throw new Error('all_incident_sources_failed');
    return {
      fetchedAt: end,
      incidents: deduplicateIncidents(rows).slice(0, 900),
      providers,
      stale: false,
    };
  }

  async function loadMode(mode) {
    if (mode === 'events') return loadEvents();
    const fetchedAt = now();
    if (mode === 'environment') {
      const rows = normalizeAirQualityPayload(await upstream(airQualityUrl()));
      if (!rows) throw new Error('environment_unavailable');
      return {
        fetchedAt,
        incidents: rows,
        providers: { openMeteoAir: { ok: true, count: rows.length } },
        stale: false,
      };
    }
    if (mode === 'ocean') {
      const rows = normalizeNdbcLatestObservations(
        await upstreamText(NDBC_LATEST),
      );
      if (!rows) throw new Error('ocean_unavailable');
      return {
        fetchedAt,
        incidents: rows.slice(0, 1200),
        providers: { ndbc: { ok: true, count: rows.length } },
        stale: false,
      };
    }
    const rows = normalizeNwsAlertsPayload(
      await upstream(NWS_ACTIVE, {
        Accept: 'application/geo+json',
        'User-Agent': 'GodsEyeView/0.1 public-alert-monitor',
      }),
    );
    if (!rows) throw new Error('alerts_unavailable');
    return {
      fetchedAt,
      incidents: rows.slice(0, 1000),
      providers: { nws: { ok: true, count: rows.length } },
      stale: false,
    };
  }

  async function handler(req, res) {
    const send = (status, body, extraHeaders = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
        ...extraHeaders,
      });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { error: 'method_not_allowed' });
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/') return send(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return send(429, { error: 'rate_limited' });
    const mode = url.searchParams.get('mode') || 'events';
    if (!MODES.has(mode)) return send(400, { error: 'invalid_mode' });
    const cached = caches.get(mode);
    if (cached && now() - cached.savedAt < MODE_TTL_MS[mode])
      return send(200, cached.value);
    try {
      const { promise } = coalesceProxyRequest(inFlight, mode, () =>
        loadMode(mode),
      );
      const value = await promise;
      caches.set(mode, { savedAt: now(), value });
      send(200, value);
    } catch {
      if (cached && now() - cached.savedAt < STALE_TTL_MS) {
        return send(
          200,
          { ...cached.value, stale: true },
          { 'X-Data-Stale': 'true' },
        );
      }
      send(502, { error: `${mode}_unavailable` });
    }
  }

  return {
    name: 'incidents',
    configureServer({ middlewares }) {
      middlewares.use('/api/incidents', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/incidents', handler);
    },
  };
}
