/** Read the bounded, normalized incident snapshot exposed by the local server. */
export function createIncidentSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoint = '/api/incidents',
} = {}) {
  return Object.freeze({
    async getSnapshot({ signal, mode = 'events' } = {}) {
      signal?.throwIfAborted();
      const query = new URLSearchParams({ mode });
      const response = await fetchImpl(`${endpoint}?${query}`, {
        signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok)
        throw new Error(`Incident service unavailable (${response.status})`);
      const payload = await response.json();
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.incidents))
        throw new Error('Malformed incident response');
      return Object.freeze({
        fetchedAt: Number(payload.fetchedAt) || Date.now(),
        incidents: Object.freeze(payload.incidents),
        providers: Object.freeze(payload.providers || {}),
        stale: payload.stale === true,
      });
    },
  });
}
