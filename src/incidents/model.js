const CATEGORY_ALIASES = Object.freeze({
  drought: 'drought',
  droughts: 'drought',
  dr: 'drought',
  dusthaze: 'weather',
  earthquake: 'earthquake',
  earthquakes: 'earthquake',
  eq: 'earthquake',
  flood: 'flood',
  floods: 'flood',
  fl: 'flood',
  landslide: 'landslide',
  landslides: 'landslide',
  severeStorms: 'storm',
  snow: 'weather',
  storm: 'storm',
  tc: 'storm',
  volcano: 'volcano',
  volcanoes: 'volcano',
  vo: 'volcano',
  waterColor: 'environment',
  airquality: 'air-quality',
  airQuality: 'air-quality',
  ocean: 'ocean',
  marine: 'ocean',
  alert: 'alert',
  wildfire: 'fire',
  wildfires: 'fire',
  wf: 'fire',
});

const GDACS_CATEGORY_LABEL = Object.freeze({
  drought: 'Seca',
  earthquake: 'Terremoto',
  fire: 'Incendio',
  flood: 'Enchente',
  landslide: 'Deslizamento',
  storm: 'Tempestade',
  volcano: 'Vulcao',
  weather: 'Clima severo',
  environment: 'Ambiental',
  'air-quality': 'Qualidade do ar',
  ocean: 'Oceano',
  alert: 'Alerta oficial',
  other: 'Outro',
});

const compactText = (value, fallback = '') => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim()
    ? value.replace(/\s+/g, ' ').trim()
    : fallback;
};

const finiteNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const boundedCoordinate = (value, min, max) => {
  const numeric = finiteNumber(value);
  return numeric !== null && numeric >= min && numeric <= max ? numeric : null;
};

const safeTimestamp = (...values) => {
  for (const value of values) {
    const parsed = typeof value === 'number' ? value : Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

function collectCoordinatePairs(value, output, limit = 128) {
  if (!Array.isArray(value) || output.length >= limit) return;
  if (
    value.length >= 2 &&
    Number.isFinite(Number(value[0])) &&
    Number.isFinite(Number(value[1]))
  ) {
    const lon = boundedCoordinate(value[0], -180, 180);
    const lat = boundedCoordinate(value[1], -90, 90);
    if (lat !== null && lon !== null) output.push([lon, lat]);
    return;
  }
  for (const child of value) collectCoordinatePairs(child, output, limit);
}

/** Resolve Point or polygon GeoJSON into one stable map anchor. */
export function geometryAnchor(geometry) {
  const pairs = [];
  collectCoordinatePairs(geometry?.coordinates, pairs);
  if (!pairs.length) return null;
  const total = pairs.reduce(
    (sum, [lon, lat]) => ({ lon: sum.lon + lon, lat: sum.lat + lat }),
    { lon: 0, lat: 0 },
  );
  return {
    lon: total.lon / pairs.length,
    lat: total.lat / pairs.length,
  };
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function categoryId(value) {
  const key = compactText(value).replace(/[\s_-]+/g, '');
  return CATEGORY_ALIASES[value] || CATEGORY_ALIASES[key] || 'other';
}

function incidentRecord(input) {
  const lat = boundedCoordinate(input.lat, -90, 90);
  const lon = boundedCoordinate(input.lon, -180, 180);
  const title = compactText(input.title);
  if (!input.id || !title || lat === null || lon === null) return null;
  const category = categoryId(input.category);
  return Object.freeze({
    id: String(input.id),
    source: compactText(input.source, 'Fonte publica'),
    sourceCode: compactText(input.sourceCode, 'public'),
    title: title.slice(0, 220),
    summary: compactText(input.summary).slice(0, 700),
    category,
    categoryLabel: GDACS_CATEGORY_LABEL[category],
    severity: ['high', 'medium', 'low', 'monitor'].includes(input.severity)
      ? input.severity
      : 'monitor',
    lat,
    lon,
    occurredAt: safeTimestamp(input.occurredAt),
    updatedAt: safeTimestamp(input.updatedAt, input.occurredAt),
    url: safeUrl(input.url),
    status: compactText(input.status, 'active').slice(0, 40),
    sources: Object.freeze([
      Object.freeze({
        code: compactText(input.sourceCode, 'public'),
        name: compactText(input.source, 'Fonte publica'),
        url: safeUrl(input.url),
      }),
    ]),
  });
}

function metric(value) {
  if (value === 'MM' || value === null || value === undefined) return null;
  return finiteNumber(value);
}

function aqiSeverity(value) {
  if (value >= 151) return 'high';
  if (value >= 101) return 'medium';
  if (value >= 51) return 'low';
  return 'monitor';
}

/** Normalize Open-Meteo multi-coordinate current air-quality responses. */
export function normalizeAirQualityPayload(payload) {
  const samples = Array.isArray(payload) ? payload : payload ? [payload] : null;
  if (!samples) return null;
  const rows = [];
  for (const [index, sample] of samples.entries()) {
    const current = sample?.current || {};
    const aqi = metric(current.us_aqi);
    const lat = boundedCoordinate(sample?.latitude, -90, 90);
    const lon = boundedCoordinate(sample?.longitude, -180, 180);
    if (aqi === null || lat === null || lon === null) continue;
    const readings = [
      `AQI ${Math.round(aqi)}`,
      metric(current.pm2_5) === null
        ? null
        : `PM2.5 ${metric(current.pm2_5).toFixed(1)} µg/m³`,
      metric(current.pm10) === null
        ? null
        : `PM10 ${metric(current.pm10).toFixed(1)} µg/m³`,
      metric(current.ozone) === null
        ? null
        : `O₃ ${metric(current.ozone).toFixed(1)} µg/m³`,
    ].filter(Boolean);
    const row = incidentRecord({
      id: `air:${lat.toFixed(2)}:${lon.toFixed(2)}:${index}`,
      source: 'Open-Meteo / CAMS',
      sourceCode: 'open-meteo-air',
      title: `Qualidade do ar · AQI ${Math.round(aqi)}`,
      summary: `${readings.join(' · ')}. Leitura modelada da célula atmosférica; não substitui uma estação local.`,
      category: 'airquality',
      severity: aqiSeverity(aqi),
      lat,
      lon,
      occurredAt: current.time,
      updatedAt: current.time,
      url: 'https://open-meteo.com/en/docs/air-quality-api',
    });
    if (row) rows.push(row);
  }
  return rows;
}

function oceanSeverity(waveHeight, windSpeed, gustSpeed) {
  const peakWind = Math.max(windSpeed || 0, gustSpeed || 0);
  if ((waveHeight || 0) >= 6 || peakWind >= 25) return 'high';
  if ((waveHeight || 0) >= 4 || peakWind >= 18) return 'medium';
  if ((waveHeight || 0) >= 2.5 || peakWind >= 12) return 'low';
  return 'monitor';
}

/** Parse NOAA NDBC's whitespace-delimited latest-observations product. */
export function normalizeNdbcLatestObservations(text) {
  if (typeof text !== 'string') return null;
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const values = line.trim().split(/\s+/);
    if (values.length < 22) continue;
    const [
      station,
      rawLat,
      rawLon,
      year,
      month,
      day,
      hour,
      minute,
      ,
      rawWind,
      rawGust,
      rawWave,
      rawDominantPeriod,
      ,
      rawMeanDirection,
      rawPressure,
      ,
      rawAirTemp,
      rawWaterTemp,
    ] = values;
    const lat = boundedCoordinate(rawLat, -90, 90);
    const lon = boundedCoordinate(rawLon, -180, 180);
    if (!station || lat === null || lon === null) continue;
    const wind = metric(rawWind);
    const gust = metric(rawGust);
    const wave = metric(rawWave);
    const readings = [
      wave === null ? null : `ondas ${wave.toFixed(1)} m`,
      wind === null ? null : `vento ${wind.toFixed(1)} m/s`,
      gust === null ? null : `rajadas ${gust.toFixed(1)} m/s`,
      metric(rawWaterTemp) === null
        ? null
        : `água ${metric(rawWaterTemp).toFixed(1)} °C`,
      metric(rawAirTemp) === null
        ? null
        : `ar ${metric(rawAirTemp).toFixed(1)} °C`,
      metric(rawPressure) === null
        ? null
        : `pressão ${metric(rawPressure).toFixed(1)} hPa`,
      metric(rawDominantPeriod) === null
        ? null
        : `período ${metric(rawDominantPeriod).toFixed(1)} s`,
      metric(rawMeanDirection) === null
        ? null
        : `direção ${Math.round(metric(rawMeanDirection))}°`,
    ].filter(Boolean);
    const timestamp = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
    );
    const row = incidentRecord({
      id: `ndbc:${station}`,
      source: 'NOAA NDBC',
      sourceCode: 'ndbc',
      title: `Boia ${station}`,
      summary: readings.length
        ? readings.join(' · ')
        : 'Estação ativa sem medições meteorológicas recentes.',
      category: 'ocean',
      severity: oceanSeverity(wave, wind, gust),
      lat,
      lon,
      occurredAt: timestamp,
      updatedAt: timestamp,
      url: `https://www.ndbc.noaa.gov/station_page.php?station=${encodeURIComponent(station.toLowerCase())}`,
    });
    if (row) rows.push(row);
  }
  return rows;
}

function nwsSeverity(value) {
  const severity = compactText(value).toLowerCase();
  if (severity === 'extreme' || severity === 'severe') return 'high';
  if (severity === 'moderate') return 'medium';
  if (severity === 'minor') return 'low';
  return 'monitor';
}

/** Normalize active official US National Weather Service CAP/GeoJSON alerts. */
export function normalizeNwsAlertsPayload(payload) {
  if (!Array.isArray(payload?.features)) return null;
  const rows = [];
  for (const [index, feature] of payload.features.entries()) {
    const properties = feature?.properties || {};
    const anchor = geometryAnchor(feature?.geometry);
    if (!anchor) continue;
    const url = safeUrl(properties['@id'] || properties.id);
    const row = incidentRecord({
      id: `nws:${compactText(properties.id || properties['@id'], String(index))}`,
      source: 'US National Weather Service',
      sourceCode: 'nws',
      title: properties.headline || properties.event,
      summary: [properties.description, properties.instruction]
        .map((value) => compactText(value))
        .filter(Boolean)
        .join(' '),
      category: 'alert',
      severity: nwsSeverity(properties.severity),
      ...anchor,
      occurredAt: properties.onset || properties.effective || properties.sent,
      updatedAt: properties.sent || properties.effective,
      url,
      status: properties.status || 'active',
    });
    if (row) rows.push(row);
  }
  return rows;
}

/** Normalize NASA EONET v3 events into the application incident schema. */
export function normalizeEonetPayload(payload) {
  if (!Array.isArray(payload?.events)) return null;
  const rows = [];
  for (const event of payload.events) {
    const geometries = Array.isArray(event?.geometry) ? event.geometry : [];
    const geometry = [...geometries]
      .reverse()
      .find((candidate) => geometryAnchor(candidate));
    const anchor = geometryAnchor(geometry);
    if (!anchor) continue;
    const category = event?.categories?.[0];
    const source = event?.sources?.find((item) => safeUrl(item?.url));
    const row = incidentRecord({
      id: `eonet:${compactText(event.id)}`,
      source: 'NASA EONET',
      sourceCode: 'eonet',
      title: event.title,
      summary: event.description,
      category: category?.id || category?.title,
      severity: 'monitor',
      ...anchor,
      occurredAt: geometry?.date,
      updatedAt: geometry?.date,
      url: source?.url || event.link,
      status: event.closed ? 'closed' : 'active',
    });
    if (row) rows.push(row);
  }
  return rows;
}

function gdacsFeatures(payload) {
  if (Array.isArray(payload?.features)) return payload.features;
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return null;
}

/** Normalize GDACS GeoJSON/API results into the application incident schema. */
export function normalizeGdacsPayload(payload) {
  const features = gdacsFeatures(payload);
  if (!features) return null;
  const rows = [];
  for (const feature of features) {
    const properties = feature?.properties || feature || {};
    const anchor = geometryAnchor(feature?.geometry) || {
      lat: boundedCoordinate(properties.latitude ?? properties.lat, -90, 90),
      lon: boundedCoordinate(properties.longitude ?? properties.lon, -180, 180),
    };
    const eventType = compactText(
      properties.eventtype ?? properties.eventType ?? properties.type,
    ).toLowerCase();
    const eventId = compactText(
      properties.eventid ?? properties.eventId ?? properties.id,
    );
    const alert = compactText(
      properties.alertlevel ?? properties.alertLevel,
    ).toLowerCase();
    const reportUrl =
      safeUrl(properties.url?.report ?? properties.url ?? properties.link) ||
      (eventId && eventType
        ? `https://www.gdacs.org/report.aspx?eventtype=${encodeURIComponent(eventType.toUpperCase())}&eventid=${encodeURIComponent(eventId)}`
        : null);
    const row = incidentRecord({
      id: `gdacs:${eventType}:${eventId}`,
      source: 'GDACS',
      sourceCode: 'gdacs',
      title:
        properties.name ??
        properties.eventname ??
        properties.title ??
        `${GDACS_CATEGORY_LABEL[categoryId(eventType)]} ${eventId}`,
      summary:
        properties.description ??
        properties.htmldescription ??
        properties.country,
      category: eventType,
      severity:
        alert === 'red'
          ? 'high'
          : alert === 'orange'
            ? 'medium'
            : alert === 'green'
              ? 'low'
              : 'monitor',
      ...anchor,
      occurredAt: properties.fromdate ?? properties.fromDate ?? properties.date,
      updatedAt:
        properties.todate ??
        properties.toDate ??
        properties.episodealertdate ??
        properties.fromdate,
      url: reportUrl,
      status: properties.iscurrent === false ? 'closed' : 'active',
    });
    if (row) rows.push(row);
  }
  return rows;
}

function titleTerms(title) {
  return new Set(
    compactText(title)
      .toLocaleLowerCase('en-US')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((term) => term.length > 2),
  );
}

function titleSimilarity(left, right) {
  const a = titleTerms(left);
  const b = titleTerms(right);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const term of a) if (b.has(term)) common++;
  return common / Math.min(a.size, b.size);
}

function distanceKm(a, b) {
  const radians = Math.PI / 180;
  const dLat = (b.lat - a.lat) * radians;
  const dLon = (b.lon - a.lon) * radians;
  const lat1 = a.lat * radians;
  const lat2 = b.lat * radians;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

const SEVERITY_RANK = Object.freeze({ high: 4, medium: 3, low: 2, monitor: 1 });

/** Merge likely cross-provider duplicates without hiding distinct nearby events. */
export function deduplicateIncidents(records) {
  const result = [];
  const ordered = [...(Array.isArray(records) ? records : [])].sort(
    (a, b) =>
      (SEVERITY_RANK[b?.severity] || 0) - (SEVERITY_RANK[a?.severity] || 0) ||
      (b?.updatedAt || 0) - (a?.updatedAt || 0),
  );
  for (const candidate of ordered) {
    if (!candidate) continue;
    const duplicate = result.find(
      (existing) =>
        existing.sourceCode !== candidate.sourceCode &&
        existing.category === candidate.category &&
        distanceKm(existing, candidate) <= 100 &&
        titleSimilarity(existing.title, candidate.title) >= 0.55,
    );
    if (!duplicate) {
      result.push({ ...candidate, sources: [...candidate.sources] });
      continue;
    }
    duplicate.sources.push(...candidate.sources);
    duplicate.source = duplicate.sources.map((item) => item.name).join(' + ');
    duplicate.updatedAt = Math.max(
      duplicate.updatedAt || 0,
      candidate.updatedAt || 0,
    );
    if (!duplicate.summary && candidate.summary)
      duplicate.summary = candidate.summary;
  }
  return result.map((row) =>
    Object.freeze({ ...row, sources: Object.freeze(row.sources) }),
  );
}

export const INCIDENT_CATEGORIES = Object.freeze(
  Object.entries(GDACS_CATEGORY_LABEL).map(([id, label]) =>
    Object.freeze({ id, label }),
  ),
);
