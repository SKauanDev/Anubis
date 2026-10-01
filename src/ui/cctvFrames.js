export function _clearCctvFrame() {
  this._cctvFrameRequestToken += 1;
  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  this._cctvFramePreloader = null;
  if (this._cctvFrame) {
    this._cctvFrame.onload = null;
    this._cctvFrame.onerror = null;
    this._cctvFrame.classList.remove('active');
    this._cctvFrame.removeAttribute('src');
    this._cctvFrame.dataset.cameraId = '';
    this._cctvFrame.dataset.currentSrc = '';
    this._cctvFrame.dataset.loading = '';
    this._cctvFrame.dataset.error = '';
  }
  this._cctvFrameWrap?.classList.remove('loading', 'has-frame');
}

export function _queueCctvFrame(src, cameraId, cameraChanged) {
  if (this.destroyed || !this._cctvFrame || !src) return;

  if (cameraChanged) {
    // A different camera gets an honest acquisition state. Never retain
    // the prior camera's pixels under the newly selected metadata.
    this._cctvFrame.classList.remove('active');
    this._cctvFrame.removeAttribute('src');
    this._cctvFrameWrap?.classList.remove('has-frame');
  }
  this._cctvFrame.onload = null;
  this._cctvFrame.onerror = null;

  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  const token = ++this._cctvFrameRequestToken;
  this._cctvFrame.dataset.cameraId = cameraId;
  this._cctvFrame.dataset.currentSrc = src;
  this._cctvFrame.dataset.loading = 'true';
  this._cctvFrame.dataset.error = '';
  this._cctvFrameWrap?.classList.toggle(
    'loading',
    !this._cctvFrameWrap?.classList.contains('has-frame'),
  );

  const preloader = new Image();
  this._cctvFramePreloader = preloader;
  preloader.onload = () => this._settleCctvFrame(token, src, true);
  preloader.onerror = () => this._settleCctvFrame(token, src, false);
  preloader.src = src;
}

export function _showCctvMjpeg(src, cameraId) {
  if (this.destroyed || !this._cctvFrame || !src) return;
  if (
    this._cctvFrame.dataset.cameraId === cameraId &&
    this._cctvFrame.dataset.currentSrc === src
  )
    return;

  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
    this._cctvFramePreloader = null;
  }
  const token = ++this._cctvFrameRequestToken;
  const frame = this._cctvFrame;
  frame.dataset.cameraId = cameraId;
  frame.dataset.currentSrc = src;
  frame.dataset.loading = 'true';
  frame.dataset.error = '';
  frame.classList.remove('active');
  this._cctvFrameWrap?.classList.remove('has-frame');
  this._cctvFrameWrap?.classList.add('loading');
  frame.onload = () => {
    if (this.destroyed || token !== this._cctvFrameRequestToken) return;
    frame.dataset.loading = '';
    frame.dataset.error = '';
    frame.classList.add('active');
    this._cctvFrameWrap?.classList.remove('loading');
    this._cctvFrameWrap?.classList.add('has-frame');
    this._syncCctvSourceBadge(
      this._cctvState?.activeCamera,
      !!this._cctvState?.enabled && !!this.actions.isEnabled(),
    );
  };
  frame.onerror = () => {
    if (this.destroyed || token !== this._cctvFrameRequestToken) return;
    frame.dataset.loading = '';
    frame.dataset.error = 'true';
    this._cctvFrameWrap?.classList.remove('loading');
    this._syncCctvSourceBadge(
      this._cctvState?.activeCamera,
      !!this._cctvState?.enabled && !!this.actions.isEnabled(),
    );
  };
  // Unlike snapshot frames this URL is intentionally stable: replacing it on
  // a timer would tear down and reopen the continuous multipart connection.
  frame.src = src;
}

export function _settleCctvFrame(token, src, ok) {
  if (
    this.destroyed ||
    !this._cctvFrame ||
    token !== this._cctvFrameRequestToken
  )
    return;
  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  this._cctvFramePreloader = null;
  this._cctvFrame.dataset.loading = '';
  this._cctvFrameWrap?.classList.remove('loading');

  const syncBadge = () =>
    this._syncCctvSourceBadge(
      this._cctvState?.activeCamera,
      !!this._cctvState?.enabled && !!this.actions.isEnabled(),
    );

  if (!ok) {
    // Leave the element untouched — a settled frame stays on screen.
    this._cctvFrame.dataset.error = 'true';
    syncBadge();
    return;
  }

  this._cctvFrame.dataset.error = '';
  this._cctvFrame.src = src;
  this._cctvFrame.classList.add('active');
  this._cctvFrameWrap?.classList.add('has-frame');
  syncBadge();
}

export function _syncCctvSourceBadge(activeCamera, enabled) {
  if (!this._cctvSourceBadge) return;
  if (!enabled || !activeCamera) {
    this._cctvSourceBadge.textContent = 'SOURCE · UNKNOWN';
    this._cctvSourceBadge.dataset.frameState = 'idle';
    return;
  }
  if (this._cctvEmbed && !this._cctvEmbed.hidden) {
    this._cctvSourceBadge.textContent = 'LIVE · EMBED';
    this._cctvSourceBadge.dataset.frameState = 'ready';
    return;
  }
  const resolved = this._cctvEmbedCache?.get(activeCamera.id);
  if (activeCamera.feedType === 'external' && !resolved) {
    this._cctvSourceBadge.textContent = 'LIVE · RESOLVING';
    this._cctvSourceBadge.dataset.frameState = 'loading';
    return;
  }
  if (resolved?.kind === 'offline') {
    this._cctvSourceBadge.textContent = 'SOURCE · OFFLINE';
    this._cctvSourceBadge.dataset.frameState = 'error';
    return;
  }
  if (['embed-disabled', 'external-hls', 'external'].includes(resolved?.kind)) {
    this._cctvSourceBadge.textContent = 'LIVE · EXTERNAL';
    this._cctvSourceBadge.dataset.frameState = 'ready';
    return;
  }
  const hasDisplayedFrame =
    this._cctvFrameWrap?.classList.contains('has-frame');
  if (this._cctvFrame?.dataset.loading === 'true' && !hasDisplayedFrame) {
    this._cctvSourceBadge.textContent = 'FRAME · LOADING';
    this._cctvSourceBadge.dataset.frameState = 'loading';
    return;
  }
  if (this._cctvFrame?.dataset.error === 'true' && !hasDisplayedFrame) {
    this._cctvSourceBadge.textContent = 'FRAME · UNAVAILABLE';
    this._cctvSourceBadge.dataset.frameState = 'error';
    return;
  }
  const kind = String(
    activeCamera.sourceKind || activeCamera.feedType || 'unknown',
  ).toUpperCase();
  const status = String(activeCamera.sourceStatus || 'unknown').toUpperCase();
  this._cctvSourceBadge.textContent = `${kind} · ${status}`;
  this._cctvSourceBadge.dataset.frameState = 'ready';
}

function safeEmbedUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

export function _syncCctvEmbed(activeCamera, enabled) {
  if (!this._cctvEmbed) return;
  const cameraId = enabled ? String(activeCamera?.id || '') : '';
  const externalUrl = enabled ? safeEmbedUrl(activeCamera?.externalUrl) : '';
  const cached = cameraId ? this._cctvEmbedCache.get(cameraId) : null;
  if (this._cctvExternalBtn) {
    this._cctvExternalBtn.hidden = !externalUrl;
    this._cctvExternalBtn.dataset.url = externalUrl;
    this._cctvExternalBtn.textContent =
      cached?.kind === 'offline' ? 'OFFLINE · OPEN SOURCE' : 'OPEN LIVE SOURCE';
  }

  const direct = enabled ? safeEmbedUrl(activeCamera?.embedUrl) : '';
  const panelVisible =
    enabled &&
    typeof document !== 'undefined' &&
    !document.hidden &&
    !this._cctvPanel?.classList.contains('collapsed');
  const embedUrl = panelVisible ? direct || safeEmbedUrl(cached?.embedUrl) : '';
  if (embedUrl) {
    if (this._cctvEmbed.dataset.currentSrc !== embedUrl) {
      this._cctvEmbed.src = embedUrl;
      this._cctvEmbed.dataset.currentSrc = embedUrl;
      this._cctvEmbed.dataset.cameraId = cameraId;
    }
    this._cctvEmbed.hidden = false;
    if (this._cctvFrame) this._cctvFrame.hidden = true;
    if (this._cctvVideo) this._cctvVideo.hidden = true;
    this._cctvFrameWrap?.classList.remove('loading');
    this._cctvFrameWrap?.classList.add('has-frame');
    return;
  }

  if (
    !this._cctvEmbed.hidden &&
    (!panelVisible || this._cctvEmbed.dataset.cameraId !== cameraId)
  ) {
    this._cctvEmbed.src = 'about:blank';
    this._cctvEmbed.dataset.currentSrc = '';
    this._cctvEmbed.dataset.cameraId = '';
  }
  this._cctvEmbed.hidden = true;

  const resolveUrl = enabled ? String(activeCamera?.resolveUrl || '') : '';
  if (!cameraId || !resolveUrl || this._cctvEmbedCache.has(cameraId)) return;
  if (this._cctvEmbedResolveId === cameraId) return;
  this._cctvEmbedAbort?.abort();
  const controller = new AbortController();
  this._cctvEmbedAbort = controller;
  this._cctvEmbedResolveId = cameraId;
  fetch(resolveUrl, { cache: 'no-store', signal: controller.signal })
    .then((response) => (response.ok ? response.json() : null))
    .then((result) => {
      if (this.destroyed || controller.signal.aborted) return;
      this._cctvEmbedCache.set(cameraId, result || { kind: 'unreachable' });
      if (this._cctvState?.activeCameraId === cameraId)
        this._renderCctvState(this._cctvState);
    })
    .catch(() => {
      if (!controller.signal.aborted)
        this._cctvEmbedCache.set(cameraId, { kind: 'unreachable' });
    })
    .finally(() => {
      if (this._cctvEmbedResolveId === cameraId) this._cctvEmbedResolveId = '';
    });
}
