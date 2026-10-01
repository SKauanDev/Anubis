const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

export function validLiveBroadcast(item) {
  return (
    !!item &&
    YOUTUBE_ID.test(String(item.id || '')) &&
    typeof item.title === 'string' &&
    item.title.trim().length > 0 &&
    item.embedUrl ===
      `https://www.youtube-nocookie.com/embed/${item.id}?autoplay=1&mute=1` &&
    item.sourceUrl === `https://www.youtube.com/watch?v=${item.id}`
  );
}

function errorMessage(code) {
  switch (code) {
    case 'youtube_key_missing':
      return 'Configure YOUTUBE_DATA_API_KEY em POWER UP para ativar a busca.';
    case 'youtube_key_invalid':
      return 'A chave do YouTube está inválida ou a API ainda não foi ativada.';
    case 'youtube_quota_exhausted':
      return 'A cota diária de buscas do YouTube foi atingida. Tente amanhã.';
    case 'rate_limited':
      return 'Muitas buscas seguidas. Aguarde um minuto e tente novamente.';
    default:
      return 'Não foi possível consultar transmissões agora.';
  }
}

/** Manages the opt-in, non-geocoded live-broadcast discovery surface. */
export class CctvLiveDiscovery {
  constructor({
    elements,
    onModeChange,
    onSetupRequest,
    fetchImpl = (...args) => globalThis.fetch(...args),
  }) {
    Object.assign(this, elements);
    this.onModeChange = onModeChange;
    this.onSetupRequest = onSetupRequest;
    this.fetchImpl = fetchImpl;
    this.mode = 'catalog';
    this.results = [];
    this.selectedId = '';
    this.abort = null;
    this.searchGeneration = 0;
    this.listeners = new AbortController();
    const signal = this.listeners.signal;
    this._catalogButton?.addEventListener(
      'click',
      () => this.setMode('catalog'),
      { signal },
    );
    this._discoveryButton?.addEventListener(
      'click',
      () => this.setMode('discovery'),
      { signal },
    );
    this._osmButton?.addEventListener('click', () => this.setMode('osm'), {
      signal,
    });
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
    this.setMode('catalog', false);
  }

  setMode(mode, notify = true) {
    this.mode = ['discovery', 'osm'].includes(mode) ? mode : 'catalog';
    const discovery = this.mode === 'discovery';
    const osm = this.mode === 'osm';
    if (this._catalogView) this._catalogView.hidden = discovery || osm;
    if (this._discoveryView) this._discoveryView.hidden = !discovery;
    if (this._osmView) this._osmView.hidden = !osm;
    this._catalogButton?.classList.toggle('active', !discovery && !osm);
    this._discoveryButton?.classList.toggle('active', discovery);
    this._osmButton?.classList.toggle('active', osm);
    this._catalogButton?.setAttribute(
      'aria-selected',
      String(!discovery && !osm),
    );
    this._discoveryButton?.setAttribute('aria-selected', String(discovery));
    this._osmButton?.setAttribute('aria-selected', String(osm));
    if (!discovery) {
      if (this._player) this._player.src = 'about:blank';
    } else if (this.selectedId) {
      this._loadSelected(this.selectedId);
    }
    if (notify) this.onModeChange?.(this.mode);
  }

  async search() {
    const query = String(this._queryInput?.value || '').trim();
    if (query.length < 2) {
      this._setStatus('Digite uma cidade, região ou ponto turístico.', 'error');
      this._queryInput?.focus();
      return;
    }
    this.abort?.abort();
    this.abort = new AbortController();
    const generation = ++this.searchGeneration;
    if (this._searchButton) this._searchButton.disabled = true;
    this._setStatus('BUSCANDO TRANSMISSÕES ATIVAS…', 'loading');
    try {
      const response = await this.fetchImpl(
        `/api/cctv-live-discovery?q=${encodeURIComponent(query)}`,
        { signal: this.abort.signal, headers: { Accept: 'application/json' } },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || 'request_failed');
      if (generation !== this.searchGeneration) return;
      if (this._setupButton) this._setupButton.hidden = true;
      this.results = (
        Array.isArray(payload?.broadcasts) ? payload.broadcasts : []
      ).filter(validLiveBroadcast);
      this.selectedId = '';
      if (this._player) {
        this._player.src = 'about:blank';
        this._player.hidden = true;
      }
      if (this._active) this._active.hidden = true;
      this._renderResults();
      this._setStatus(
        this.results.length
          ? `${this.results.length} transmissões ao vivo relacionadas a “${query}”.`
          : `Nenhuma transmissão incorporável ativa encontrada para “${query}”.`,
        this.results.length ? 'ok' : 'empty',
      );
    } catch (error) {
      if (
        error?.name !== 'AbortError' &&
        generation === this.searchGeneration
      ) {
        this.results = [];
        this._renderResults();
        this._setStatus(errorMessage(error?.message), 'error');
        if (this._setupButton)
          this._setupButton.hidden = ![
            'youtube_key_missing',
            'youtube_key_invalid',
          ].includes(error?.message);
      }
    } finally {
      if (generation === this.searchGeneration && this._searchButton)
        this._searchButton.disabled = false;
    }
  }

  _setStatus(text, state) {
    if (!this._status) return;
    this._status.textContent = text;
    this._status.dataset.state = state;
  }

  _renderResults() {
    if (!this._results) return;
    this._results.replaceChildren();
    for (const broadcast of this.results) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cctv-live-result';
      button.dataset.videoId = broadcast.id;
      button.setAttribute(
        'aria-pressed',
        String(broadcast.id === this.selectedId),
      );
      if (broadcast.thumbnailUrl) {
        const image = document.createElement('img');
        image.src = broadcast.thumbnailUrl;
        image.alt = '';
        image.loading = 'lazy';
        image.referrerPolicy = 'no-referrer';
        button.appendChild(image);
      }
      const copy = document.createElement('span');
      copy.className = 'cctv-live-result-copy';
      const title = document.createElement('strong');
      title.textContent = broadcast.title;
      const channel = document.createElement('small');
      channel.textContent = `AO VIVO · ${broadcast.channel || 'YouTube'}`;
      copy.append(title, channel);
      button.appendChild(copy);
      button.addEventListener('click', () => this._select(broadcast.id), {
        signal: this.listeners.signal,
      });
      this._results.appendChild(button);
    }
  }

  _select(id) {
    if (!this.results.some((item) => item.id === id)) return;
    this.selectedId = id;
    this._renderResults();
    this._loadSelected(id);
  }

  _loadSelected(id) {
    const broadcast = this.results.find((item) => item.id === id);
    if (!broadcast || !this._player) return;
    this._player.src = broadcast.embedUrl;
    this._player.hidden = false;
    if (this._active) this._active.hidden = false;
    if (this._activeTitle) this._activeTitle.textContent = broadcast.title;
    if (this._activeMeta)
      this._activeMeta.textContent = `TRANSMISSÃO RELACIONADA AO LOCAL · ${broadcast.channel}`;
    if (this._sourceLink) this._sourceLink.href = broadcast.sourceUrl;
  }

  destroy() {
    this.searchGeneration++;
    this.abort?.abort();
    this.listeners.abort();
    if (this._player) this._player.src = 'about:blank';
  }
}
