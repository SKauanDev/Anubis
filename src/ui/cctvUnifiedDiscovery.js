import {
  normalizeOsmWebcamElement,
  osmSearchBbox,
  osmSearchBboxes,
  osmWebcamQuery,
} from './cctvOsmDiscovery.js';
import { validLiveBroadcast } from './cctvLiveDiscovery.js';

function placeLabel(place, fallback) {
  return String(
    place?.formatted_address || fallback || 'Área pesquisada',
  ).trim();
}

function isDirectImage(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      /\.(?:avif|gif|jpe?g|png|webp)$/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function centeredBounds(bbox, maxLatSpan, maxLonSpan) {
  if (!bbox) return null;
  const { south, west, north, east } = bbox;
  if (
    ![south, west, north, east].every(Number.isFinite) ||
    south >= north ||
    west >= east
  )
    return null;
  const centerLat = (south + north) / 2;
  const centerLon = (west + east) / 2;
  const latHalf = Math.min(maxLatSpan / 2, (north - south) / 2);
  const lonHalf = Math.min(maxLonSpan / 2, (east - west) / 2);
  return {
    south: Math.max(-90, centerLat - latHalf),
    west: Math.max(-180, centerLon - lonHalf),
    north: Math.min(90, centerLat + latHalf),
    east: Math.min(180, centerLon + lonHalf),
  };
}

export function osmWebcamCameraSource(webcam, label = 'OpenStreetMap') {
  if (
    !webcam?.id ||
    !Number.isFinite(webcam.lat) ||
    !Number.isFinite(webcam.lon)
  )
    return null;
  const directImageUrl = isDirectImage(webcam.sourceUrl)
    ? webcam.sourceUrl
    : '';
  return {
    id: `osm-webcam-${webcam.id}`,
    name: webcam.name,
    city: label,
    provider: webcam.operator || 'OpenStreetMap',
    sourceKind: 'osm-webcam',
    feedType: webcam.embedUrl
      ? 'iframe'
      : directImageUrl
        ? 'image'
        : 'external',
    embedUrl: webcam.embedUrl || '',
    externalUrl: webcam.sourceUrl,
    directImageUrl,
    lat: webcam.lat,
    lon: webcam.lon,
    headingConfidence: Number.isFinite(webcam.headingDeg) ? 'medium' : 'low',
    headingDeg: Number.isFinite(webcam.headingDeg) ? webcam.headingDeg : 0,
    pitchDeg: -12,
    fovDeg: 70,
    rangeM: 300,
    mountHeightM: Number.isFinite(webcam.mountHeightM)
      ? webcam.mountHeightM
      : 12,
    license: 'ODbL',
    credit: '© colaboradores OpenStreetMap',
  };
}

function offsetCoordinate(value, index, axis) {
  const angle = ((index * 137.508 + (axis ? 90 : 0)) * Math.PI) / 180;
  const radius = 0.0025 + (index % 5) * 0.0012;
  return value + Math.cos(angle) * radius;
}

export function youtubeBroadcastCameraSource(
  broadcast,
  place,
  index = 0,
  fallback = '',
) {
  if (!validLiveBroadcast(broadcast)) return null;
  const lat = Number(place?.geometry?.location?.lat);
  const lon = Number(place?.geometry?.location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    id: `youtube-live-${broadcast.id}`,
    name: broadcast.title,
    city: placeLabel(place, fallback),
    provider: broadcast.channel || 'YouTube Live',
    sourceKind: 'youtube-live-webcam',
    feedType: 'iframe',
    embedUrl: broadcast.embedUrl,
    externalUrl: broadcast.sourceUrl,
    lat: offsetCoordinate(lat, index, false),
    lon: offsetCoordinate(lon, index, true),
    headingConfidence: 'low',
    headingDeg: 0,
    pitchDeg: -12,
    fovDeg: 70,
    rangeM: 300,
    mountHeightM: 12,
    license: 'YouTube',
    credit: 'Posição aproximada da área pesquisada',
  };
}

async function responseJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(payload?.error || `http_${response.status}`);
  return payload;
}

export class CctvUnifiedDiscovery {
  constructor({
    elements,
    onSources,
    onSetupRequest,
    fetchImpl = (...args) => globalThis.fetch(...args),
  }) {
    Object.assign(this, elements);
    this.onSources = onSources;
    this.onSetupRequest = onSetupRequest;
    this.fetchImpl = fetchImpl;
    this.abort = null;
    this.generation = 0;
    this.seenBounds = new Set();
    this.listeners = new AbortController();
    const signal = this.listeners.signal;
    this._searchButton?.addEventListener('click', () => this.search(), {
      signal,
    });
    this._setupButton?.addEventListener(
      'click',
      () => this.onSetupRequest?.(),
      { signal },
    );
    this._queryInput?.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        this.search();
      },
      { signal },
    );
  }

  async _osmSources(bbox, label, signal) {
    const query = osmWebcamQuery(bbox);
    if (!query) return [];
    const payload = await responseJson(
      await this.fetchImpl('/api/overpass', {
        method: 'POST',
        signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: new URLSearchParams({ data: query }).toString(),
      }),
    );
    const unique = new Map();
    for (const element of Array.isArray(payload?.elements)
      ? payload.elements
      : []) {
      const webcam = normalizeOsmWebcamElement(element);
      const source = webcam && osmWebcamCameraSource(webcam, label);
      if (source) unique.set(source.id, source);
    }
    return [...unique.values()].slice(0, 80);
  }

  async _osmSourcesForPlace(place, label, signal) {
    const boxes = osmSearchBboxes(place);
    if (!boxes.length) return { sources: [], radiusKm: 0 };
    for (const bbox of boxes) {
      const sources = await this._osmSources(bbox, label, signal);
      if (sources.length) return { sources, radiusKm: bbox.radiusKm };
    }
    return { sources: [], radiusKm: boxes.at(-1)?.radiusKm || 0 };
  }

  async _liveSources(query, place, signal) {
    const payload = await responseJson(
      await this.fetchImpl(
        `/api/cctv-live-discovery?q=${encodeURIComponent(query)}`,
        { signal, headers: { Accept: 'application/json' } },
      ),
    );
    return (Array.isArray(payload?.broadcasts) ? payload.broadcasts : [])
      .filter(validLiveBroadcast)
      .map((item, index) =>
        youtubeBroadcastCameraSource(item, place, index, query),
      )
      .filter(Boolean);
  }

  async _publicCatalogSourcesForBounds(bbox, signal) {
    if (!bbox) return [];
    const params = new URLSearchParams({
      south: String(bbox.south),
      west: String(bbox.west),
      north: String(bbox.north),
      east: String(bbox.east),
    });
    const payload = await responseJson(
      await this.fetchImpl(`/api/cctv-public-discovery?${params}`, {
        signal,
        headers: { Accept: 'application/json' },
      }),
    );
    return (Array.isArray(payload?.cameras) ? payload.cameras : []).filter(
      (camera) =>
        camera?.sourceKind === 'opencctv-public' &&
        Number.isFinite(camera.lat) &&
        Number.isFinite(camera.lon),
    );
  }

  async _publicCatalogSources(place, signal) {
    return this._publicCatalogSourcesForBounds(
      osmSearchBboxes(place).at(-1),
      signal,
    );
  }

  async search() {
    const query = String(this._queryInput?.value || '').trim();
    if (query.length < 2) {
      this._setStatus('Digite uma cidade ou região.', 'error');
      this._queryInput?.focus();
      return;
    }
    this.abort?.abort();
    this.abort = new AbortController();
    const generation = ++this.generation;
    if (this._searchButton) this._searchButton.disabled = true;
    if (this._setupButton) this._setupButton.hidden = true;
    this._setStatus('LOCALIZANDO WEBCAMS E TRANSMISSÕES AO VIVO…', 'loading');
    try {
      const geocode = await responseJson(
        await this.fetchImpl(
          `/api/geocode?q=${encodeURIComponent(query)}&fallback=photon`,
          {
            signal: this.abort.signal,
            headers: { Accept: 'application/json' },
          },
        ),
      );
      const place = Array.isArray(geocode?.results) ? geocode.results[0] : null;
      if (!osmSearchBbox(place)) throw new Error('place_not_found');
      const label = placeLabel(place, query);
      const [osmResult, publicResult, liveResult] = await Promise.allSettled([
        this._osmSourcesForPlace(place, label, this.abort.signal),
        this._publicCatalogSources(place, this.abort.signal),
        this._liveSources(query, place, this.abort.signal),
      ]);
      if (generation !== this.generation) return;
      const osmDiscovery =
        osmResult.status === 'fulfilled'
          ? osmResult.value
          : { sources: [], radiusKm: 0 };
      const osm = osmDiscovery.sources;
      const publicCameras =
        publicResult.status === 'fulfilled' ? publicResult.value : [];
      const live = liveResult.status === 'fulfilled' ? liveResult.value : [];
      const sources = [
        ...new Map(
          [...osm, ...publicCameras, ...live].map((source) => [
            source.id,
            source,
          ]),
        ).values(),
      ];
      await this.onSources?.(sources, {
        query,
        place,
        focus: true,
        osmCount: osm.length,
        publicCount: publicCameras.length,
        liveCount: live.length,
        osmRadiusKm: osmDiscovery.radiusKm,
      });
      if (
        liveResult.status === 'rejected' &&
        ['youtube_key_missing', 'youtube_key_invalid'].includes(
          liveResult.reason?.message,
        )
      ) {
        if (this._setupButton) this._setupButton.hidden = false;
      }
      const warnings = [
        osmResult.status === 'rejected' ? 'OSM indisponível' : '',
        publicResult.status === 'rejected'
          ? 'catálogo público indisponível'
          : '',
        liveResult.status === 'rejected' ? 'YouTube indisponível' : '',
      ].filter(Boolean);
      const osmStatus = osm.length
        ? `${osm.length} webcams OSM em até ${osmDiscovery.radiusKm} km`
        : osmResult.status === 'fulfilled'
          ? `OSM: nenhuma webcam com URL pública em até ${osmDiscovery.radiusKm} km`
          : 'OSM: consulta indisponível';
      const nearestPublic = publicCameras[0];
      const publicStatus = nearestPublic
        ? `${publicCameras.length} câmeras públicas próximas (mais próxima: ${nearestPublic.city || nearestPublic.name}, ${Math.round(nearestPublic.distanceKm)} km)`
        : 'nenhuma câmera do diretório público em até 300 km';
      this._setStatus(
        `${osmStatus} · ${publicStatus} · ${live.length} transmissões webcam adicionadas ao CCTV${warnings.length ? ` · ${warnings.join(' · ')}` : ''}.`,
        sources.length ? 'ok' : 'empty',
      );
    } catch (error) {
      if (error?.name !== 'AbortError' && generation === this.generation) {
        this._setStatus(
          error?.message === 'place_not_found'
            ? 'Local não encontrado.'
            : 'Não foi possível pesquisar esta área agora.',
          'error',
        );
      }
    } finally {
      if (generation === this.generation && this._searchButton)
        this._searchButton.disabled = false;
    }
  }

  async discoverBounds(bbox) {
    const publicBounds = centeredBounds(bbox, 8, 12);
    if (!publicBounds) return;
    const osmBounds = centeredBounds(publicBounds, 1.2, 1.2);
    const key = [
      publicBounds.south,
      publicBounds.west,
      publicBounds.north,
      publicBounds.east,
    ]
      .map((n) => Number(n).toFixed(2))
      .join(':');
    if (this.seenBounds.has(key)) return;
    this.seenBounds.add(key);
    try {
      const [osmResult, publicResult] = await Promise.allSettled([
        this._osmSources(osmBounds, 'Área visível', undefined),
        this._publicCatalogSourcesForBounds(publicBounds, undefined),
      ]);
      const osm = osmResult.status === 'fulfilled' ? osmResult.value : [];
      const publicCameras =
        publicResult.status === 'fulfilled' ? publicResult.value : [];
      const sources = [
        ...new Map(
          [...publicCameras, ...osm].map((source) => [source.id, source]),
        ).values(),
      ];
      await this.onSources?.(sources, {
        focus: false,
        osmCount: osm.length,
        publicCount: publicCameras.length,
        liveCount: 0,
      });
      if (sources.length)
        this._setStatus(
          `${publicCameras.length} câmeras OpenCCTV e ${osm.length} webcams OSM da área visível adicionadas ao globo.`,
          'ok',
        );
      if (osmResult.status === 'rejected' && publicResult.status === 'rejected')
        throw new Error('visible_sources_unavailable');
    } catch {
      this.seenBounds.delete(key);
    }
  }

  _setStatus(message, kind = '') {
    if (!this._status) return;
    this._status.textContent = message;
    this._status.dataset.state = kind;
  }

  destroy() {
    this.listeners.abort();
    this.abort?.abort();
  }
}
