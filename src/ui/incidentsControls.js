import * as Cesium from 'cesium';
import { createIncidentSource } from '../incidents/source.js';
import { UiLifetime } from './uiLifetime.js';

const REFRESH_MS = 5 * 60_000;
const SEVERITY_RANK = Object.freeze({ high: 4, medium: 3, low: 2, monitor: 1 });
const COLORS = Object.freeze({
  high: Cesium.Color.fromCssColorString('#ff4d61'),
  medium: Cesium.Color.fromCssColorString('#ffb020'),
  low: Cesium.Color.fromCssColorString('#f5dc63'),
  monitor: Cesium.Color.fromCssColorString('#42d9ff'),
});
const SEVERITY_LABELS = Object.freeze({
  high: 'ALTO',
  medium: 'MODERADO',
  low: 'BAIXO',
  monitor: 'MONITORAMENTO',
});
const MODE_CONFIG = Object.freeze({
  events: Object.freeze({
    title: 'EVENTOS',
    idle: 'NASA EONET + GDACS · seleção manual e persistente.',
    loading: 'Consultando NASA EONET e GDACS...',
    empty: 'Nenhum incidente corresponde aos filtros.',
    providers: 2,
  }),
  environment: Object.freeze({
    title: 'AMBIENTAL',
    idle: 'QUALIDADE DO AR GLOBAL · OPEN-METEO + CAMS',
    loading: 'Calculando a malha global de qualidade do ar...',
    empty: 'Nenhuma leitura ambiental disponível.',
    providers: 1,
  }),
  ocean: Object.freeze({
    title: 'OCEANO',
    idle: 'BOIAS E ESTAÇÕES OCEÂNICAS · NOAA NDBC',
    loading: 'Consultando boias e estações oceânicas...',
    empty: 'Nenhuma observação oceânica disponível.',
    providers: 1,
  }),
  alerts: Object.freeze({
    title: 'ALERTAS',
    idle: 'ALERTAS OFICIAIS ATIVOS · US NATIONAL WEATHER SERVICE',
    loading: 'Consultando alertas oficiais ativos...',
    empty: 'Nenhum alerta oficial georreferenciado ativo.',
    providers: 1,
  }),
});

function formatCompactCount(value) {
  const count = Math.max(0, Math.round(Number(value) || 0));
  return count >= 1000
    ? `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`
    : String(count);
}

function formatAge(timestamp) {
  if (!Number.isFinite(timestamp)) return 'HORARIO INDISPONIVEL';
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60_000);
  if (minutes < 60) return `HA ${Math.max(1, minutes)} MIN`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `HA ${hours} H` : `HA ${Math.floor(hours / 24)} DIAS`;
}

function matchesFilters(record, filters) {
  if (
    filters.source !== 'all' &&
    record.sourceCode !== filters.source &&
    !record.sources?.some((source) => source.code === filters.source)
  )
    return false;
  if (filters.category !== 'all' && record.category !== filters.category)
    return false;
  if (filters.severity !== 'all' && record.severity !== filters.severity)
    return false;
  if (filters.period !== 'all') {
    const maxAge = Number(filters.period) * 60 * 60_000;
    if (!record.updatedAt || Date.now() - record.updatedAt > maxAge)
      return false;
  }
  return true;
}

function sortedRecords(records) {
  return [...records].sort(
    (a, b) =>
      (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0) ||
      (b.updatedAt || 0) - (a.updatedAt || 0),
  );
}

/** Own the global incidents panel, map markers and explicit selection. */
export class IncidentsControls {
  constructor({ elements, viewer, source = createIncidentSource(), actions }) {
    Object.assign(this, elements, { viewer, source, actions });
    this.lifetime = new UiLifetime();
    this.dataSource = new Cesium.CustomDataSource('global-incidents');
    this.dataSource.show = false;
    this.viewer.dataSources.add(this.dataSource);
    this.enabled = false;
    this.mode = 'events';
    this.loading = false;
    this.records = [];
    this.visibleRecords = [];
    this.entities = new Map();
    this.selectedId = null;
    this.request = null;
    this.refreshTimer = null;
    this.providers = {};
    this.lastError = null;
    this.stale = false;
    this.snapshots = new Map();
    this.pickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    this._bind();
    this.render();
  }

  _bind() {
    this.lifetime.listen(this._incidentsModeTabs, 'click', (event) => {
      const button = event.target?.closest?.('[data-incidents-mode]');
      if (!button || !this._incidentsModeTabs?.contains(button)) return;
      void this.setMode(button.dataset.incidentsMode);
    });
    this.lifetime.listen(this._incidentsEnableBtn, 'click', () => {
      void this.setEnabled(!this.enabled);
    });
    this.lifetime.listen(this._incidentsRefreshBtn, 'click', () => {
      void this.refresh({ force: true });
    });
    for (const select of [
      this._incidentsSourceFilter,
      this._incidentsCategoryFilter,
      this._incidentsSeverityFilter,
      this._incidentsPeriodFilter,
    ]) {
      this.lifetime.listen(select, 'change', () => this.applyFilters());
    }
    this.lifetime.listen(this._incidentsList, 'click', (event) => {
      const button = event.target?.closest?.('[data-incident-id]');
      if (!button || !this._incidentsList?.contains(button)) return;
      this.select(button.dataset.incidentId, { focus: true });
    });
    this.lifetime.listen(this._incidentFocusBtn, 'click', () => {
      if (this.selectedId) this.focus(this.selectedId);
    });
    this.lifetime.listen(this._incidentCloseBtn, 'click', () => {
      this.select(null);
    });
    this.pickHandler.setInputAction((movement) => {
      if (!this.enabled) return;
      const picked = this.viewer.scene.pick(movement.position);
      const id = picked?.id?.properties?.incidentId?.getValue?.(
        Cesium.JulianDate.now(),
      );
      if (id) this.select(String(id));
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  _filters() {
    return {
      source:
        this.mode === 'events'
          ? this._incidentsSourceFilter?.value || 'all'
          : 'all',
      category:
        this.mode === 'events'
          ? this._incidentsCategoryFilter?.value || 'all'
          : 'all',
      severity: this._incidentsSeverityFilter?.value || 'all',
      period: this._incidentsPeriodFilter?.value || 'all',
    };
  }

  async setMode(mode) {
    if (!MODE_CONFIG[mode] || mode === this.mode) return false;
    this.request?.abort();
    this.mode = mode;
    this.select(null);
    const snapshot = this.snapshots.get(mode);
    this.records = snapshot?.incidents || [];
    this.providers = snapshot?.providers || {};
    this.stale = snapshot?.stale === true;
    this.lastError = null;
    this.applyFilters();
    if (this.enabled) await this.refresh();
    return true;
  }

  async setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.dataSource.show = this.enabled;
    clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    if (!this.enabled) {
      this.request?.abort();
      this.select(null);
      this.render();
      this.viewer.scene.requestRender();
      return;
    }
    this.render();
    await this.refresh();
    if (this.enabled)
      this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_MS);
  }

  async refresh({ force = false } = {}) {
    if (!this.enabled || (this.loading && !force)) return false;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.loading = true;
    this.lastError = null;
    this.render();
    try {
      const snapshot = await this.source.getSnapshot({
        signal: request.signal,
        mode: this.mode,
      });
      if (request.signal.aborted || this.request !== request || !this.enabled)
        return false;
      this.records = snapshot.incidents;
      this.providers = snapshot.providers;
      this.stale = snapshot.stale;
      this.snapshots.set(this.mode, snapshot);
      this.applyFilters();
      return true;
    } catch (error) {
      if (request.signal.aborted || this.request !== request) return false;
      this.lastError = error?.message || 'Falha ao carregar incidentes';
      this.actions.showToast?.(
        'A fonte pública selecionada está indisponível.',
      );
      return false;
    } finally {
      if (this.request === request) {
        this.request = null;
        this.loading = false;
        this.render();
      }
    }
  }

  applyFilters() {
    this.visibleRecords = sortedRecords(
      this.records.filter((record) => matchesFilters(record, this._filters())),
    );
    this._renderEntities();
    if (
      this.selectedId &&
      !this.visibleRecords.some((record) => record.id === this.selectedId)
    )
      this.select(null);
    this.render();
    this.actions.scheduleLayout?.();
  }

  _renderEntities() {
    this.dataSource.entities.removeAll();
    this.entities.clear();
    for (const record of this.visibleRecords) {
      const color = COLORS[record.severity] || COLORS.monitor;
      const entity = this.dataSource.entities.add({
        id: `incident:${record.id}`,
        position: Cesium.Cartesian3.fromDegrees(record.lon, record.lat, 80),
        point: {
          pixelSize:
            record.severity === 'high'
              ? 15
              : record.severity === 'medium'
                ? 12
                : 9,
          color,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.88),
          outlineWidth: 2,
          disableDepthTestDistance: 1_800_000,
          scaleByDistance: new Cesium.NearFarScalar(
            5_000,
            1.2,
            12_000_000,
            0.65,
          ),
        },
        label: {
          text: record.title,
          show: false,
          font: '500 12px JetBrains Mono',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 4,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -22),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            4_000_000,
          ),
          disableDepthTestDistance: 1_800_000,
        },
        properties: { incidentId: record.id },
      });
      this.entities.set(record.id, entity);
    }
    this.dataSource.show = this.enabled;
    this.viewer.scene.requestRender();
  }

  select(id, { focus = false } = {}) {
    const next = id
      ? this.visibleRecords.find((record) => record.id === id) || null
      : null;
    const previous = this.entities.get(this.selectedId);
    if (previous?.label) previous.label.show = false;
    if (previous?.point) previous.point.outlineWidth = 2;
    this.selectedId = next?.id || null;
    const current = this.entities.get(this.selectedId);
    if (current?.label) current.label.show = true;
    if (current?.point) current.point.outlineWidth = 4;
    this._renderDetail(next);
    this._renderList();
    if (focus && next) this.focus(next.id);
    this.viewer.scene.requestRender();
    this.actions.scheduleLayout?.();
  }

  focus(id) {
    const record = this.visibleRecords.find((item) => item.id === id);
    if (!record) return false;
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        record.lon,
        record.lat,
        650_000,
      ),
      duration: 1.8,
    });
    return true;
  }

  _renderDetail(record) {
    if (!this._incidentDetail) return;
    this._incidentDetail.hidden = !record;
    if (!record) return;
    this._incidentDetailTitle.textContent = record.title;
    this._incidentDetailMeta.textContent = `${record.categoryLabel.toUpperCase()} · ${SEVERITY_LABELS[record.severity]} · ${formatAge(record.updatedAt)}`;
    this._incidentDetailSummary.textContent =
      record.summary || 'A fonte nao publicou uma descricao adicional.';
    this._incidentDetailCoords.textContent = `${record.lat.toFixed(3)}, ${record.lon.toFixed(3)} · ${record.source}`;
    this._incidentSourceLinks.replaceChildren();
    for (const source of record.sources || []) {
      if (!source.url) continue;
      const link = document.createElement('a');
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `ABRIR ${source.name.toUpperCase()}`;
      this._incidentSourceLinks.append(link);
    }
  }

  _renderList() {
    if (!this._incidentsList) return;
    this._incidentsList.replaceChildren();
    const empty = (text) => {
      const paragraph = document.createElement('p');
      paragraph.className = 'incidents-empty';
      paragraph.textContent = text;
      this._incidentsList.append(paragraph);
    };
    if (!this.enabled)
      return empty('Ative o monitoramento para carregar dados públicos.');
    if (this.loading && !this.visibleRecords.length)
      return empty(MODE_CONFIG[this.mode].loading);
    if (!this.visibleRecords.length)
      return empty(
        this.lastError
          ? 'Nao foi possivel obter os dados agora.'
          : MODE_CONFIG[this.mode].empty,
      );
    for (const record of this.visibleRecords.slice(0, 80)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.incidentId = record.id;
      button.className = 'incident-row';
      button.classList.toggle('selected', record.id === this.selectedId);
      button.setAttribute(
        'aria-pressed',
        String(record.id === this.selectedId),
      );
      const signal = document.createElement('span');
      signal.className = `incident-severity incident-severity-${record.severity}`;
      signal.setAttribute('aria-hidden', 'true');
      const copy = document.createElement('span');
      copy.className = 'incident-row-copy';
      const title = document.createElement('strong');
      title.textContent = record.title;
      const meta = document.createElement('span');
      meta.textContent = `${record.categoryLabel.toUpperCase()} · ${formatAge(record.updatedAt)} · ${record.source}`;
      copy.append(title, meta);
      button.append(signal, copy);
      this._incidentsList.append(button);
    }
  }

  render() {
    const config = MODE_CONFIG[this.mode];
    const count = this.visibleRecords.length;
    if (this._incidentsCount) {
      this._incidentsCount.textContent = formatCompactCount(count);
      this._incidentsCount.title = `${count.toLocaleString('pt-BR')} registros visíveis`;
    }
    for (const button of this._incidentsModeTabs?.querySelectorAll?.(
      '[data-incidents-mode]',
    ) || []) {
      const active = button.dataset.incidentsMode === this.mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    }
    if (this._incidentsListTitle)
      this._incidentsListTitle.textContent = config.title;
    for (const label of this._incidentsPanel?.querySelectorAll?.(
      '[data-events-only]',
    ) || [])
      label.hidden = this.mode !== 'events';
    if (this._incidentsEnableBtn) {
      this._incidentsEnableBtn.classList.toggle('active', this.enabled);
      this._incidentsEnableBtn.setAttribute(
        'aria-pressed',
        String(this.enabled),
      );
      this._incidentsEnableBtn.textContent = this.enabled
        ? 'DESATIVAR MONITOR'
        : 'ATIVAR MONITOR';
    }
    if (this._incidentsRefreshBtn) {
      this._incidentsRefreshBtn.disabled = !this.enabled || this.loading;
      this._incidentsRefreshBtn.textContent = this.loading
        ? 'ATUALIZANDO...'
        : 'ATUALIZAR';
    }
    for (const select of [
      this._incidentsSourceFilter,
      this._incidentsCategoryFilter,
      this._incidentsSeverityFilter,
      this._incidentsPeriodFilter,
    ])
      if (select) select.disabled = !this.enabled;
    if (this._incidentsFeedState)
      this._incidentsFeedState.textContent = !this.enabled
        ? 'MONITORAMENTO DESATIVADO'
        : this.loading
          ? 'SINCRONIZANDO FONTES'
          : this.lastError
            ? 'FONTES INDISPONIVEIS'
            : this.stale
              ? 'DADOS EM CACHE'
              : 'MONITORAMENTO ATIVO';
    if (this._incidentsFeedDetail) {
      const activeProviders = Object.values(this.providers).filter(
        (provider) => provider?.ok,
      ).length;
      this._incidentsFeedDetail.textContent = !this.enabled
        ? config.idle
        : this.lastError ||
          `${count.toLocaleString('pt-BR')} exibidos · ${this.records.length.toLocaleString('pt-BR')} recebidos · ${activeProviders}/${config.providers} fontes`;
    }
    this._renderList();
  }

  destroy() {
    clearInterval(this.refreshTimer);
    this.request?.abort();
    this.lifetime.destroy();
    this.pickHandler?.destroy();
    this.viewer.dataSources.remove(this.dataSource, true);
    this.entities.clear();
  }
}
