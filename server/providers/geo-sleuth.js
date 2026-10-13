import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES) {
        reject(new Error('Image exceeds the 25 MB limit'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolveProcess) => {
    const { timeoutMs = 180_000, ...spawnOptions } = options;
    const child = spawn(command, args, { ...spawnOptions, shell: false });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProcess(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({
        code: -2,
        stdout,
        stderr: `${stderr}\nProcess timed out after ${Math.round(timeoutMs / 1000)}s`,
      });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ code: -1, stdout, stderr: `${stderr}\n${error.message}` }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });
}

const fetchWithTimeout = (url, options = {}, timeoutMs = 20_000) =>
  fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });

/** Find uv even when the Vite process predates a WinGet PATH update. */
function resolveUvExecutable() {
  const localAppData = process.env.LOCALAPPDATA;
  const userProfile = process.env.USERPROFILE;
  const candidates = [
    process.env.GEO_SLEUTH_UV,
    localAppData && join(localAppData, 'Microsoft', 'WinGet', 'Links', 'uv.exe'),
    userProfile && join(userProfile, '.local', 'bin', 'uv.exe'),
  ].filter(Boolean);
  if (localAppData) {
    const packages = join(localAppData, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const entry of readdirSync(packages)) {
        if (entry.toLowerCase().startsWith('astral-sh.uv_'))
          candidates.push(join(packages, entry, 'uv.exe'));
      }
    } catch {
      // WinGet is optional; fall back to PATH below.
    }
  }
  return candidates.find((candidate) => existsSync(candidate)) || 'uv';
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function parseJsonText(value) {
  const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  return JSON.parse(text);
}

function normalizeAssessment(value) {
  const assessment = value && typeof value === 'object' ? value : {};
  const list = (key) => Array.isArray(assessment[key])
    ? assessment[key].filter((item) => typeof item === 'string' && item.trim())
    : [];
  return {
    conclusion: String(assessment.conclusion || 'A avaliação não produziu uma conclusão verificável.'),
    location: String(assessment.location || 'não determinado'),
    country: String(assessment.country || 'não determinado'),
    region: String(assessment.region || 'não determinado'),
    city: String(assessment.city || 'não determinado'),
    coordinates: String(assessment.coordinates || 'não determinado'),
    confidence: ['high', 'medium', 'low', 'unresolved'].includes(assessment.confidence)
      ? assessment.confidence
      : 'unresolved',
    evidence: list('evidence'),
    alternatives: list('alternatives'),
    missing: list('missing'),
    next_steps: list('next_steps'),
    search_terms: list('search_terms'),
  };
}

async function discoverOsmCandidates(assessment) {
  const area = [assessment.city, assessment.region, assessment.country]
    .filter((value) => value && value !== 'não determinado')
    .join(', ');
  if (!area) return [];
  const terms = assessment.search_terms.slice(0, 2);
  if (!terms.length) terms.push('capela', 'igreja');
  const candidates = [];
  for (const term of terms) {
    try {
      const response = await fetchWithTimeout(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&namedetails=1&q=${encodeURIComponent(`${term}, ${area}`)}`, {
        headers: { 'user-agent': 'GodsEye-GeoSleuth/1.0 (local geolocation tool)' },
      });
      if (!response.ok) continue;
      const rows = await response.json().catch(() => []);
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!row?.lat || !row?.lon || !row.display_name) continue;
        const key = `${Number(row.lat).toFixed(5)},${Number(row.lon).toFixed(5)}`;
        if (!candidates.some((candidate) => candidate.key === key)) {
          candidates.push({
            key,
            name: row.namedetails?.name || row.name || row.display_name.split(',')[0],
            display_name: row.display_name,
            lat: Number(row.lat),
            lon: Number(row.lon),
            type: row.type || row.category || 'place',
          });
        }
      }
    } catch {
      // Candidate discovery is optional; keep the base assessment if OSM is unavailable.
    }
  }
  return candidates.slice(0, 16);
}

function extractOcrClues(report) {
  const match = String(report || '').match(/##\s+OCR text[\s\S]*?(?=^##\s+|$)/im);
  if (!match) return [];
  return match[0]
    .split(/\r?\n/)
    .map((line) => line.replace(/\|/g, ' ').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((line) => line && !/^conf\b|^phone numbers\b|^box\b|^pass\b|^ocr text\b/i.test(line))
    .filter((line) => /[a-zA-ZÀ-ÿ]{3,}/.test(line))
    .slice(0, 12);
}

function brazilPhoneHints(clues) {
  const text = clues.join(' ');
  const numbers = text.match(/(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?9?\d{4}[-.\s]?\d{4}/g) || [];
  const ddds = [...text.matchAll(/(?:\+?55\s*)?\(?([1-9][0-9])\)?/g)].map((match) => match[1]);
  const dddNames = {
    '21': 'Rio de Janeiro e região metropolitana',
    '22': 'interior do Rio de Janeiro, incluindo Nova Friburgo, Região Serrana e Norte Fluminense',
    '24': 'sul/interior do Rio de Janeiro',
    '27': 'Espírito Santo',
    '28': 'sul do Espírito Santo',
  };
  return [
    numbers.length ? `telefones reconhecidos: ${numbers.join(', ')}` : '',
    ...[...new Set(ddds)].filter((ddd) => dddNames[ddd]).map((ddd) => `DDD ${ddd}: ${dddNames[ddd]}`),
  ].filter(Boolean);
}

function applyBrazilTextGuard(assessment, clues, candidates) {
  const text = clues.join(' ');
  const brazilSignal = /\b(?:brasil|brazil|rj|rio de janeiro|cep|ddd)\b|\.com\.br/i.test(text);
  if (!brazilSignal) return assessment;
  const country = String(assessment.country || '').toLowerCase();
  if (!country || /brasil|brazil/.test(country)) return assessment;
  const best = candidates[0];
  return {
    ...assessment,
    location: best?.name || 'localidade brasileira não determinada',
    country: 'Brasil',
    region: /\brj\b|rio de janeiro/i.test(text) ? 'Rio de Janeiro' : assessment.region,
    city: best?.display_name?.split(',').slice(-3, -2)[0]?.trim() || 'não determinado',
    coordinates: best ? `${best.lat}, ${best.lon} (candidato OCR; confirmar)` : 'não determinado',
    confidence: best ? 'low' : 'unresolved',
    evidence: [...assessment.evidence, 'A localidade estrangeira foi rejeitada: o OCR contém sinais de contexto brasileiro.'],
    alternatives: [assessment.location, ...assessment.alternatives].filter(Boolean),
  };
}

async function discoverBrazilianOcrCandidates(report) {
  const clues = extractOcrClues(report);
  if (!clues.length) return [];
  const query = clues.join(', ').slice(0, 220);
  try {
    const response = await fetchWithTimeout(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&countrycodes=br&namedetails=1&q=${encodeURIComponent(query)}`,
      { headers: { 'user-agent': 'GodsEye-GeoSleuth/1.0 (local geolocation tool)' } },
      20_000,
    );
    if (!response.ok) return [];
    const rows = await response.json().catch(() => []);
    return (Array.isArray(rows) ? rows : [])
      .filter((row) => row?.lat && row?.lon && row?.display_name)
      .slice(0, 8)
      .map((row) => ({
        key: `${Number(row.lat).toFixed(5)},${Number(row.lon).toFixed(5)}`,
        name: row.namedetails?.name || row.name || row.display_name.split(',')[0],
        display_name: row.display_name,
        lat: Number(row.lat),
        lon: Number(row.lon),
        type: row.type || row.category || 'place',
      }));
  } catch {
    return [];
  }
}

async function geocodeAssessment(assessment) {
  if (assessment.coordinates !== 'não determinado') return assessment;
  const query = [assessment.location, assessment.city, assessment.region, assessment.country]
    .filter((value) => value && value !== 'não determinado')
    .join(', ');
  if (!query) return assessment;
  try {
    const response = await fetchWithTimeout(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`, {
      headers: { 'user-agent': 'GodsEye-GeoSleuth/1.0 (local geolocation tool)' },
    });
    if (!response.ok) return assessment;
    const places = await response.json().catch(() => []);
    const place = Array.isArray(places) ? places[0] : null;
    if (!place?.lat || !place?.lon) return assessment;
    return {
      ...assessment,
      coordinates: `${place.lat}, ${place.lon} (centro aproximado; confirmar no board)`,
      evidence: [...assessment.evidence, `Coordenadas aproximadas obtidas por geocodificação de: ${place.display_name || query}`],
    };
  } catch {
    return assessment;
  }
}

const GEO_SLEUTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    conclusion: { type: 'string' },
    location: { type: 'string' },
    country: { type: 'string' },
    region: { type: 'string' },
    city: { type: 'string' },
    coordinates: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low', 'unresolved'] },
    evidence: { type: 'array', items: { type: 'string' } },
    alternatives: { type: 'array', items: { type: 'string' } },
    missing: { type: 'array', items: { type: 'string' } },
    next_steps: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'conclusion', 'location', 'country', 'region', 'city', 'coordinates',
    'confidence', 'evidence', 'alternatives', 'missing', 'next_steps',
  ],
};

function extractGeminiText(data) {
  return data?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text || '')
    .join('')
    .trim() || '';
}

async function assessWithVision({ apiKey, model, photoBytes, contentType, report, candidateContext = '', geographicPrior = '' }) {
  if (!apiKey) {
    return { error: 'Configure GEMINI_API_KEY para executar a etapa de localização do Geo-Sleuth.' };
  }
  const textualPriority = geographicPrior
    ? `\nPRIORIDADE GEOGRÃFICA EXTRAÃDA DO OCR:\n${geographicPrior}\nNÃ£o contradiga essa prioridade por causa de resultados visuais estrangeiros.\n`
    : '';
  const prompt = `Você é a etapa de julgamento geográfico do projeto geo-sleuth.
Analise a foto fornecida junto com o relatório do intake. O objetivo principal é localizar onde a foto foi tirada, não descrever genericamente o que aparece.
Compare a imagem com os resultados da busca reversa. Leia títulos, URLs e nomes próprios do relatório: quando um resultado descreve o mesmo objeto/cenário e contém uma localidade, essa localidade deve ser o candidato principal. Não descarte um candidato apenas porque o intake não contou votos de cidade.
EVIDÊNCIA TEXTUAL TEM PRIORIDADE ABSOLUTA: texto de endereço, telefone, CEP, DDD, placa, nome comercial, cidade, estado e país visível na foto/OCR vale mais que qualquer imagem parecida. Resultados reversos estrangeiros só valem quando texto, objeto e localidade coincidirem. Nunca conclua Indonésia ou outro país apenas porque uma imagem parecida veio desse lugar.
Retorne a melhor localidade candidata mesmo com confidence=low quando houver uma correspondência plausível; use confidence=unresolved somente se o relatório não tiver nenhuma localidade candidata. Não invente coordenadas: deixe coordinates="não determinado" quando elas não estiverem sustentadas. O servidor tentará geocodificar a localidade candidata e marcará o ponto como aproximado.
Faça a decisão em ordem: (1) correspondência do mesmo objeto ou cenário em título/link da busca reversa; (2) nome próprio, OCR e país; (3) arquitetura e contexto. Não escolha uma cidade famosa apenas por semelhança temática. Se houver um título com o nome de um local e a imagem parecer o mesmo objeto, use esse local como candidato principal.
Liste evidências de correspondência visual, alternativas e os próximos testes necessários. A conclusão precisa começar pelo local candidato, não por uma descrição da imagem.

${textualPriority}RELATÓRIO DO INTAKE:
${candidateContext ? `CANDIDATOS REAIS ENCONTRADOS NO OPENSTREETMAP:
${candidateContext}
Compare a foto com esses candidatos. Escolha um deles somente se houver coerÃªncia com o nome, tipo, localidade e contexto da imagem. NÃ£o invente um candidato fora da lista; se nenhum for compatÃ­vel, mantenha unresolved.

` : ''}${String(report || '').slice(0, 40000)}`;
  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { inline_data: { mime_type: contentType, data: photoBytes.toString('base64') } },
            { text: prompt },
          ],
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0,
          candidateCount: 1,
          maxOutputTokens: 1400,
        },
      }),
    }, 90_000);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = String(data?.error?.message || data?.error?.status || `HTTP ${response.status}`)
        .replace(/\s+/g, ' ')
        .slice(0, 300);
      return { error: `Gemini recusou a avaliação (${response.status}): ${detail}` };
    }
    if (!extractGeminiText(data)) {
      return { error: 'Gemini não retornou uma resposta textual. Tente novamente ou troque o modelo.' };
    }
    if (!response.ok) return { error: 'A avaliação multimodal do Gemini falhou. Verifique a chave e os limites da conta.' };
    const assessment = normalizeAssessment(parseJsonText(extractGeminiText(data)));
    return { assessment };
  } catch {
    return { error: 'Não foi possível concluir a avaliação multimodal do Geo-Sleuth.' };
  }
}

function assessmentMarkdown(assessment) {
  const lines = [
    '',
    '## Avaliação geográfica',
    `- **Conclusão:** ${assessment.conclusion}`,
    `- **Localidade candidata:** ${assessment.location}`,
    `- **País/região/cidade:** ${assessment.country} / ${assessment.region} / ${assessment.city}`,
    `- **Coordenadas:** ${assessment.coordinates}`,
    `- **Confiança:** ${assessment.confidence}`,
    '',
    '**Evidências:**',
    ...(assessment.evidence.length ? assessment.evidence.map((item) => `- ${item}`) : ['- Nenhuma evidência suficiente.']),
    '',
    '**Alternativas:**',
    ...(assessment.alternatives.length ? assessment.alternatives.map((item) => `- ${item}`) : ['- Nenhuma alternativa registrada.']),
    '',
    '**Lacunas e próximos passos:**',
    ...[...assessment.missing, ...assessment.next_steps].map((item) => `- ${item}`),
    '',
    '> Esta é uma avaliação de candidatos baseada na foto e no intake; só deve ser tratada como confirmada quando houver evidência independente no board.',
  ];
  return lines.join('\n');
}

function visibleReport(report) {
  const lines = String(report || '').split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (/^##\s+Status\b/i.test(line) || /^##\s+Avalia/i.test(line)) {
      if (current?.length) sections.push(current.join('\n').trim());
      current = [line];
      continue;
    }
    if (/^##\s+/.test(line)) {
      if (current?.length) sections.push(current.join('\n').trim());
      current = null;
      continue;
    }
    if (current) current.push(line);
  }
  if (current?.length) sections.push(current.join('\n').trim());
  return sections.filter(Boolean).join('\n\n');
}

/** Optional local bridge for Oldcircle/geo-sleuth's intake pipeline. */
export function geoSleuthProxy({ skillDir = process.env.GEO_SLEUTH_DIR } = {}) {
  return {
    name: 'geo-sleuth-proxy',
    configureServer(server) {
      server.middlewares.use('/api/geo-sleuth/intake', async (req, res, next) => {
        if (req.method !== 'POST') return next();
        const root = skillDir ? resolve(skillDir) : null;
        const intake = root && join(root, 'scripts', 'intake.py');
        const board = root && join(root, 'scripts', 'board.py');
        if (!intake || !board || !existsSync(intake) || !existsSync(board)) {
          return json(res, 503, { error: 'geo-sleuth não configurado. Defina GEO_SLEUTH_DIR apontando para skills/geo-sleuth.' });
        }
        try {
          const body = await readBody(req);
          const runId = randomUUID();
          const runDir = resolve(process.cwd(), '.geo-sleuth-runs', runId);
          await mkdir(runDir, { recursive: true });
          const filename = basename(req.headers['x-geo-sleuth-filename'] || 'photo.jpg').replace(/[^a-z0-9._-]/gi, '_');
          const photo = join(runDir, filename || 'photo.jpg');
          await writeFile(photo, body);
          // Two reverse-search variants preserve the useful crop/contrast
          // evidence while keeping the OCR + search pipeline responsive.
          const args = ['run', intake, photo, '--out-dir', runDir, '--max-variants', '2'];
          if (req.headers['x-geo-sleuth-reverse'] !== 'true') args.push('--no-rev');
          const result = await runProcess(resolveUvExecutable(), args, { cwd: root, timeoutMs: 210_000 });
          const reportPath = join(runDir, 'intake.md');
          let report = existsSync(reportPath) ? await readFile(reportPath, 'utf8') : `${result.stdout}\n${result.stderr}`.trim();
          if (result.code !== 0) {
            return json(res, 502, {
              error: report || 'geo-sleuth intake failed',
              runId,
              report: visibleReport(report) || report || 'O intake não produziu relatório antes do timeout.',
            });
          }
          const boardResult = await runProcess(resolveUvExecutable(), ['run', board, 'init', '--photo', filename], { cwd: runDir, timeoutMs: 30_000 });
          if (boardResult.code !== 0) {
            return json(res, 502, { error: 'O intake terminou, mas o candidate board não pôde ser inicializado.', runId, report });
          }
          const contentType = /^(image\/(jpeg|png|webp|gif))$/i.test(String(req.headers['content-type'] || ''))
            ? String(req.headers['content-type']).split(';')[0]
            : 'image/jpeg';
          const ocrClues = extractOcrClues(report);
          const phoneHints = brazilPhoneHints(ocrClues);
          const ocrCandidates = await discoverBrazilianOcrCandidates(report);
          const ocrCandidateContext = ocrCandidates
            .map((candidate, index) => `${index + 1}. ${candidate.name} — ${candidate.display_name} — ${candidate.lat}, ${candidate.lon} — ${candidate.type}`)
            .join('\n');
          const vision = await assessWithVision({
            apiKey: process.env.GEMINI_API_KEY?.trim(),
            model: process.env.GEMINI_GEO_SLEUTH_MODEL || 'gemini-3.5-flash-lite',
            photoBytes: body,
            contentType,
            report,
            candidateContext: ocrCandidateContext,
            geographicPrior: [...ocrClues, ...phoneHints].join(' | '),
          });
          if (vision.error) return json(res, 503, { error: vision.error, runId, report: visibleReport(report) });
          let assessment = vision.assessment;
          const candidates = [...ocrCandidates, ...(await discoverOsmCandidates(assessment))]
            .filter((candidate, index, all) => all.findIndex((item) => item.key === candidate.key) === index)
            .slice(0, 16);
          if (candidates.length) {
            const candidateContext = candidates
              .map((candidate, index) => `${index + 1}. ${candidate.name} — ${candidate.display_name} — ${candidate.lat}, ${candidate.lon} — ${candidate.type}`)
              .join('\n');
            const boardCandidates = Object.fromEntries(candidates.map((candidate) => [
              `${candidate.name} (${candidate.lat}, ${candidate.lon})`,
              [candidate.lat, candidate.lon],
            ]));
            await writeFile(join(runDir, 'osm-candidates.json'), JSON.stringify(boardCandidates, null, 2), 'utf8');
            await runProcess(resolveUvExecutable(), ['run', board, 'add', '--from', 'osm-candidates.json', '--level', 'point'], { cwd: runDir, timeoutMs: 30_000 });
            const verified = await assessWithVision({
              apiKey: process.env.GEMINI_API_KEY?.trim(),
              model: process.env.GEMINI_GEO_SLEUTH_MODEL || 'gemini-3.5-flash-lite',
              photoBytes: body,
              contentType,
              report,
              candidateContext,
              geographicPrior: [...ocrClues, ...phoneHints].join(' | '),
            });
            if (!verified.error) assessment = verified.assessment;
            assessment.evidence = [...assessment.evidence, `Candidatos OSM comparados: ${candidates.length}`];
          }
          assessment = applyBrazilTextGuard(assessment, [...ocrClues, ...phoneHints], ocrCandidates);
          assessment = await geocodeAssessment(assessment);
          await writeFile(join(runDir, 'assessment.json'), JSON.stringify(assessment, null, 2), 'utf8');
          report += assessmentMarkdown(assessment);
          await writeFile(join(runDir, 'report.md'), report, 'utf8');
          return json(res, 200, { ok: true, runId, report: visibleReport(report), assessment });
        } catch (error) {
          return json(res, 500, { error: error?.message || 'geo-sleuth request failed' });
        }
      });
    },
  };
}
