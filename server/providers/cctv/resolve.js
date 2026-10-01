const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const RESOLVE_MAX_BYTES = 3 * 1024 * 1024;
const RESOLVE_TIMEOUT_MS = 10_000;
const CACHE_MAX = 1_000;
const cache = new Map();

function hostnameMatches(hostname, expected) {
  const host = String(hostname || '').toLowerCase();
  return host === expected || host.endsWith(`.${expected}`);
}

export function youtubeEmbedUrl(videoId) {
  if (!YOUTUBE_ID.test(String(videoId || ''))) return '';
  const params = new URLSearchParams({
    autoplay: '1',
    mute: '1',
    playsinline: '1',
    rel: '0',
    modestbranding: '1',
    iv_load_policy: '3',
  });
  return `https://www.youtube-nocookie.com/embed/${videoId}?${params}`;
}

export function parseYouTubeTarget(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    return null;
  }
  if (
    !hostnameMatches(url.hostname, 'youtube.com') &&
    !hostnameMatches(url.hostname, 'youtube-nocookie.com') &&
    !hostnameMatches(url.hostname, 'youtu.be')
  )
    return null;
  const segments = url.pathname.split('/').filter(Boolean);
  const queryId = url.searchParams.get('v');
  if (queryId && YOUTUBE_ID.test(queryId))
    return { kind: 'video', videoId: queryId };
  if (
    hostnameMatches(url.hostname, 'youtu.be') &&
    YOUTUBE_ID.test(segments[0] || '')
  )
    return { kind: 'video', videoId: segments[0] };
  if (
    segments.length >= 2 &&
    ['embed', 'v', 'live', 'shorts'].includes(segments[0]) &&
    YOUTUBE_ID.test(segments[1])
  )
    return { kind: 'video', videoId: segments[1] };
  if (segments.length >= 2 && segments.at(-1) === 'live')
    return { kind: 'live-channel' };
  return null;
}

export function extractYouTubeId(html) {
  const patterns = [
    /videoId\s*:\s*['"]([^'"]+)['"]/,
    /"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/,
    /rel=["']canonical["']\s+href=["'][^"']*[?&]v=([A-Za-z0-9_-]{11})/,
    /youtube(?:-nocookie)?\.com\/embed\/([A-Za-z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const id = String(html || '').match(pattern)?.[1];
    if (id && YOUTUBE_ID.test(id)) return id;
  }
  return null;
}

export function extractYouTubeLiveState(html) {
  const text = String(html || '');
  const detail = text.match(
    /"videoDetails":\{"videoId":"([A-Za-z0-9_-]{11})"[\s\S]{0,4000}?"isLive":true/,
  );
  if (!detail || !/"isLiveNow":true/.test(text))
    return { live: false, embeddable: false, videoId: '' };
  const statusStart = text.indexOf('"playabilityStatus"');
  const detailsStart = text.indexOf('"videoDetails"');
  const status =
    statusStart >= 0 && detailsStart > statusStart
      ? text.slice(statusStart, detailsStart)
      : '';
  return {
    live: true,
    embeddable: /"playableInEmbed":true/.test(status),
    videoId: detail[1],
  };
}

async function readHtmlCapped(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > RESOLVE_MAX_BYTES)
    throw new Error('resolver page too large');
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RESOLVE_MAX_BYTES) {
      await reader.cancel();
      throw new Error('resolver page too large');
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function cacheTtl(result) {
  if (result.embeddable) return 30 * 60_000;
  return result.kind === 'unreachable' ? 30_000 : 5 * 60_000;
}

function remember(key, result) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), ttl: cacheTtl(result), result });
  return result;
}

export async function resolvePublicWebcam(source, { fetchImpl = fetch } = {}) {
  const direct = String(source?.embedUrl || '');
  if (direct) return { embeddable: true, kind: 'iframe', embedUrl: direct };
  const externalUrl = String(source?.externalUrl || '');
  if (!externalUrl) return { embeddable: false, kind: 'missing' };

  const hit = cache.get(externalUrl);
  if (hit && Date.now() - hit.at <= hit.ttl) return hit.result;
  if (hit) cache.delete(externalUrl);

  let parsed;
  try {
    parsed = new URL(externalUrl);
  } catch {
    return { embeddable: false, kind: 'unknown' };
  }
  const youtube = parseYouTubeTarget(externalUrl);
  if (youtube?.kind === 'video') {
    return remember(externalUrl, {
      embeddable: true,
      kind: 'youtube',
      embedUrl: youtubeEmbedUrl(youtube.videoId),
    });
  }
  const isSkyline = hostnameMatches(parsed.hostname, 'skylinewebcams.com');
  if (!isSkyline && youtube?.kind !== 'live-channel')
    return remember(externalUrl, { embeddable: false, kind: 'external' });

  try {
    const response = await fetchImpl(externalUrl, {
      redirect: 'error',
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; GodsEye/1.0; public-webcam-resolver)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (response.status === 404 || response.status === 410)
      return remember(externalUrl, { embeddable: false, kind: 'missing' });
    if (!response.ok)
      return remember(externalUrl, { embeddable: false, kind: 'unreachable' });
    const html = await readHtmlCapped(response);
    if (youtube?.kind === 'live-channel') {
      const live = extractYouTubeLiveState(html);
      if (!live.live)
        return remember(externalUrl, {
          embeddable: false,
          kind: 'offline',
        });
      if (!live.embeddable)
        return remember(externalUrl, {
          embeddable: false,
          kind: 'embed-disabled',
        });
      return remember(externalUrl, {
        embeddable: true,
        kind: 'youtube',
        embedUrl: youtubeEmbedUrl(live.videoId),
      });
    }
    const videoId = extractYouTubeId(html);
    if (videoId)
      return remember(externalUrl, {
        embeddable: true,
        kind: 'youtube',
        embedUrl: youtubeEmbedUrl(videoId),
      });
    if (isSkyline && /<strong>\s*OFFLINE\s*<\/strong>/i.test(html))
      return remember(externalUrl, { embeddable: false, kind: 'offline' });
    if (isSkyline && /\.m3u8/i.test(html))
      return remember(externalUrl, { embeddable: false, kind: 'external-hls' });
    return remember(externalUrl, { embeddable: false, kind: 'unknown' });
  } catch {
    return remember(externalUrl, { embeddable: false, kind: 'unreachable' });
  }
}
