const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
const SUPPORTED_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
// Windows/Chromium can expose a normal JPEG as `.jfif` with a non-standard
// MIME type. Treat it as JPEG instead of leaving the action disabled.
const SUPPORTED_PHOTO_EXTENSIONS = /\.(jpe?g|jfif|png|webp)$/i;

/** Wire the optional geo-sleuth Agent Skill into the ANUBIS panel. */
export function initGeoSleuthPanel({ documentRef = globalThis.document, fetchFn = globalThis.fetch } = {}) {
  const panel = documentRef?.getElementById('geo-sleuth-panel');
  const collapseButton = panel?.querySelector('.panel-collapse-btn');
  const input = documentRef?.getElementById('geo-sleuth-photo');
  const dropzone = documentRef?.getElementById('geo-sleuth-dropzone');
  const runButton = documentRef?.getElementById('geo-sleuth-run');
  const label = documentRef?.getElementById('geo-sleuth-file-label');
  const preview = documentRef?.getElementById('geo-sleuth-preview');
  const status = documentRef?.getElementById('geo-sleuth-status');
  const dialog = documentRef?.getElementById('geo-sleuth-dialog');
  const dialogClose = documentRef?.getElementById('geo-sleuth-dialog-close');
  const dialogStatus = documentRef?.getElementById('geo-sleuth-dialog-status');
  const report = documentRef?.getElementById('geo-sleuth-report');
  const reverse = documentRef?.getElementById('geo-sleuth-reverse');
  if (!input || !runButton || !status) {
    // The standalone chrome can inject context.html after the scene tools are
    // created. Wait for that late mount instead of silently losing the file
    // input listeners.
    const root = documentRef?.documentElement;
    const observer = root && typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => {
          if (
            documentRef.getElementById('geo-sleuth-photo') &&
            documentRef.getElementById('geo-sleuth-run') &&
            documentRef.getElementById('geo-sleuth-status')
          ) {
            observer.disconnect();
          }
        })
      : null;
    const retryWindow = documentRef?.defaultView;
    const retry = retryWindow?.setInterval(() => {
      if (
        documentRef.getElementById('geo-sleuth-photo') &&
        documentRef.getElementById('geo-sleuth-run') &&
        documentRef.getElementById('geo-sleuth-status')
      ) {
        retryWindow.clearInterval(retry);
        observer?.disconnect();
        initGeoSleuthPanel({ documentRef, fetchFn });
      }
    }, 250);
    observer?.observe(root, { childList: true, subtree: true });
    return {
      destroy: () => {
        observer?.disconnect();
        if (retry) retryWindow.clearInterval(retry);
      },
    };
  }

  let selectedFile = null;
  let previewUrl = null;
  let disposed = false;
  const syncDisclosure = () => {
    if (!panel || !collapseButton) return;
    const collapsed = panel.classList.contains('collapsed');
    collapseButton.textContent = collapsed ? '◀' : '▶';
    collapseButton.setAttribute('aria-expanded', String(!collapsed));
    collapseButton.setAttribute('title', collapsed ? 'Expand panel' : 'Collapse panel');
  };
  const onCollapseClick = (event) => {
    // This panel can be mounted after the shared panel chrome is initialized.
    // Own the event so a late/duplicate disclosure cannot toggle it twice.
    event.preventDefault();
    event.stopImmediatePropagation();
    panel.classList.toggle('collapsed');
    syncDisclosure();
    documentRef.defaultView?.dispatchEvent(new Event('resize'));
  };
  collapseButton?.addEventListener('click', onCollapseClick, true);
  syncDisclosure();
  const closeDialog = () => dialog?.close();
  const setStatus = (message, tone = '') => {
    for (const node of [status, dialogStatus]) {
      if (!node) continue;
      node.textContent = message;
      node.dataset.tone = tone;
    }
  };
  const onFile = () => {
    const candidate = input.files?.[0] || null;
    const supported = candidate && (
      SUPPORTED_PHOTO_TYPES.has(candidate.type) ||
      SUPPORTED_PHOTO_EXTENSIONS.test(candidate.name || '')
    );
    selectedFile = supported ? candidate : null;
    runButton.disabled = !selectedFile;
    if (candidate && !supported) {
      input.value = '';
      label.textContent = 'FORMATO NÃO SUPORTADO';
      setStatus('Use somente JPG, PNG ou WEBP.', 'error');
      if (preview) {
        preview.removeAttribute('src');
        preview.hidden = true;
      }
      return;
    }
    if (!selectedFile) {
      label.textContent = 'SELECIONAR FOTO';
      return;
    }
    label.textContent = selectedFile.name;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(selectedFile);
    if (preview) {
      preview.src = previewUrl;
      preview.hidden = false;
    }
    setStatus(`${Math.ceil(selectedFile.size / 1024)} KB pronto para análise.`);
    if (report) report.hidden = true;
  };
  const openFilePicker = (event) => {
    if (event.target === input) return;
    event.preventDefault();
    event.stopPropagation();
    input.value = '';
    input.click();
  };
  const onDropzoneKeydown = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    input.value = '';
    input.click();
  };
  const stopInputClick = (event) => event.stopPropagation();
  const onRun = async () => {
    // Some browsers update `files` just before dispatching their change event.
    if (!selectedFile && input.files?.[0]) onFile();
    if (!selectedFile || selectedFile.size > MAX_PHOTO_BYTES || disposed) {
      if (selectedFile?.size > MAX_PHOTO_BYTES) setStatus('A foto excede o limite de 25 MB.', 'error');
      return;
    }
    runButton.disabled = true;
    if (dialog?.showModal) dialog.showModal();
    setStatus('Executando intake.py · isso pode levar alguns minutos…', 'busy');
    const requestController = typeof AbortController !== 'undefined'
      ? new AbortController()
      : null;
    const requestTimeout = setTimeout(() => requestController?.abort(), 360_000);
    try {
      const response = await fetchFn('/api/geo-sleuth/intake', {
        method: 'POST',
        headers: {
          'content-type': selectedFile.type || 'application/octet-stream',
          'x-geo-sleuth-filename': selectedFile.name,
          'x-geo-sleuth-reverse': reverse?.checked ? 'true' : 'false',
        },
        body: selectedFile,
        signal: requestController?.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (report) {
        report.textContent = payload.report || 'Relatório não retornado.';
        report.hidden = false;
      }
      if (!response.ok) throw new Error(payload.error || `Falha HTTP ${response.status}`);
      setStatus(`Análise concluída · ${payload.runId || 'resultado disponível'}.`, 'success');
    } catch (error) {
      setStatus(
        error?.name === 'AbortError'
          ? 'A análise excedeu o limite de 6 minutos. Verifique a conexão e tente novamente.'
          : error?.message || 'Não foi possível executar o geo-sleuth.',
        'error',
      );
    } finally {
      clearTimeout(requestTimeout);
      if (!disposed) runButton.disabled = !selectedFile;
    }
  };
  input.addEventListener('change', onFile);
  input.addEventListener('input', onFile);
  input.addEventListener('click', stopInputClick);
  dropzone?.addEventListener('click', openFilePicker);
  dropzone?.addEventListener('keydown', onDropzoneKeydown);
  runButton.addEventListener('click', onRun);
  dialogClose?.addEventListener('click', closeDialog);
  dialog?.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  return {
    destroy() {
      disposed = true;
      input.removeEventListener('change', onFile);
      input.removeEventListener('input', onFile);
      input.removeEventListener('click', stopInputClick);
      collapseButton?.removeEventListener('click', onCollapseClick, true);
      dropzone?.removeEventListener('click', openFilePicker);
      dropzone?.removeEventListener('keydown', onDropzoneKeydown);
      runButton.removeEventListener('click', onRun);
      dialogClose?.removeEventListener('click', closeDialog);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
  };
}
