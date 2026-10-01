const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const PRIVATE_HOST =
  /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[?::1\]?)$/i;

function finiteCoordinate(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max
    ? number
    : null;
}

/** Build a deliberately small, proxy-compatible Overpass webcam query. */
export function osmWebcamQuery({ south, west, north, east }) {
  const values = [south, west, north, east].map(Number);
  if (values.some((value) => !Number.isFinite(value))) return '';
  const bbox = values.map((value) => value.toFixed(6)).join(',');
  return `[out:json][timeout:25];(
    nwr["contact:webcam"](${bbox});
    nwr["webcam"](${bbox});
    nwr["surveillance"="webcam"]["website"](${bbox});
    nwr["surveillance:type"="webcam"]["website"](${bbox});
  );out center tags;`;
}

/** Restrict OSM-authored links to ordinary public HTTP(S) destinations. */
export function safeOsmWebcamUrl(rawValue) {
  const firstUrl = String(rawValue || '')
    .split(/[;,]\s*(?=https?:\/\/)/i)
    .map((value) => value.trim())
    .find((value) => /^https?:\/\//i.test(value));
  if (!firstUrl || firstUrl.length > 1024) return '';
  try {
    const url = new URL(firstUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (url.username || url.password || PRIVATE_HOST.test(url.hostname))
      return '';
    return url.href;
  } catch {
    return '';
  }
}

function youtubeEmbedUrl(sourceUrl) {
  try {
    const url = new URL(sourceUrl);
    let id = '';
    if (url.hostname === 'youtu.be') id = url.pathname.split('/')[1] || '';
    if (/^(?:www\.)?youtube\.com$/i.test(url.hostname)) {
      if (url.pathname === '/watch') id = url.searchParams.get('v') || '';
      else if (/^\/(?:embed|live)\//.test(url.pathname))
        id = url.pathname.split('/')[2] || '';
    }
    return YOUTUBE_ID.test(id)
      ? `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1`
      : '';
  } catch {
    return '';
  }
}

function mediaKind(sourceUrl, embedUrl) {
  if (embedUrl) return 'TRANSMISSÃO INCORPORÁVEL';
  try {
    return /\.(?:avif|gif|jpe?g|png|webp)(?:$|\?)/i.test(
      new URL(sourceUrl).pathname,
    )
      ? 'IMAGEM PÚBLICA'
      : 'FONTE EXTERNA';
  } catch {
    return 'FONTE EXTERNA';
  }
}

/** Convert an OSM node/way/relation carrying a webcam URL into a UI record. */
export function normalizeOsmWebcamElement(element) {
  const tags = element?.tags || {};
  const lat = finiteCoordinate(element?.lat ?? element?.center?.lat, -90, 90);
  const lon = finiteCoordinate(element?.lon ?? element?.center?.lon, -180, 180);
  if (lat === null || lon === null) return null;
  const explicitlyWebcam =
    (!!tags.webcam && String(tags.webcam).toLowerCase() !== 'no') ||
    String(tags.surveillance || '').toLowerCase() === 'webcam' ||
    String(tags['surveillance:type'] || '').toLowerCase() === 'webcam';
  const sourceUrl = safeOsmWebcamUrl(
    tags['contact:webcam'] ||
      tags['webcam:url'] ||
      (explicitlyWebcam ? tags.webcam : '') ||
      (explicitlyWebcam ? tags.website || tags.url : ''),
  );
  if (!sourceUrl) return null;
  const embedUrl = youtubeEmbedUrl(sourceUrl);
  const name = String(
    tags.name ||
      tags.operator ||
      tags.description ||
      `Webcam OSM ${element.id}`,
  ).trim();
  return {
    id: `${element.type || 'node'}-${element.id}`,
    name: name.slice(0, 140),
    lat,
    lon,
    sourceUrl,
    embedUrl,
    kind: mediaKind(sourceUrl, embedUrl),
  };
}

/** Keep regional searches useful without turning them into country-wide scans. */
export function osmSearchBbox(geocodeResult, maxSpan = 1.2) {
  const location = geocodeResult?.geometry?.location;
  const lat = finiteCoordinate(location?.lat, -90, 90);
  const lon = finiteCoordinate(location?.lng, -180, 180);
  if (lat === null || lon === null) return null;
  const viewport = geocodeResult?.geometry?.viewport;
  const half = Math.max(0.08, Math.min(0.6, Number(maxSpan) / 2));
  let south = finiteCoordinate(viewport?.southwest?.lat, -90, 90);
  let west = finiteCoordinate(viewport?.southwest?.lng, -180, 180);
  let north = finiteCoordinate(viewport?.northeast?.lat, -90, 90);
  let east = finiteCoordinate(viewport?.northeast?.lng, -180, 180);
  if (south === null || west === null || north === null || east === null) {
    south = lat - half;
    west = lon - half;
    north = lat + half;
    east = lon + half;
  }
  south = Math.max(south, lat - half, -90);
  north = Math.min(north, lat + half, 90);
  west = Math.max(west, lon - half, -180);
  east = Math.min(east, lon + half, 180);
  if (south >= north || west >= east) {
    return {
      south: Math.max(-90, lat - half),
      west: Math.max(-180, lon - half),
      north: Math.min(90, lat + half),
      east: Math.min(180, lon + half),
    };
  }
  return { south, west, north, east };
}

export class CctvOsmDiscovery {
  constructor({
    elements,
    onFocus,
    fetchImpl = (...args) => globalThis.fetch(...args),
  }) {
    Object.assign(this, elements);
    this.onFocus = onFocus;
    this.fetchImpl = fetchImpl;
    this.results = [];
    this.selectedId = '';
    this.abort = null;
    this.searchGeneration = 0;
    this.listeners = new AbortController();
    const signal = this.listeners.signal;
    this._searchButton?.addEventListener('click', () => this.search(), {
      signal,
    });
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

  async search() {
    const query = String(this._queryInput?.value || '').trim();
    if (query.length < 2) {
      this._setStatus('Digite uma cidade ou região.', 'error');
      this._queryInput?.focus();
      return;
    }
    this.abort?.abort();
    this.abort = new AbortController();
    const generation = ++this.searchGeneration;
    if (this._searchButton) this._searchButton.disabled = true;
    this._setStatus('LOCALIZANDO ÁREA E CONSULTANDO OPENSTREETMAP…', 'loading');
    try {
      const geocodeResponse = await this.fetchImpl(
        `/api/geocode?q=${encodeURIComponent(query)}`,
        { signal: this.abort.signal, headers: { Accept: 'application/json' } },
      );
      const geocode = await geocodeResponse.json();
      if (!geocodeResponse.ok) throw new Error('geocode_failed');
      const place = Array.isArray(geocode?.results) ? geocode.results[0] : null;
      const bbox = osmSearchBbox(place);
      if (!bbox) throw new Error('place_not_found');
      const overpassQuery = osmWebcamQuery(bbox);
      const overpassResponse = await this.fetchImpl('/api/overpass', {
        method: 'POST',
        signal: this.abort.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: new URLSearchParams({ data: overpassQuery }).toString(),
      });
      const payload = await overpassResponse.json();
      if (!overpassResponse.ok) throw new Error('overpass_failed');
      if (generation !== this.searchGeneration) return;
      const unique = new Map();
      for (const element of Array.isArray(payload?.elements)
        ? payload.elements
        : []) {
        const record = normalizeOsmWebcamElement(element);
        if (record) unique.set(record.id, record);
      }
      this.results = [...unique.values()].slice(0, 80);
      this.selectedId = '';
      this._clearActive();
      this._renderResults();
      this._setStatus(
        this.results.length
          ? `${this.results.length} webcams públicas mapeadas perto de “${query}”.`
          : `Nenhuma webcam pública com endereço foi mapeada perto de “${query}”.`,
        this.results.length ? 'ok' : 'empty',
      );
    } catch (error) {
      if (
        error?.name !== 'AbortError' &&
        generation === this.searchGeneration
      ) {
        this.results = [];
        this._renderResults();
        this._clearActive();
        this._setStatus(
          error?.message === 'place_not_found'
            ? 'Local não encontrado.'
            : 'Não foi possível consultar o OpenStreetMap agora.',
          'error',
        );
      }
    } finally {
      if (generation === this.searchGeneration && this._searchButton)
        this._searchButton.disabled = false;
    }
  }

  setActive(active) {
    if (!active) this._stopPlayer();
    else if (this.selectedId) this._loadSelected(this.selectedId);
  }

  _setStatus(text, state) {
    if (!this._status) return;
    this._status.textContent = text;
    this._status.dataset.state = state;
  }

  _renderResults() {
    if (!this._results) return;
    this._results.replaceChildren();
    for (const webcam of this.results) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cctv-live-result cctv-osm-result';
      button.dataset.webcamId = webcam.id;
      button.setAttribute(
        'aria-pressed',
        String(webcam.id === this.selectedId),
      );
      const marker = document.createElement('span');
      marker.className = 'cctv-osm-marker';
      marker.setAttribute('aria-hidden', 'true');
      const copy = document.createElement('span');
      copy.className = 'cctv-live-result-copy';
      const title = document.createElement('strong');
      title.textContent = webcam.name;
      const meta = document.createElement('small');
      meta.textContent = `${webcam.kind} · ${webcam.lat.toFixed(4)}, ${webcam.lon.toFixed(4)}`;
      copy.append(title, meta);
      button.append(marker, copy);
      button.addEventListener('click', () => this._select(webcam.id), {
        signal: this.listeners.signal,
      });
      this._results.appendChild(button);
    }
  }

  _select(id) {
    const webcam = this.results.find((item) => item.id === id);
    if (!webcam) return;
    this.selectedId = id;
    this._renderResults();
    this._loadSelected(id);
    this.onFocus?.(webcam);
  }

  _loadSelected(id) {
    const webcam = this.results.find((item) => item.id === id);
    if (!webcam) return;
    this._clearActive();
    if (this._active) this._active.hidden = false;
    if (this._activeTitle) this._activeTitle.textContent = webcam.name;
    if (this._activeMeta)
      this._activeMeta.textContent = `${webcam.kind} · POSIÇÃO INFORMADA NO OPENSTREETMAP`;
    if (this._sourceLink) this._sourceLink.href = webcam.sourceUrl;
    if (webcam.embedUrl && this._player) {
      this._player.src = webcam.embedUrl;
      this._player.hidden = false;
    } else if (webcam.kind === 'IMAGEM PÚBLICA' && this._image) {
      this._image.src = webcam.sourceUrl;
      this._image.hidden = false;
    }
  }

  _stopPlayer() {
    if (this._player) this._player.src = 'about:blank';
  }

  _clearActive() {
    this._stopPlayer();
    if (this._player) this._player.hidden = true;
    if (this._image) {
      this._image.removeAttribute('src');
      this._image.hidden = true;
    }
    if (this._active) this._active.hidden = true;
  }

  destroy() {
    this.searchGeneration++;
    this.abort?.abort();
    this.listeners.abort();
    this._clearActive();
  }
}
