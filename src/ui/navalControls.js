import * as Cesium from 'cesium';
import { requestWorldFocus } from '../worldFocus.js';
import { UiLifetime } from './uiLifetime.js';

const VESSELS_LAYER_ID = 'ais-live-vessels';
const CABLES_LAYER_ID = 'telegeography-submarine-cables';
const BASES_LAYER_ID = 'military-installations';

function formatDistance(distanceM) {
  if (!Number.isFinite(distanceM)) return '—';
  if (distanceM < 1000) return `${Math.round(distanceM)} m`;
  return `${(distanceM / 1000).toFixed(distanceM < 10000 ? 1 : 0)} km`;
}

/** Compact a live vessel total for the narrow collapsed-panel header. */
export function formatCompactCount(value) {
  const count = Math.max(0, Math.round(Number(value) || 0));
  const units = [
    { threshold: 1_000_000_000, suffix: 'B' },
    { threshold: 1_000_000, suffix: 'M' },
    { threshold: 1_000, suffix: 'k' },
  ];
  const unit = units.find(({ threshold }) => count >= threshold);
  if (!unit) return count.toLocaleString('pt-BR');
  const scaled = count / unit.threshold;
  const digits = scaled < 10 && !Number.isInteger(scaled) ? 1 : 0;
  return `${scaled.toLocaleString('pt-BR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  })}${unit.suffix}`;
}

/** Independent maritime tracking controls backed by the existing AIS layer. */
export class NavalControls {
  constructor({ elements, viewer, vessels, actions }) {
    Object.assign(this, elements, { viewer, vessels, actions });
    this.manager = null;
    this.unsubscribe = null;
    this.lifetime = new UiLifetime();
    this.destroyed = false;
    this._bind();
    this.render();
  }

  _bind() {
    this.lifetime.listen(this._navalVesselsToggle, 'click', () => {
      void this._toggleLayer(VESSELS_LAYER_ID, this._navalVesselsToggle);
    });
    this.lifetime.listen(this._navalCablesToggle, 'click', () => {
      void this._toggleLayer(CABLES_LAYER_ID, this._navalCablesToggle);
    });
    this.lifetime.listen(this._navalBasesToggle, 'click', () => {
      void this._toggleLayer(BASES_LAYER_ID, this._navalBasesToggle);
    });
    this.lifetime.listen(this._navalNearbyBtn, 'click', () => {
      void this.showNearby();
    });
    this.lifetime.listen(this._navalCctvBtn, 'click', () => {
      this.actions.openCctv?.();
    });
    this.lifetime.listen(this._navalNearbyList, 'click', (event) => {
      const button = event.target?.closest?.('[data-vessel-mmsi]');
      if (!button || !this._navalNearbyList?.contains(button)) return;
      this.focusVessel(button.dataset.vesselMmsi);
    });
  }

  connect(manager) {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.manager = manager || null;
    if (typeof this.manager?.subscribe === 'function') {
      this.unsubscribe = this.manager.subscribe(() => this.render());
    }
    this.render();
  }

  async _toggleLayer(layerId, button) {
    if (!this.manager || button?.getAttribute('aria-busy') === 'true') return;
    const next = !this.manager.isEnabled(layerId);
    button?.setAttribute('aria-busy', 'true');
    button?.setAttribute('aria-disabled', 'true');
    try {
      const result = await this.manager.setEnabled(layerId, next, {
        origin: 'user',
      });
      if (result === false) {
        this.actions.showToast?.(
          `Não foi possível ${next ? 'ativar' : 'desativar'} esta camada.`,
        );
      }
    } catch (error) {
      console.warn(`[UI:Naval] ${layerId} toggle failed`, error);
      this.actions.showToast?.(
        'A camada naval não respondeu; tente novamente.',
      );
    } finally {
      button?.removeAttribute('aria-busy');
      button?.removeAttribute('aria-disabled');
      this.render();
    }
  }

  _viewCenter() {
    const camera = this.viewer?.camera;
    const canvas = this.viewer?.scene?.canvas;
    const ellipsoid = this.viewer?.scene?.globe?.ellipsoid;
    if (!camera || !canvas || !ellipsoid) return camera?.positionWC || null;
    return (
      camera.pickEllipsoid(
        new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
        ellipsoid,
      ) || camera.positionWC
    );
  }

  async showNearby() {
    if (!this.manager || this.destroyed) return;
    if (!this.manager.isEnabled(VESSELS_LAYER_ID)) {
      await this.manager.setEnabled(VESSELS_LAYER_ID, true, { origin: 'user' });
    }
    if (this.destroyed || !this.manager.isEnabled(VESSELS_LAYER_ID)) return;
    const entries =
      this.vessels?.getNearby?.(this._viewCenter(), Infinity, 8) || [];
    this._renderNearby(entries);
    this.actions.scheduleLayout?.();
  }

  _renderNearby(entries) {
    if (!this._navalNearbyList || !this._navalNearbySummary) return;
    this._navalNearbyList.replaceChildren();
    this._navalNearbySummary.textContent = entries.length
      ? `${entries.length} MAIS PRÓXIMAS`
      : 'NENHUMA NA VISÃO';
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.textContent =
        'Nenhuma posição AIS recebida perto do centro do mapa.';
      this._navalNearbyList.append(empty);
      return;
    }
    for (const entry of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.vesselMmsi = String(entry.mmsi);
      const name = document.createElement('strong');
      name.textContent = entry.name || `MMSI ${entry.mmsi}`;
      const meta = document.createElement('span');
      meta.textContent = `${entry.mmsi} · ${formatDistance(entry.distanceM)}`;
      button.append(name, meta);
      this._navalNearbyList.append(button);
    }
  }

  focusVessel(mmsi) {
    const vessel = this.vessels?.findByQuery?.(mmsi);
    if (!vessel || !this.vessels?.selectById?.(mmsi)) {
      this.actions.showToast?.(
        'A embarcação não está mais no sinal AIS atual.',
      );
      return false;
    }
    requestWorldFocus({
      kind: 'vessel',
      id: vessel.mmsi,
      label: vessel.name || vessel.mmsi,
      position: vessel.position,
    });
    return true;
  }

  _layerSnapshot(layerId) {
    return (
      this.manager?.getAll?.().find((layer) => layer.id === layerId) || null
    );
  }

  _syncToggle(button, layerId, onLabel, offLabel) {
    if (!button) return;
    const enabled = Boolean(this.manager?.isEnabled?.(layerId));
    button.classList.toggle('active', enabled);
    button.setAttribute('aria-pressed', String(enabled));
    button.textContent = enabled ? onLabel : offLabel;
  }

  render() {
    const snapshot = this._layerSnapshot(VESSELS_LAYER_ID);
    const stats = snapshot?.stats || this.vessels?.getStats?.() || {};
    const enabled = Boolean(this.manager?.isEnabled?.(VESSELS_LAYER_ID));
    const count = Number.isFinite(stats.count) ? stats.count : 0;
    if (this._navalVesselCount) {
      const fullCount = count.toLocaleString('pt-BR');
      this._navalVesselCount.textContent = formatCompactCount(count);
      this._navalVesselCount.title = `${fullCount} embarcaÃ§Ãµes AIS visÃ­veis`;
      this._navalVesselCount.setAttribute(
        'aria-label',
        `${fullCount} embarcaÃ§Ãµes AIS visÃ­veis`,
      );
    }
    if (this._navalFeedState) {
      this._navalFeedState.textContent = !enabled
        ? 'AIS DESATIVADO'
        : stats.loading
          ? 'CONECTANDO AO AIS'
          : stats.error
            ? 'AIS DEGRADADO'
            : 'AIS AO VIVO';
    }
    if (this._navalFeedDetail) {
      this._navalFeedDetail.textContent = !enabled
        ? 'Ative o rastreamento marítimo para receber posições públicas.'
        : stats.error ||
          (stats.loading
            ? 'Aguardando as primeiras posições do provedor.'
            : `${count.toLocaleString('pt-BR')} embarcações recebidas · AISStream`);
    }
    if (this._navalNearbyBtn)
      this._navalNearbyBtn.disabled = !enabled || stats.loading;
    this._syncToggle(
      this._navalVesselsToggle,
      VESSELS_LAYER_ID,
      'DESATIVAR EMBARCAÇÕES',
      'ATIVAR EMBARCAÇÕES',
    );
    this._syncToggle(
      this._navalCablesToggle,
      CABLES_LAYER_ID,
      'CABOS SUBMARINOS ATIVOS',
      'CABOS SUBMARINOS',
    );
    this._syncToggle(
      this._navalBasesToggle,
      BASES_LAYER_ID,
      'BASES E INSTALAÇÕES ATIVAS',
      'BASES E INSTALAÇÕES',
    );
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.manager = null;
    this.lifetime.destroy();
  }
}
