import { UiLifetime } from './uiLifetime.js';

function clean(value) {
  return String(value ?? '').trim();
}

function aircraftIdentity(info) {
  if (!info) return null;
  return {
    kind: 'aircraft',
    id: clean(info.icao24),
    label:
      clean(info.callsign) || clean(info.registration) || clean(info.icao24),
    subtitle: [clean(info.typeName || info.typeCode), clean(info.registration)]
      .filter(Boolean)
      .join(' · '),
    query: {
      icao24: clean(info.icao24),
      registration: clean(info.registration),
      model: clean(info.typeName || info.typeCode),
    },
  };
}

function vesselIdentity(info) {
  if (!info) return null;
  return {
    kind: 'vessel',
    id: clean(info.mmsi),
    label: clean(info.name) || `MMSI ${clean(info.mmsi)}`,
    subtitle: [clean(info.type), info.imo ? `IMO ${clean(info.imo)}` : '']
      .filter(Boolean)
      .join(' · '),
    query: {
      name: clean(info.name),
      imo: clean(info.imo),
      mmsi: clean(info.mmsi),
      type: clean(info.type),
    },
  };
}

function setSafeLink(anchor, href) {
  if (!anchor) return;
  const safe = clean(href);
  if (!safe.startsWith('https://')) {
    anchor.hidden = true;
    anchor.removeAttribute('href');
    return;
  }
  anchor.href = safe;
  anchor.hidden = false;
}

/** Selection-owned aircraft/vessel photography with an honest local fallback. */
export class AssetMediaControls {
  constructor({
    elements,
    aircraft,
    vessels,
    actions = {},
    fetchImpl = (...args) => globalThis.fetch(...args),
  }) {
    this.elements = elements;
    this.aircraft = aircraft;
    this.vessels = vessels;
    this.actions = actions;
    this.fetchImpl = fetchImpl;
    this.lifetime = new UiLifetime();
    this.requests = new Map();
    this.identities = new Map();
    this.destroyed = false;
    this._bind();
  }

  _bind() {
    this.lifetime.listen(window, 'gev:awareness-subject-selected', (event) => {
      const layerId = event.detail?.layerId;
      if (layerId !== 'flights' && layerId !== 'military') return;
      const layer =
        layerId === 'military' ? this.aircraft.military : this.aircraft.civil;
      this.show('aircraft', aircraftIdentity(layer?.getTrackedInfo?.()));
    });
    this.lifetime.listen(window, 'gev:awareness-subject-cleared', (event) => {
      const layerId = event.detail?.layerId;
      if (!layerId || layerId === 'flights' || layerId === 'military')
        this.clear('aircraft');
    });
    this.lifetime.listen(window, 'gev:vessel-selection-changed', (event) => {
      const selected = event.detail?.selected;
      if (!selected) return this.clear('vessel');
      this.show(
        'vessel',
        vesselIdentity(
          event.detail?.vessel || this.vessels?.getSelectedInfo?.(),
        ),
      );
    });
    for (const kind of ['aircraft', 'vessel']) {
      const refs = this.elements[kind];
      this.lifetime.listen(refs?.image, 'error', () => {
        refs.image.hidden = true;
        refs.placeholder.hidden = false;
      });
    }
  }

  _refs(kind) {
    return this.elements[kind] || {};
  }

  clear(kind) {
    this.requests.get(kind)?.abort();
    this.requests.delete(kind);
    this.identities.delete(kind);
    const refs = this._refs(kind);
    if (refs.card) refs.card.hidden = true;
  }

  async show(kind, identity) {
    if (!identity?.id || this.destroyed) return this.clear(kind);
    this.requests.get(kind)?.abort();
    const controller = new AbortController();
    this.requests.set(kind, controller);
    this.identities.set(kind, identity);
    const refs = this._refs(kind);
    if (!refs.card) return;
    refs.card.hidden = false;
    refs.card.setAttribute('aria-busy', 'true');
    refs.card.dataset.match = 'loading';
    refs.title.textContent = identity.label;
    refs.meta.textContent = identity.subtitle || 'IDENTIFICAÇÃO PÚBLICA';
    refs.image.hidden = true;
    refs.image.removeAttribute('src');
    refs.placeholder.hidden = false;
    refs.placeholderText.textContent = 'LOCALIZANDO FOTO PÚBLICA';
    refs.credit.textContent = 'Consulta sob demanda · Wikimedia Commons';
    setSafeLink(refs.source, null);
    this.actions.scheduleLayout?.();

    const params = new URLSearchParams({ kind, ...identity.query });
    try {
      const response = await this.fetchImpl(`/api/asset-photo?${params}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`asset_photo_${response.status}`);
      const payload = await response.json();
      if (this.destroyed || this.identities.get(kind)?.id !== identity.id)
        return;
      this._renderPhoto(kind, identity, payload.photo || null);
    } catch (error) {
      if (error?.name === 'AbortError') return;
      if (this.identities.get(kind)?.id !== identity.id) return;
      this._renderPhoto(kind, identity, null);
    } finally {
      if (this.identities.get(kind)?.id === identity.id) {
        refs.card.removeAttribute('aria-busy');
        this.requests.delete(kind);
      }
    }
  }

  _renderPhoto(kind, identity, photo) {
    const refs = this._refs(kind);
    if (!refs.card) return;
    if (!photo?.imageUrl) {
      refs.card.dataset.match = 'fallback';
      refs.image.hidden = true;
      refs.placeholder.hidden = false;
      refs.placeholderText.textContent = 'SEM FOTO PÚBLICA CONFIRMADA';
      refs.credit.textContent =
        identity.subtitle || 'Modelo ou tipo não informado';
      setSafeLink(refs.source, null);
      this.actions.scheduleLayout?.();
      return;
    }
    refs.card.dataset.match = photo.exact ? 'exact' : 'representative';
    refs.image.alt = photo.exact
      ? `Foto pública de ${identity.label}`
      : `Imagem representativa de ${identity.subtitle || identity.label}`;
    refs.image.src = photo.imageUrl;
    refs.image.hidden = false;
    refs.placeholder.hidden = true;
    const matchLabel = photo.exact
      ? 'VEÍCULO IDENTIFICADO'
      : 'IMAGEM REPRESENTATIVA';
    refs.credit.textContent = `${matchLabel} · ${photo.author} · ${photo.license}`;
    refs.source.textContent = 'VER FOTO E LICENÇA ↗';
    setSafeLink(refs.source, photo.sourceUrl);
    this.actions.scheduleLayout?.();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const controller of this.requests.values()) controller.abort();
    this.requests.clear();
    this.identities.clear();
    this.lifetime.destroy();
  }
}

export { aircraftIdentity, vesselIdentity };
