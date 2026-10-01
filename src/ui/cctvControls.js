import {
  _clearCctvFrame,
  _queueCctvFrame,
  _settleCctvFrame,
  _showCctvMjpeg,
  _syncCctvSourceBadge,
  _syncCctvEmbed,
} from './cctvFrames.js';
import {
  _activeCctvCameraId,
  _resetCctvCalibration,
  _beginCctvCalValueEdit,
  _syncCctvCalReadout,
} from './cctvCalibration.js';
import {
  _calBadgeLabel,
  _renderCctvState,
  _typeCctvSummary,
  _updateCctvSyncChip,
} from './cctvPresentation.js';
import { _initCctvPanel } from './cctvBindings.js';
import { CctvLiveDiscovery } from './cctvLiveDiscovery.js';
import { CctvOsmDiscovery } from './cctvOsmDiscovery.js';

/** Own camera-panel interaction and presentation; receive the camera port and application actions. */
export class CctvControls {
  constructor({ elements, cctv, actions }) {
    Object.assign(this, elements);
    this.cctv = cctv;
    this.actions = actions;
    this.destroyed = false;
    this.listeners = new AbortController();
    this._cctvUnsubscribe = null;
    this._cctvState = null;
    this._cctvSummaryTypingTimer = null;
    this._lastCctvSummaryText = '';
    this._lastSeenCctvActiveId = null;
    this._cctvChipHideTimer = null;
    this._cctvChipWasBusy = false;
    this._cctvFrameRequestToken = 0;
    this._cctvFramePreloader = null;
    this._cctvEmbedCache = new Map();
    this._cctvEmbedAbort = null;
    this._cctvEmbedResolveId = '';
    this._calibrationEdit = null;
    this._actionGeneration = 0;
    this._cctvMode = 'catalog';
    this._initCctvPanel();
    this._liveDiscovery = new CctvLiveDiscovery({
      elements: {
        _catalogButton: this._cctvModeCatalogBtn,
        _discoveryButton: this._cctvModeDiscoveryBtn,
        _osmButton: this._cctvModeOsmBtn,
        _catalogView: this._cctvCatalogView,
        _discoveryView: this._cctvDiscoveryView,
        _osmView: this._cctvOsmView,
        _queryInput: this._cctvDiscoveryQuery,
        _searchButton: this._cctvDiscoverySearchBtn,
        _status: this._cctvDiscoveryStatus,
        _setupButton: this._cctvDiscoverySetupBtn,
        _results: this._cctvDiscoveryResults,
        _player: this._cctvDiscoveryPlayer,
        _active: this._cctvDiscoveryActive,
        _activeTitle: this._cctvDiscoveryActiveTitle,
        _activeMeta: this._cctvDiscoveryActiveMeta,
        _sourceLink: this._cctvDiscoverySourceLink,
      },
      onModeChange: (mode) => {
        this._cctvMode = mode;
        this._osmDiscovery?.setActive(mode === 'osm');
        this._renderCctvState(this._cctvState);
        this.actions.syncViewport?.();
      },
      onSetupRequest: () => document.getElementById('key-setup-chip')?.click(),
    });
    this._osmDiscovery = new CctvOsmDiscovery({
      elements: {
        _queryInput: this._cctvOsmQuery,
        _searchButton: this._cctvOsmSearchBtn,
        _status: this._cctvOsmStatus,
        _results: this._cctvOsmResults,
        _player: this._cctvOsmPlayer,
        _image: this._cctvOsmImage,
        _active: this._cctvOsmActive,
        _activeTitle: this._cctvOsmActiveTitle,
        _activeMeta: this._cctvOsmActiveMeta,
        _sourceLink: this._cctvOsmSourceLink,
      },
      onFocus: (webcam) => this.actions.focusCoordinate?.(webcam),
    });
    if (this._cctvVideo && typeof MutationObserver !== 'undefined') {
      this._videoVisibilityObserver = new MutationObserver(() =>
        this._renderCctvState(this._cctvState),
      );
      if (this._cctvPanel)
        this._videoVisibilityObserver.observe(this._cctvPanel, {
          attributes: true,
          attributeFilter: ['class', 'hidden'],
        });
      this.listen(document, 'visibilitychange', () =>
        this._renderCctvState(this._cctvState),
      );
    }
  }
  listen(target, type, handler, options = {}) {
    target?.addEventListener(type, handler, {
      ...options,
      signal: this.listeners.signal,
    });
  }
  getState() {
    return this._cctvState;
  }
  connect() {
    this._cctvUnsubscribe?.();
    this._cctvUnsubscribe = null;
    if (this.destroyed) return;
    this._cctvUnsubscribe = this.cctv.subscribe?.((state) =>
      this._renderCctvState(state),
    );
    if (this.cctv.getUIState) this._renderCctvState(this.cctv.getUIState());
  }
  _clearCctvFrame(...args) {
    return _clearCctvFrame.call(this, ...args);
  }
  _queueCctvFrame(...args) {
    return _queueCctvFrame.call(this, ...args);
  }
  _settleCctvFrame(...args) {
    return _settleCctvFrame.call(this, ...args);
  }
  _showCctvMjpeg(...args) {
    return _showCctvMjpeg.call(this, ...args);
  }
  _syncCctvSourceBadge(...args) {
    return _syncCctvSourceBadge.call(this, ...args);
  }
  _syncCctvEmbed(...args) {
    return _syncCctvEmbed.call(this, ...args);
  }
  _activeCctvCameraId(...args) {
    return _activeCctvCameraId.call(this, ...args);
  }
  _resetCctvCalibration(...args) {
    return _resetCctvCalibration.call(this, ...args);
  }
  _beginCctvCalValueEdit(...args) {
    return _beginCctvCalValueEdit.call(this, ...args);
  }
  _syncCctvCalReadout(...args) {
    return _syncCctvCalReadout.call(this, ...args);
  }
  _calBadgeLabel(...args) {
    return _calBadgeLabel.call(this, ...args);
  }
  _renderCctvState(...args) {
    return _renderCctvState.call(this, ...args);
  }
  _typeCctvSummary(...args) {
    return _typeCctvSummary.call(this, ...args);
  }
  _updateCctvSyncChip(...args) {
    return _updateCctvSyncChip.call(this, ...args);
  }
  _initCctvPanel(...args) {
    return _initCctvPanel.call(this, ...args);
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._cctvVideoSurface?.stop();
    this._liveDiscovery?.destroy();
    this._osmDiscovery?.destroy();
    this._videoVisibilityObserver?.disconnect();
    this._actionGeneration++;
    this.listeners.abort();
    this._cctvUnsubscribe?.();
    this._cctvUnsubscribe = null;
    this._calibrationEdit?.(false);
    this._clearCctvFrame();
    this._cctvEmbedAbort?.abort();
    if (this._cctvEmbed) this._cctvEmbed.src = 'about:blank';
    clearInterval(this._cctvSummaryTypingTimer);
    clearTimeout(this._cctvChipHideTimer);
    this._cctvSummaryTypingTimer = null;
    this._cctvChipHideTimer = null;
    this._cctvSyncChip?.classList.remove('visible');
  }
}
