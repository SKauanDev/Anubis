import {
  AMERICAS_PUBLIC_WEBCAMS,
  EUROPE_PUBLIC_WEBCAMS,
  NETHERLANDS_PUBLIC_WEBCAMS,
  REST_PUBLIC_WEBCAMS,
} from './osiris-public-webcams.generated.js';
import { ASIA_SKYLINE_CAMERAS } from './osiris-asia-skyline.generated.js';
import {
  AFRICA_SKYLINE_CAMERAS,
  EUROPE_SKYLINE_CAMERAS,
  LATAM_SKYLINE_CAMERAS,
} from './osiris-world-skyline.generated.js';

const ALL_WORLD_WEBCAMS = Object.freeze([
  ...NETHERLANDS_PUBLIC_WEBCAMS,
  ...EUROPE_PUBLIC_WEBCAMS,
  ...AMERICAS_PUBLIC_WEBCAMS,
  ...REST_PUBLIC_WEBCAMS,
  ...ASIA_SKYLINE_CAMERAS,
  ...LATAM_SKYLINE_CAMERAS,
  ...AFRICA_SKYLINE_CAMERAS,
  ...EUROPE_SKYLINE_CAMERAS,
]);

function absolutePreviewUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw, 'http://localhost');
    if (parsed.pathname === '/api/cctv/proxy') {
      const target = parsed.searchParams.get('url') || '';
      const upstream = new URL(target);
      return upstream.protocol === 'https:' ? upstream.toString() : '';
    }
    return parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function safePublicUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

export function osirisWebcamToSource(camera) {
  const id = String(camera?.id || '').trim();
  const lat = Number(camera?.lat);
  const lon = Number(camera?.lng);
  if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const streamUrl = safePublicUrl(camera.stream_url);
  const streamType = String(camera.stream_type || '').toLowerCase();
  const externalUrl = safePublicUrl(camera.external_url);
  const snapshotUrl = absolutePreviewUrl(camera.feed_url);
  const feedType =
    streamUrl && streamType === 'hls'
      ? 'hls'
      : streamUrl && streamType === 'iframe'
        ? 'iframe'
        : externalUrl
          ? 'external'
          : 'image';

  return {
    id,
    name: String(camera.name || id),
    city: String(camera.city || camera.country || 'Global'),
    country: String(camera.country || ''),
    provider: String(camera.source || 'Public Webcam'),
    lat,
    lon,
    headingConfidence: 'low',
    pitchDeg: -12,
    fovDeg: 74,
    rangeM: 500,
    mountHeightM: 18,
    feedType,
    url: feedType === 'hls' ? streamUrl : snapshotUrl,
    snapshotUrl,
    embedUrl: feedType === 'iframe' ? streamUrl : '',
    externalUrl,
    sourceKind: feedType === 'external' ? 'external-live' : 'public-webcam',
    credit: camera.country
      ? `${camera.source || 'Public Webcam'} · ${camera.country}`
      : String(camera.source || 'Public Webcam'),
    license:
      'Public operator broadcast; catalog metadata adapted from OSIRIS (MIT)',
  };
}

export function loadOsirisWorldWebcamSources() {
  const unique = new Map();
  for (const camera of ALL_WORLD_WEBCAMS) {
    const source = osirisWebcamToSource(camera);
    if (source && !unique.has(source.id)) unique.set(source.id, source);
  }
  const result = Array.from(unique.values());
  console.log(`[CCTV] Loaded worldwide public webcams: ${result.length}`);
  return result;
}
