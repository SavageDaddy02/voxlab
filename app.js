/* ============================================================
   VOXLAB — Fábrica de Documentários estilo Vox
   100% no navegador: Gemini (roteiro/imagens/voz) + Wikimedia
   + motor de animação em Canvas + exportação de vídeo.
   ============================================================ */
'use strict';

/* ---------- Config ---------- */
const PAL = {
  paper: '#F4EEE1', paper2: '#E9E0CC', yellow: '#FFD100', navy: '#12294B',
  coral: '#FF5A45', red: '#A6242B', ink: '#14181F', white: '#FFFFFF'
};
const FIELD_BG = { yellow: PAL.yellow, paper: PAL.paper, navy: PAL.navy, coral: PAL.coral, red: PAL.red };
const FIELD_FG = { yellow: PAL.ink, paper: PAL.ink, navy: PAL.paper, coral: PAL.paper, red: PAL.paper };
const GEM = 'https://generativelanguage.googleapis.com/v1beta/models/';
const LS = 'voxlab_settings_v1';

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let settings = { key: '' };
try { Object.assign(settings, JSON.parse(localStorage.getItem(LS) || '{}')); } catch {}

let busy = false;
let lastProject = null;

/* ---------- UI helpers ---------- */
let toastTimer = null;
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
function setPhase(name) {
  document.querySelectorAll('.phase').forEach(el => {
    const ph = el.dataset.phase;
    el.classList.remove('active');
    if (ph === name) el.classList.add('active');
  });
}
function donePhase(name) {
  const el = document.querySelector(`.phase[data-phase="${name}"]`);
  if (el) { el.classList.remove('active'); el.classList.add('done'); }
}
function resetPhases() {
  document.querySelectorAll('.phase').forEach(el => el.classList.remove('active', 'done'));
}
function setProgress(pct, msg) {
  if (pct != null) $('#progressFill').style.width = Math.min(100, pct) + '%';
  if (msg) $('#progressMsg').textContent = msg;
}

/* ---------- Gemini API ---------- */
// Cadeia de fallback: contas novas do Google não têm acesso aos modelos antigos
// (e vice-versa). Tentamos do mais novo ao mais antigo e memorizamos o que funcionou.
const MODEL_CHAIN = {
  text: ['gemini-flash-latest', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  tts: ['gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts'],
  image: ['gemini-3.1-flash-image', 'gemini-2.5-flash-image', 'nano-banana-pro-preview']
};
const modelCache = {};
async function gemCall(kind, body) {
  const chain = modelCache[kind] ? [modelCache[kind], ...MODEL_CHAIN[kind].filter(m => m !== modelCache[kind])] : MODEL_CHAIN[kind];
  let lastErr;
  for (const m of chain) {
    try {
      const r = await gemFetch(m, body);
      modelCache[kind] = m;
      return r;
    } catch (e) {
      lastErr = e;
      if (e.status === 404 || e.status === 403) continue; // modelo indisponível p/ esta conta
      throw e;
    }
  }
  throw lastErr;
}

async function gemFetch(model, body) {
  const res = await fetch(GEM + model + ':generateContent?key=' + encodeURIComponent(settings.key), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const err = new Error('Gemini ' + res.status + ': ' + txt.slice(0, 300));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function gemText(prompt, { json = false, search = false, retries = 1 } = {}) {
  const body = { contents: [{ parts: [{ text: prompt }] }] };
  if (search) body.tools = [{ google_search: {} }];
  if (json) body.generationConfig = { responseMimeType: 'application/json' };
  for (let i = 0; ; i++) {
    try {
      const data = await gemCall('text', body);
      const parts = data.candidates?.[0]?.content?.parts || [];
      return parts.map(p => p.text || '').join('');
    } catch (e) {
      if (e.status === 429 && i < retries) { await sleep(15000); continue; }
      throw e;
    }
  }
}

async function gemTTS(text, voice) {
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
    }
  };
  const data = await gemCall('tts', body);
  const part = (data.candidates?.[0]?.content?.parts || []).find(p => p.inlineData);
  if (!part) throw new Error('TTS sem áudio');
  const mime = part.inlineData.mimeType || 'audio/L16;rate=24000';
  const m = mime.match(/rate=(\d+)/);
  return { bytes: b64ToBytes(part.inlineData.data), rate: m ? +m[1] : 24000 };
}

async function gemImage(prompt) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { imageConfig: { aspectRatio: '4:3' } }
  };
  const data = await gemCall('image', body);
  const part = (data.candidates?.[0]?.content?.parts || []).find(p => p.inlineData);
  if (!part) throw new Error('sem imagem');
  return 'data:' + part.inlineData.mimeType + ';base64,' + part.inlineData.data;
}

// ElevenLabs como voz reserva (free tier próprio, independente do Gemini)
async function elevenTTS(text) {
  const voiceId = 'onwK4e9ZLuTAKqWW03F9'; // Daniel — grave, tom documentário
  const res = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voiceId + '?output_format=mp3_44100_128', {
    method: 'POST',
    headers: { 'xi-api-key': settings.elKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' })
  });
  if (!res.ok) { const e = new Error('ElevenLabs ' + res.status); e.status = res.status; throw e; }
  return res.arrayBuffer();
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function pcmToAudioBuffer(ctx, bytes, rate) {
  const n = Math.floor(bytes.length / 2);
  const buf = ctx.createBuffer(1, n, rate);
  const ch = buf.getChannelData(0);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < n; i++) ch[i] = dv.getInt16(i * 2, true) / 32768;
  return buf;
}

/* ---------- Wikimedia Commons ---------- */
async function wikiImage(query) {
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search' +
    '&gsrsearch=' + encodeURIComponent(query) + '&gsrnamespace=6&gsrlimit=8' +
    '&prop=imageinfo&iiprop=url|mime&iiurlwidth=1024&format=json&origin=*';
  const res = await fetch(url);
  if (!res.ok) throw new Error('wiki ' + res.status);
  const data = await res.json();
  const pages = Object.values(data.query?.pages || {});
  const ok = pages
    .map(p => p.imageinfo?.[0])
    .filter(ii => ii && /image\/(jpeg|png)/.test(ii.mime || ''));
  if (!ok.length) throw new Error('sem resultados');
  return ok[0].thumburl || ok[0].url;
}

function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const to = setTimeout(() => reject(new Error('timeout img')), 20000);
    img.onload = () => { clearTimeout(to); resolve(img); };
    img.onerror = () => { clearTimeout(to); reject(new Error('erro img')); };
    img.src = src;
  });
}

/* ---------- Roteiro ---------- */
function blockCount(sec) { return sec <= 30 ? 4 : sec <= 60 ? 7 : 10; }

async function makeScript(topic, seconds, research) {
  const n = blockCount(seconds);
  const prompt = `Você é roteirista sênior de documentários no estilo Vox (colagem editorial).
Crie o roteiro de um vídeo de ~${seconds} segundos sobre: "${topic}".

${research ? 'PESQUISA VERIFICADA (use estes fatos):\n' + research.slice(0, 6000) + '\n' : ''}
REGRAS DO ROTEIRO (fórmula Vox):
- Exatamente ${n} blocos. Cada bloco = 1 cena de ~8s com narração de 18 a 26 palavras em português do Brasil.
- Bloco 1: cold open — o fato/pergunta mais surpreendente, direto, sem saudação.
- Bloco 2: por que isso importa (stakes).
- Blocos do meio: evidências — 1 ideia por bloco, sempre com número, data, lugar ou comparação concreta.
- Penúltimo bloco: a virada contraintuitiva ("mas eis a questão...").
- Último bloco: resposta + kicker que reenquadra o bloco 1.
- Tom: curioso, preciso, frases curtas declarativas. Números por extenso na narração.

CENAS — para cada bloco escolha UM type:
- "photo": foto de arquivo (use para pessoas, lugares, eventos, objetos reais)
- "headline": tipografia grande (use para perguntas, viradas, frases de impacto)
- "chart": gráfico de barras (use quando houver comparação numérica real)
- "route": mapa de rota A→B (use apenas se a história envolve deslocamento geográfico)
- "stack": multiplicação de ícones (use para quantidades: pessoas, dinheiro, unidades)
Varie os tipos. No máximo 2 "chart". Bloco 1 de preferência "photo" ou "headline".

Responda SÓ com JSON válido neste formato exato:
{
 "title": "título curto e forte (máx 6 palavras)",
 "kicker": "frase final de 5-10 palavras",
 "blocks": [
  {
   "narration": "texto falado do bloco",
   "scene": {
    "type": "photo|headline|chart|route|stack",
    "colorField": "yellow|paper|navy|coral|red",
    "label": "etiqueta curta da cena (2-4 palavras, MAIÚSCULAS)",
    "caption": "legenda datilografada curta sob a foto (3-6 palavras, para photo)",
    "notes": ["2 a 3 itens curtos de anotação de campo (2-3 palavras cada)"],
    "notesTitle": "título do cartão de notas (1-2 palavras MAIÚSCULAS)",
    "stamp": "carimbo de 1-2 palavras tipo CONFIDENCIAL/URGENTE (use com moderação, 1-2 cenas)",
    "imageQuery": "busca em INGLÊS para foto de arquivo real (2-5 palavras, só para type photo)",
    "imageQueryAlt": "busca alternativa em inglês",
    "imagePrompt": "descrição em inglês da imagem para IA gerar (só para type photo)",
    "headline": "2 a 4 PALAVRAS de impacto (só para headline)",
    "chart": {"unit": "unidade", "bars": [{"label": "nome", "value": 10}]},
    "route": {"from": "origem", "to": "destino"},
    "stack": {"emoji": "um emoji", "count": 100, "label": "o que representa"}
   }
  }
 ]
}
Use "colorField" variado (navy/red para momentos tensos ou dramáticos, yellow/paper para dados, coral no máximo 1 vez; red combina com histórias de guerra, crime e mistério).
As cenas devem ser COLAGENS DENSAS: cenas photo/route quase sempre levam "caption" e "notes"; use "stamp" nas 1-2 cenas mais dramáticas.`;
  const raw = await gemText(prompt, { json: true });
  let obj;
  try { obj = JSON.parse(raw); }
  catch { obj = JSON.parse(raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '')); }
  if (!obj.blocks || !obj.blocks.length) throw new Error('roteiro vazio');
  obj.blocks = obj.blocks.slice(0, n).map(b => {
    const s = b.scene || {};
    if (!['photo', 'headline', 'chart', 'route', 'stack'].includes(s.type)) s.type = 'headline';
    if (!FIELD_BG[s.colorField]) s.colorField = 'paper';
    if (s.type === 'chart' && !(s.chart && Array.isArray(s.chart.bars) && s.chart.bars.length)) s.type = 'headline';
    if (s.type === 'stack' && !(s.stack && s.stack.emoji)) s.type = 'headline';
    if (s.type === 'route' && !(s.route && s.route.from)) s.type = 'headline';
    if (!s.headline) s.headline = (s.label || 'A HISTÓRIA');
    b.scene = s;
    return b;
  });
  return obj;
}

/* ============================================================
   MOTOR DE ANIMAÇÃO (Canvas 2D)
   ============================================================ */
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeOutCubic = (t) => 1 - Math.pow(1 - clamp01(t), 3);
const easeOutBack = (t) => { t = clamp01(t); const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
const seg = (t, a, b) => clamp01((t - a) / (b - a));

function makeNoiseTile() {
  const c = document.createElement('canvas'); c.width = c.height = 160;
  const x = c.getContext('2d');
  const d = x.createImageData(160, 160);
  for (let i = 0; i < d.data.length; i += 4) {
    const v = 110 + Math.random() * 40;
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
    d.data[i + 3] = Math.random() * 18;
  }
  x.putImageData(d, 0, 0);
  return c;
}
function makeHalftoneTile(color, dot = 2.2, gap = 11) {
  const c = document.createElement('canvas'); c.width = c.height = gap * 4;
  const x = c.getContext('2d');
  x.fillStyle = color;
  for (let i = gap / 2; i < c.width; i += gap)
    for (let j = gap / 2; j < c.height; j += gap) {
      x.beginPath(); x.arc(i, j, dot, 0, 7); x.fill();
    }
  return c;
}

// aleatório determinístico (bordas rasgadas estáveis entre frames)
function seededRand(seed) {
  let s = (seed * 9301 + 49297) % 233280;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}
// retângulo com borda irregular de papel rasgado
function tornRectPath(ctx, x, y, w, h, seed, jag = 0.12) {
  const r = seededRand(seed);
  const j = jag * Math.min(w, h) * 0.5;
  const step = Math.max(12, Math.min(w, h) / 7);
  const pts = [];
  for (let px = x; px < x + w; px += step) pts.push([px, y + (r() - 0.5) * j]);
  for (let py = y; py < y + h; py += step) pts.push([x + w + (r() - 0.5) * j, py]);
  for (let px = x + w; px > x; px -= step) pts.push([px, y + h + (r() - 0.5) * j]);
  for (let py = y + h; py > y; py -= step) pts.push([x + (r() - 0.5) * j, py]);
  ctx.beginPath();
  pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
  ctx.closePath();
}

class VoxRenderer {
  constructor(canvas, project, timeline, assets) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.p = project; this.tl = timeline; this.assets = assets;
    this.W = canvas.width; this.H = canvas.height;
    this.vert = this.H > this.W;
    this.noise = makeNoiseTile();
    this.htInk = makeHalftoneTile('rgba(20,24,31,.14)');
    this.htPaper = makeHalftoneTile('rgba(244,238,225,.16)');
    this.u = Math.min(this.W, this.H) / 720; // unidade de escala
  }
  font(px, black = true) { return `${black ? '' : '600 '}${Math.round(px)}px ${black ? '"Archivo Black"' : 'Inter'}, sans-serif`; }

  // painel de papel colado com borda rasgada e sombra
  paperPanel(cx, cy, w, h, rot, color, seed, jag = 0.06) {
    const { ctx, u } = this;
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(rot);
    ctx.shadowColor = 'rgba(0,0,0,.28)'; ctx.shadowBlur = 18 * u; ctx.shadowOffsetY = 8 * u;
    tornRectPath(ctx, -w / 2, -h / 2, w, h, seed, jag);
    ctx.fillStyle = color; ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = ctx.createPattern(this.noise, 'repeat');
    ctx.fill();
    ctx.restore();
  }
  // carimbo vermelho tipo "CLASSIFIED" que bate na tela
  stamp(text, x, y, rot, prog, color = PAL.red) {
    if (prog <= 0) return;
    const { ctx, u } = this;
    const a = easeOutCubic(Math.min(1, prog * 1.6));
    ctx.save();
    ctx.translate(x, y); ctx.rotate(rot);
    ctx.scale(1.7 - 0.7 * a, 1.7 - 0.7 * a);
    ctx.globalAlpha = 0.88 * a;
    ctx.font = this.font(30 * u);
    const w = ctx.measureText(text).width + 34 * u;
    ctx.strokeStyle = color; ctx.lineWidth = 5 * u;
    ctx.strokeRect(-w / 2, -27 * u, w, 54 * u);
    ctx.fillStyle = color;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 0, 0);
    // desgaste de tinta do carimbo
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = ctx.createPattern(this.noise, 'repeat');
    ctx.fillRect(-w / 2, -27 * u, w, 54 * u);
    ctx.restore();
  }
  // cartão de anotações de campo com checkmarks
  notesCard(cx, cy, w, title, items, prog, seed) {
    if (prog <= 0 || !items.length) return;
    const { ctx, u } = this;
    const a = easeOutBack(Math.min(1, prog * 1.4));
    const lh = 27 * u;
    const h = 52 * u + items.length * lh;
    ctx.save();
    ctx.translate(cx, cy + (1 - a) * 30 * u); ctx.rotate(-0.03);
    ctx.globalAlpha = Math.min(1, a);
    ctx.shadowColor = 'rgba(0,0,0,.32)'; ctx.shadowBlur = 12 * u; ctx.shadowOffsetY = 6 * u;
    tornRectPath(ctx, -w / 2, -h / 2, w, h, seed, 0.14);
    ctx.fillStyle = '#FBF4E4'; ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = this.font(19 * u);
    ctx.fillStyle = PAL.ink;
    ctx.fillText(title, -w / 2 + 15 * u, -h / 2 + 26 * u);
    ctx.fillStyle = PAL.red;
    ctx.fillRect(-w / 2 + 15 * u, -h / 2 + 40 * u, w * 0.45, 3.5 * u);
    ctx.font = this.font(16.5 * u, false);
    items.forEach((it, i) => {
      const ia = seg(prog, 0.25 + i * 0.14, 0.5 + i * 0.14);
      if (ia <= 0) return;
      ctx.fillStyle = PAL.red;
      ctx.fillText('✓', -w / 2 + 15 * u, -h / 2 + 62 * u + i * lh);
      ctx.fillStyle = PAL.ink;
      ctx.fillText(String(it).slice(0, 24), -w / 2 + 34 * u, -h / 2 + 62 * u + i * lh);
    });
    ctx.restore();
  }
  // tira de legenda datilografada sob fotos
  captionStrip(text, cx, cy, prog, seed) {
    if (prog <= 0 || !text) return;
    const { ctx, u } = this;
    const a = easeOutCubic(prog);
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(0.015); ctx.globalAlpha = a;
    ctx.font = this.font(18 * u);
    const w = Math.min(ctx.measureText(text).width + 26 * u, this.W * 0.8);
    ctx.shadowColor = 'rgba(0,0,0,.28)'; ctx.shadowBlur = 8 * u; ctx.shadowOffsetY = 4 * u;
    tornRectPath(ctx, -w / 2, -17 * u, w, 34 * u, seed, 0.3);
    ctx.fillStyle = '#FBF4E4'; ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = PAL.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
  // seta desenhada à mão (com tremor) + ponta
  handArrow(x1, y1, x2, y2, prog, color = PAL.ink) {
    if (prog <= 0) return;
    const { ctx, u } = this;
    const cx = (x1 + x2) / 2 + (y2 - y1) * 0.25, cy = (y1 + y2) / 2 - (x2 - x1) * 0.25;
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = 6 * u; ctx.lineCap = 'round';
    ctx.beginPath();
    const n = 24, end = Math.floor(n * easeOutCubic(prog));
    for (let i = 0; i <= end; i++) {
      const s = i / n;
      const x = (1 - s) * (1 - s) * x1 + 2 * (1 - s) * s * cx + s * s * x2 + Math.sin(s * 18) * 1.5 * u;
      const y = (1 - s) * (1 - s) * y1 + 2 * (1 - s) * s * cy + s * s * y2 + Math.cos(s * 15) * 1.5 * u;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    if (prog > 0.92) {
      const a = Math.atan2(y2 - cy, x2 - cx);
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - 16 * u * Math.cos(a - 0.45), y2 - 16 * u * Math.sin(a - 0.45));
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - 16 * u * Math.cos(a + 0.45), y2 - 16 * u * Math.sin(a + 0.45));
      ctx.stroke();
    }
    ctx.restore();
  }

  draw(t) {
    const { ctx, W, H } = this;
    const total = this.tl.total;
    t = Math.min(t, total - 0.001);
    let bi = this.tl.blocks.findIndex(b => t < b.start + b.dur);
    if (bi < 0) bi = this.tl.blocks.length - 1;
    const blk = this.tl.blocks[bi];
    const tb = t - blk.start;           // tempo local no bloco
    const p = clamp01(tb / blk.dur);    // progresso 0..1

    if (blk.kind === 'endcard') { this.endcard(tb, blk.dur); this.progressBar(t / total); return; }

    const scene = blk.block.scene;
    // base: papel envelhecido SEMPRE — o "color field" é um painel de papel colado por cima
    ctx.fillStyle = '#E9DFC8'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = ctx.createPattern(this.noise, 'repeat'); ctx.fillRect(0, 0, W, H);
    const bg = FIELD_BG[scene.colorField];
    this.paperPanel(W / 2, H / 2, W * 0.95, H * 0.95, 0.004 * (blk.index % 2 ? 1 : -1),
      scene.colorField === 'paper' ? '#F6F0E2' : bg, blk.index * 7 + 3, 0.03);
    // patch de halftone no canto
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = ctx.createPattern(scene.colorField === 'navy' ? this.htPaper : this.htInk, 'repeat');
    ctx.beginPath(); ctx.arc(W * 0.9, H * 0.1, Math.min(W, H) * 0.26, 0, 7); ctx.fill();
    ctx.restore();

    // "impact" de entrada do bloco: leve overshoot global
    const imp = 1 + 0.05 * (1 - easeOutCubic(seg(tb, 0, 0.3)));
    ctx.save();
    ctx.translate(W / 2, H / 2); ctx.scale(imp, imp); ctx.translate(-W / 2, -H / 2);

    const draw = this['scene_' + scene.type] || this.scene_headline;
    draw.call(this, blk, tb, p);
    ctx.restore();

    this.subtitles(blk, p);
    this.labelChip(scene, tb);
    // vinheta cinematográfica
    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.max(W, H) * 0.72);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(35,22,8,0.2)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
    this.progressBar(t / total);
  }

  progressBar(f) {
    const { ctx, W } = this;
    ctx.fillStyle = 'rgba(20,24,31,.25)'; ctx.fillRect(0, 0, W, 8 * this.u);
    ctx.fillStyle = PAL.yellow; ctx.fillRect(0, 0, W * clamp01(f), 8 * this.u);
  }

  labelChip(scene, tb) {
    if (!scene.label) return;
    const { ctx, W, H, u } = this;
    const a = easeOutBack(seg(tb, 0.25, 0.7));
    if (a <= 0) return;
    ctx.save();
    ctx.translate(W * 0.06, H * 0.055);
    ctx.rotate(-0.03); ctx.scale(a, a);
    ctx.font = this.font(26 * u);
    const txt = String(scene.label).toUpperCase().slice(0, 28);
    const w = ctx.measureText(txt).width + 34 * u;
    ctx.fillStyle = PAL.ink; ctx.fillRect(6 * u, 6 * u, w, 46 * u);
    ctx.fillStyle = PAL.yellow; ctx.fillRect(0, 0, w, 46 * u);
    ctx.strokeStyle = PAL.ink; ctx.lineWidth = 3.5 * u; ctx.strokeRect(0, 0, w, 46 * u);
    ctx.fillStyle = PAL.ink; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillText(txt, 17 * u, 25 * u);
    ctx.restore();
  }

  // legendas estilo Vox: palavra por palavra sincronizada, com marca-texto na palavra atual
  subtitles(blk, p) {
    const narr = blk.block.narration || '';
    if (!narr) return;
    const { ctx, W, H, u } = this;
    const words = narr.split(/\s+/);
    // timing por palavra proporcional ao comprimento (sincroniza com a fala)
    if (!blk._wt) {
      const weights = words.map(w => w.length + 2);
      const tot = weights.reduce((a, b) => a + b, 0);
      let acc = 0;
      blk._wt = weights.map(w => { const st = acc / tot; acc += w; return st; });
    }
    const lead = 0.03, span = 0.9;
    let cur = -1;
    for (let i = 0; i < words.length; i++) if (p >= lead + blk._wt[i] * span) cur = i;
    if (cur < 0) cur = 0;
    const per = 6;
    const li = Math.floor(cur / per);
    const lineWords = words.slice(li * per, li * per + per);
    const curInLine = cur - li * per;
    let fs = 34 * u;
    ctx.font = this.font(fs);
    const gaps = 11 * u;
    let widths = lineWords.map(w => ctx.measureText(w).width);
    let totW = widths.reduce((a, b) => a + b, 0) + gaps * (lineWords.length - 1);
    while (totW > W * 0.88 && fs > 16 * u) {
      fs *= 0.93; ctx.font = this.font(fs);
      widths = lineWords.map(w => ctx.measureText(w).width);
      totW = widths.reduce((a, b) => a + b, 0) + gaps * (lineWords.length - 1);
    }
    const y = H * (this.vert ? 0.85 : 0.87);
    ctx.save();
    ctx.translate(W / 2, y);
    ctx.rotate(-0.006);
    // tira de papel atrás da legenda
    ctx.shadowColor = 'rgba(0,0,0,.3)'; ctx.shadowBlur = 14 * u; ctx.shadowOffsetY = 6 * u;
    tornRectPath(ctx, -totW / 2 - 22 * u, -fs * 0.9, totW + 44 * u, fs * 1.7, blk.index * 31 + li, 0.2);
    ctx.fillStyle = '#FBF6EA'; ctx.fill();
    ctx.shadowColor = 'transparent';
    let x = -totW / 2;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    lineWords.forEach((w, i) => {
      if (i === curInLine) {
        ctx.fillStyle = PAL.yellow;
        ctx.fillRect(x - 5 * u, -fs * 0.66, widths[i] + 10 * u, fs * 1.22);
      }
      ctx.fillStyle = i <= curInLine ? PAL.ink : 'rgba(20,24,31,0.25)';
      ctx.fillText(w, x, 0);
      x += widths[i] + gaps;
    });
    ctx.restore();
  }

  tape(x, y, w, h, rot) {
    const { ctx } = this;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = 'rgba(238,226,192,.85)';
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.fillStyle = 'rgba(255,255,255,.25)';
    ctx.fillRect(-w / 2, -h / 2, w, h / 3);
    ctx.restore();
  }
  pin(x, y, s) {
    const { ctx } = this;
    ctx.save();
    ctx.translate(x, y); ctx.scale(s, s);
    ctx.fillStyle = 'rgba(0,0,0,.28)';
    ctx.beginPath(); ctx.ellipse(3, 6, 9, 5, 0, 0, 7); ctx.fill();
    const g = ctx.createRadialGradient(-3, -4, 2, 0, 0, 12);
    g.addColorStop(0, '#ff9c8f'); g.addColorStop(0.5, PAL.coral); g.addColorStop(1, '#c23324');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, 11, 0, 7); ctx.fill();
    ctx.restore();
  }
  markerEllipse(cx, cy, rx, ry, prog, color) {
    if (prog <= 0) return;
    const { ctx, u } = this;
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = 7 * u; ctx.lineCap = 'round';
    ctx.beginPath();
    const start = -Math.PI * 0.7, end = start + Math.PI * 2.15 * easeOutCubic(prog);
    for (let a = start; a <= end; a += 0.05) {
      const wob = 1 + 0.045 * Math.sin(a * 3.2 + cx);
      const x = cx + Math.cos(a) * rx * wob;
      const y = cy + Math.sin(a) * ry * wob;
      a === start ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /* ---- CENA: FOTO DE ARQUIVO (recorte de papel) ---- */
  scene_photo(blk, tb, p) {
    const { ctx, W, H, u } = this;
    const img = this.assets[blk.index];
    const enter = easeOutBack(seg(tb, 0.05, 0.55));
    const zoom = 1 + 0.06 * p;
    const iw = Math.min(W * 0.74, H * 0.52);
    const ih = iw * 0.75;
    const pad = iw * 0.055;
    const bx = W / 2 + (1 - enter) * W * 0.9;
    const by = H * (this.vert ? 0.4 : 0.44);
    ctx.save();
    ctx.translate(bx, by); ctx.rotate(-0.05); ctx.scale(zoom, zoom);
    // recorte branco com borda irregular de papel rasgado
    ctx.shadowColor = 'rgba(0,0,0,.42)'; ctx.shadowBlur = 24 * u; ctx.shadowOffsetY = 14 * u;
    tornRectPath(ctx, -iw / 2 - pad, -ih / 2 - pad, iw + pad * 2, ih + pad * 2, blk.index * 17 + 1, 0.14);
    ctx.fillStyle = '#FFFFFF'; ctx.fill();
    ctx.shadowColor = 'transparent';
    if (img) {
      ctx.save();
      tornRectPath(ctx, -iw / 2, -ih / 2, iw, ih, blk.index * 17 + 2, 0.05);
      ctx.clip();
      const r = Math.max(iw / img.width, ih / img.height);
      const sw = iw / r, sh = ih / r;
      ctx.filter = 'saturate(0.65) contrast(1.08) sepia(0.12)';
      ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, -iw / 2, -ih / 2, iw, ih);
      ctx.filter = 'none';
      // meio-tom por cima: aparência de impressão de jornal
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = ctx.createPattern(this.htInk, 'repeat');
      ctx.fillRect(-iw / 2, -ih / 2, iw, ih);
      ctx.restore();
    } else {
      tornRectPath(ctx, -iw / 2, -ih / 2, iw, ih, blk.index * 17 + 2, 0.05);
      ctx.fillStyle = PAL.paper2; ctx.fill();
      ctx.font = this.font(ih * 0.4); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(blk.block.scene.stack?.emoji || '🗞️', 0, 0);
    }
    // fitas adesivas nos cantos
    const ta = easeOutBack(seg(tb, 0.5, 0.8));
    if (ta > 0) {
      ctx.save(); ctx.globalAlpha = ta;
      this.tape(-iw / 2, -ih / 2, iw * 0.26, iw * 0.06, -0.55);
      this.tape(iw / 2, -ih / 2, iw * 0.26, iw * 0.06, 0.5);
      ctx.restore();
    }
    ctx.restore();
    // alfinete cai
    const ps = seg(tb, 0.38, 0.6);
    if (ps > 0) {
      const drop = easeOutBack(ps);
      this.pin(bx, by - (ih / 2 + pad) * zoom + (1 - drop) * -H * 0.2, drop * 1.35 * u);
    }
    // seta desenhada à mão do rótulo até a foto
    const darkBg = ['navy', 'red'].includes(blk.block.scene.colorField);
    this.handArrow(W * 0.2, H * 0.14, bx - iw * 0.28, by - ih * 0.42, seg(tb, 0.45, 0.72),
      darkBg ? PAL.paper : PAL.ink);
    // círculo de marcador
    this.markerEllipse(bx, by, iw * 0.6, ih * 0.62, seg(p, 0.58, 0.85),
      ['coral', 'red'].includes(blk.block.scene.colorField) ? PAL.yellow : PAL.coral);
    // camadas extras da colagem: legenda datilografada, anotações de campo e carimbo
    const s = blk.block.scene;
    this.captionStrip((s.caption || '').toUpperCase(), bx + W * 0.03, by + (ih / 2 + pad) * zoom + 26 * u, seg(tb, 0.5, 0.75), blk.index * 41 + 7);
    if (s.notes && s.notes.length) this.notesCard(W * 0.26, H * (this.vert ? 0.69 : 0.72), W * 0.42, s.notesTitle || 'ANOTAÇÕES', s.notes.slice(0, 3), seg(tb, 0.55, 0.95), blk.index * 43 + 9);
    if (s.stamp) this.stamp(String(s.stamp).toUpperCase().slice(0, 14), W * 0.74, H * (this.vert ? 0.7 : 0.73), 0.12, seg(tb, 0.78, 0.92),
      darkBg ? '#F2E3C2' : PAL.red);
  }

  /* ---- CENA: TIPOGRAFIA ---- */
  scene_headline(blk, tb) {
    const { ctx, W, H, u } = this;
    const scene = blk.block.scene;
    const fg = FIELD_FG[scene.colorField];
    const words = String(scene.headline || '').toUpperCase().split(/\s+/).slice(0, 4);
    let fs = Math.min(W * 0.82 / Math.max(...words.map(w => w.length * 0.62)), H * 0.12);
    ctx.font = this.font(fs);
    // ajuste fino: Archivo Black é larga — mede de verdade e encolhe até caber
    while (fs > 20 && Math.max(...words.map(w => ctx.measureText(w).width)) > W * 0.86) {
      fs *= 0.94;
      ctx.font = this.font(fs);
    }
    const lh = fs * 1.24;
    const y0 = H * (this.vert ? 0.4 : 0.44) - (words.length - 1) * lh / 2;
    // cada palavra vira um painel de papel colado (vermelho/amarelo/preto alternados)
    const panelCols = scene.colorField === 'yellow'
      ? [PAL.red, PAL.ink, PAL.white]
      : scene.colorField === 'red'
        ? [PAL.yellow, PAL.paper, PAL.ink]
        : [PAL.red, PAL.yellow, PAL.ink];
    words.forEach((w, i) => {
      const t0 = 0.15 + i * 0.22;
      const a = easeOutBack(seg(tb, t0, t0 + 0.35));
      if (a <= 0) return;
      const y = y0 + i * lh;
      const tw = ctx.measureText(w).width;
      const pc = panelCols[i % panelCols.length];
      ctx.save();
      ctx.translate(W / 2, y); ctx.rotate((i % 2 ? 1 : -1) * 0.014); ctx.scale(a, a);
      ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 12 * u; ctx.shadowOffsetY = 7 * u;
      tornRectPath(ctx, -tw / 2 - 18 * u, -fs * 0.64, tw + 36 * u, fs * 1.22, i * 53 + 11, 0.16);
      ctx.fillStyle = pc; ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = (pc === PAL.yellow || pc === PAL.white || pc === PAL.paper) ? PAL.ink : PAL.paper;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(w, 0, 0);
      ctx.restore();
    });
    // sublinhado final
    const un = easeOutCubic(seg(tb, 0.2 + words.length * 0.22, 0.6 + words.length * 0.22));
    ctx.fillStyle = fg;
    ctx.fillRect(W * 0.3, y0 + words.length * lh - fs * 0.2, W * 0.4 * un, 8 * u);
  }

  /* ---- CENA: GRÁFICO ---- */
  scene_chart(blk, tb, p) {
    const { ctx, W, H, u } = this;
    const scene = blk.block.scene;
    const bars = (scene.chart.bars || []).slice(0, 5);
    const maxV = Math.max(...bars.map(b => +b.value || 1));
    const fg = FIELD_FG[scene.colorField];
    const areaW = W * 0.8, areaH = H * (this.vert ? 0.34 : 0.42);
    const x0 = W * 0.1, yBase = H * (this.vert ? 0.58 : 0.62);
    const bw = areaW / bars.length * 0.62;
    const gap = areaW / bars.length;
    // linha de base
    ctx.strokeStyle = fg; ctx.lineWidth = 5 * u;
    ctx.beginPath(); ctx.moveTo(x0 - 10 * u, yBase); ctx.lineTo(x0 + areaW + 10 * u, yBase); ctx.stroke();
    bars.forEach((b, i) => {
      const g = easeOutBack(seg(tb, 0.25 + i * 0.18, 0.75 + i * 0.18));
      if (g <= 0) return;
      const h = areaH * ((+b.value || 0) / maxV) * Math.min(1, g);
      const x = x0 + i * gap + (gap - bw) / 2;
      ctx.fillStyle = scene.colorField === 'navy' ? PAL.yellow : (i % 2 ? PAL.navy : PAL.coral);
      ctx.fillRect(x, yBase - h, bw, h);
      ctx.strokeStyle = PAL.ink; ctx.lineWidth = 3 * u; ctx.strokeRect(x, yBase - h, bw, h);
      // valor
      ctx.font = this.font(26 * u);
      ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      const shown = Math.round((+b.value || 0) * Math.min(1, g));
      ctx.fillText(String(shown) + (scene.chart.unit ? '' : ''), x + bw / 2, yBase - h - 8 * u);
      // rótulo
      ctx.font = this.font(17 * u, false);
      ctx.textBaseline = 'top';
      ctx.fillText(String(b.label).slice(0, 12), x + bw / 2, yBase + 10 * u);
    });
    if (scene.chart.unit) {
      ctx.font = this.font(20 * u, false);
      ctx.fillStyle = fg; ctx.textAlign = 'left';
      ctx.fillText(scene.chart.unit, x0, yBase - areaH - 46 * u);
    }
  }

  /* ---- CENA: MAPA MILITAR ANOTADO ---- */
  scene_route(blk, tb, p) {
    const { ctx, W, H, u } = this;
    const scene = blk.block.scene;
    const mw = W * 0.86, mh = H * (this.vert ? 0.44 : 0.56);
    const mx = W / 2, my = H * (this.vert ? 0.4 : 0.44);
    const enter = easeOutBack(seg(tb, 0.05, 0.4));
    ctx.save();
    ctx.translate(mx, my + (1 - enter) * H * 0.4); ctx.rotate(-0.015);
    // folha de mapa rasgada
    ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = 22 * u; ctx.shadowOffsetY = 12 * u;
    tornRectPath(ctx, -mw / 2, -mh / 2, mw, mh, blk.index * 19 + 4, 0.07);
    ctx.fillStyle = '#F3EAD3'; ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.save();
    tornRectPath(ctx, -mw / 2, -mh / 2, mw, mh, blk.index * 19 + 4, 0.07);
    ctx.clip();
    // grade quadriculada
    ctx.strokeStyle = 'rgba(20,24,31,0.13)'; ctx.lineWidth = 1.5 * u;
    for (let gx = -mw / 2; gx < mw / 2; gx += 46 * u) { ctx.beginPath(); ctx.moveTo(gx, -mh / 2); ctx.lineTo(gx, mh / 2); ctx.stroke(); }
    for (let gy = -mh / 2; gy < mh / 2; gy += 46 * u) { ctx.beginPath(); ctx.moveTo(-mw / 2, gy); ctx.lineTo(mw / 2, gy); ctx.stroke(); }
    // massas de terra
    ctx.fillStyle = 'rgba(20,24,31,0.1)';
    this.blob(-mw * 0.28, mh * 0.14, mw * 0.3);
    this.blob(mw * 0.3, -mh * 0.1, mw * 0.26);
    const ax = -mw * 0.3, ay = mh * 0.08, bx2 = mw * 0.3, by2 = -mh * 0.08;
    // rota tracejada vermelha desenhando
    const prog = easeOutCubic(seg(tb, 0.3, 0.72));
    const cpx = 0, cpy = -mh * 0.34;
    ctx.strokeStyle = PAL.red; ctx.lineWidth = 6.5 * u; ctx.setLineDash([16 * u, 13 * u]); ctx.lineCap = 'round';
    ctx.beginPath();
    for (let s = 0; s <= prog; s += 0.02) {
      const x = (1 - s) * (1 - s) * ax + 2 * (1 - s) * s * cpx + s * s * bx2;
      const yy = (1 - s) * (1 - s) * ay + 2 * (1 - s) * s * cpy + s * s * by2;
      s === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
    }
    ctx.stroke(); ctx.setLineDash([]);
    // círculo vermelho rabiscado no destino
    this.markerEllipse(bx2, by2, mw * 0.13, mh * 0.11, seg(tb, 0.72, 0.92), PAL.red);
    // setinhas de "movimento" azuis
    const arrProg = seg(tb, 0.45, 0.8);
    for (let i = 0; i < 3; i++) {
      this.handArrow(ax + i * 30 * u, ay + mh * 0.22 + i * 14 * u, ax + mw * 0.22 + i * 30 * u, ay + mh * 0.1 + i * 12 * u,
        seg(arrProg, i * 0.2, 0.6 + i * 0.2), PAL.navy);
    }
    ctx.restore();
    // pinos + etiquetas (dentro do mapa)
    const pa = easeOutBack(seg(tb, 0.18, 0.4));
    const pb = easeOutBack(seg(tb, 0.72, 0.95));
    if (pa > 0) { this.pin(ax, ay, pa * 1.3 * u); this.routeLabel(scene.route.from, ax, ay + 38 * u, pa); }
    if (pb > 0) { this.pin(bx2, by2, pb * 1.3 * u); this.routeLabel(scene.route.to, bx2, by2 + 38 * u, pb); }
    ctx.restore();
    // camadas extra
    const s2 = blk.block.scene;
    if (s2.notes && s2.notes.length) this.notesCard(W * 0.26, H * (this.vert ? 0.69 : 0.74), W * 0.42, s2.notesTitle || 'RELATÓRIO', s2.notes.slice(0, 3), seg(tb, 0.55, 0.95), blk.index * 47 + 3);
    if (s2.stamp) this.stamp(String(s2.stamp).toUpperCase().slice(0, 14), W * 0.74, H * (this.vert ? 0.7 : 0.74), 0.12, seg(tb, 0.8, 0.94));
  }
  blob(cx, cy, r) {
    const { ctx } = this;
    ctx.beginPath();
    for (let a = 0; a < Math.PI * 2; a += 0.4) {
      const rr = r * (0.75 + 0.25 * Math.sin(a * 3 + cx * 0.01));
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.62;
      a === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.fill();
  }
  routeLabel(txt, x, y, a) {
    const { ctx, u } = this;
    if (!txt) return;
    ctx.save(); ctx.globalAlpha = a;
    ctx.font = this.font(22 * u);
    const w = ctx.measureText(txt).width + 24 * u;
    ctx.fillStyle = PAL.ink; ctx.fillRect(x - w / 2, y, w, 38 * u);
    ctx.fillStyle = PAL.white; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(txt, x, y + 19 * u);
    ctx.restore();
  }

  /* ---- CENA: MULTIPLICAÇÃO ---- */
  scene_stack(blk, tb, p) {
    const { ctx, W, H, u } = this;
    const scene = blk.block.scene;
    const emoji = scene.stack.emoji || '💰';
    const count = Math.max(1, +scene.stack.count || 12);
    const shown = Math.min(count, this.vert ? 16 : 18);
    const cols = this.vert ? 4 : 6;
    const rows = Math.ceil(shown / cols);
    const cell = Math.min(W * 0.8 / cols, H * 0.3 / rows);
    const gx = W / 2 - (cols * cell) / 2, gy = H * (this.vert ? 0.26 : 0.28);
    ctx.font = `${Math.round(cell * 0.72)}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < shown; i++) {
      const a = easeOutBack(seg(tb, 0.15 + i * 0.045, 0.4 + i * 0.045));
      if (a <= 0) continue;
      const c = i % cols, r = Math.floor(i / cols);
      ctx.save();
      ctx.translate(gx + c * cell + cell / 2, gy + r * cell + cell / 2);
      ctx.scale(a, a);
      ctx.fillText(emoji, 0, 0);
      ctx.restore();
    }
    // número gigante contando
    const numP = easeOutCubic(seg(tb, 0.3, 0.9));
    const val = Math.round(count * numP);
    const fg = FIELD_FG[scene.colorField];
    ctx.font = this.font(H * 0.075);
    ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const ny = Math.min(gy + rows * cell + H * 0.06, H * (this.vert ? 0.66 : 0.68));
    ctx.fillText(val.toLocaleString('pt-BR'), W / 2, ny);
    if (scene.stack.label) {
      ctx.font = this.font(22 * u, false);
      ctx.fillText(scene.stack.label, W / 2, ny + H * 0.05);
    }
  }

  /* ---- ENDCARD ---- */
  endcard(tb, dur) {
    const { ctx, W, H, u } = this;
    ctx.fillStyle = '#E9DFC8'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = ctx.createPattern(this.noise, 'repeat'); ctx.fillRect(0, 0, W, H);
    this.paperPanel(W / 2, H / 2, W * 0.92, H * 0.62, -0.01, PAL.navy, 991, 0.06);
    const a = easeOutBack(seg(tb, 0.05, 0.5));
    ctx.save();
    ctx.translate(W / 2, H * 0.44); ctx.scale(a, a);
    const title = (this.p.title || '').toUpperCase();
    const fs = Math.min(W * 0.9 / (Math.max(...title.split(' ').map(w => w.length)) * 0.62 || 1), H * 0.08);
    ctx.font = this.font(fs);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const lines = [];
    let line = '';
    for (const w of title.split(' ')) {
      const t2 = line ? line + ' ' + w : w;
      if (ctx.measureText(t2).width > W * 0.86 && line) { lines.push(line); line = w; }
      else line = t2;
    }
    if (line) lines.push(line);
    lines.forEach((ln, i) => {
      ctx.fillStyle = PAL.paper;
      ctx.fillText(ln, 0, (i - (lines.length - 1) / 2) * fs * 1.3);
    });
    ctx.restore();
    // sublinhado e kicker posicionados ABAIXO do título, sem sobreposição
    const titleBottom = H * 0.44 + (lines.length / 2) * fs * 1.3 * a + 30 * u;
    const un = easeOutCubic(seg(tb, 0.5, 0.9));
    ctx.fillStyle = PAL.yellow;
    ctx.fillRect(W / 2 - W * 0.2 * un, titleBottom, W * 0.4 * un, 9 * u);
    if (this.p.kicker) {
      ctx.globalAlpha = seg(tb, 0.6, 1);
      ctx.font = this.font(22 * u, false);
      ctx.fillStyle = PAL.paper; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      // quebra o kicker em linhas se for longo
      const kw = [];
      let kl = '';
      for (const w of String(this.p.kicker).split(' ')) {
        const t2 = kl ? kl + ' ' + w : w;
        if (ctx.measureText(t2).width > W * 0.8 && kl) { kw.push(kl); kl = w; }
        else kl = t2;
      }
      if (kl) kw.push(kl);
      kw.forEach((ln, i) => ctx.fillText(ln, W / 2, titleBottom + 50 * u + i * 32 * u));
      ctx.globalAlpha = 1;
    }
  }
}

/* ============================================================
   ÁUDIO — narração agendada + trilha sintetizada + whooshes
   ============================================================ */
function buildAudioGraph(actx, dest, timeline, voiceBuffers) {
  const master = actx.createGain(); master.gain.value = 1; master.connect(dest);
  // narração
  const voxGain = actx.createGain(); voxGain.gain.value = 1.0; voxGain.connect(master);
  // música
  const musGain = actx.createGain(); musGain.gain.value = 0.1; musGain.connect(master);

  const t0 = actx.currentTime + 0.2;
  timeline.blocks.forEach((blk) => {
    if (blk.kind === 'block' && voiceBuffers[blk.index]) {
      const src = actx.createBufferSource();
      src.buffer = voiceBuffers[blk.index];
      src.connect(voxGain);
      src.start(t0 + blk.start + 0.25);
    }
  });

  // pulso grave ~46 BPM
  const beat = 60 / 46;
  for (let t = 0; t < timeline.total; t += beat) {
    const osc = actx.createOscillator(); osc.type = 'sine'; osc.frequency.value = 55;
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, t0 + t);
    g.gain.exponentialRampToValueAtTime(0.5, t0 + t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + t + 0.42);
    osc.connect(g); g.connect(musGain);
    osc.start(t0 + t); osc.stop(t0 + t + 0.5);
  }
  // pad baixo contínuo
  const pad = actx.createOscillator(); pad.type = 'triangle'; pad.frequency.value = 110;
  const pad2 = actx.createOscillator(); pad2.type = 'triangle'; pad2.frequency.value = 165;
  const lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 320;
  const pg = actx.createGain(); pg.gain.value = 0.05;
  pad.connect(lp); pad2.connect(lp); lp.connect(pg); pg.connect(musGain);
  pad.start(t0); pad2.start(t0);
  pad.stop(t0 + timeline.total); pad2.stop(t0 + timeline.total);

  // whoosh de papel nas transições
  const noiseBuf = actx.createBuffer(1, actx.sampleRate * 0.5, actx.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * (1 - i / nd.length);
  timeline.blocks.forEach((blk) => {
    if (blk.start === 0) return;
    const src = actx.createBufferSource(); src.buffer = noiseBuf;
    const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(500, t0 + blk.start - 0.1);
    bp.frequency.exponentialRampToValueAtTime(2400, t0 + blk.start + 0.25);
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, t0 + blk.start - 0.1);
    g.gain.exponentialRampToValueAtTime(0.22, t0 + blk.start);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + blk.start + 0.35);
    src.connect(bp); bp.connect(g); g.connect(master);
    src.start(t0 + blk.start - 0.1);
  });

  return t0;
}

/* ============================================================
   PIPELINE
   ============================================================ */
async function generate() {
  if (busy) return;
  const topic = $('#topic').value.trim();
  if (!topic) { toast('Escreva o tema do vídeo 👆'); return; }
  if (!settings.key) { toast('Configure sua chave Gemini grátis primeiro'); openSettings(); return; }

  busy = true;
  $('#btnGenerate').disabled = true;
  $('#resultCard').classList.add('hidden');
  $('#progressCard').classList.remove('hidden');
  resetPhases();

  const seconds = +$('#optDuration').value;
  const aspect = $('#optAspect').value;
  const voice = $('#optVoice').value;
  const useAI = $('#optAiImages').checked;

  try {
    /* 1 — pesquisa + 2 — roteiro (ou projeto externo injetado p/ testes) */
    let project;
    if (window.__extProject) {
      project = window.__extProject;
      donePhase('research'); donePhase('script');
    } else {
      setPhase('research'); setProgress(4, 'Pesquisando fatos na web…');
      let research = '';
      try {
        research = await gemText(
          `Pesquise fatos verificáveis sobre: "${topic}". Liste em tópicos: números-chave, datas, lugares, nomes, uma virada contraintuitiva e comparações concretas. Seja factual e denso. Responda em português.`,
          { search: true }
        );
      } catch (e) { console.warn('pesquisa falhou', e); }
      donePhase('research');

      setPhase('script'); setProgress(14, 'Escrevendo o roteiro estilo Vox…');
      project = await makeScript(topic, seconds, research);
    }
    lastProject = project;
    donePhase('script');

    /* 3 — imagens */
    setPhase('images');
    const assets = {};
    const photoBlocks = project.blocks.map((b, i) => ({ b, i })).filter(x => x.b.scene.type === 'photo');
    let pi = 0;
    for (const { b, i } of photoBlocks) {
      pi++;
      setProgress(20 + (pi / Math.max(1, photoBlocks.length)) * 22, `Imagem ${pi}/${photoBlocks.length}…`);
      const s = b.scene;
      let img = null;
      if (useAI && s.imagePrompt) {
        try {
          const url = await gemImage(
            'Editorial mixed-media collage illustration, Vox documentary style: archival-photo look, muted colors, halftone texture, paper grain. ' +
            s.imagePrompt + '. No text, no letters, no words, no watermark.'
          );
          img = await loadImg(url);
        } catch (e) { console.warn('img IA falhou', e); }
      }
      if (!img && s.imageQuery) {
        try { img = await loadImg(await wikiImage(s.imageQuery)); }
        catch { if (s.imageQueryAlt) { try { img = await loadImg(await wikiImage(s.imageQueryAlt)); } catch {} } }
      }
      assets[i] = img; // null → placeholder
    }
    donePhase('images');

    /* 4 — narração */
    setPhase('voice');
    const actxTmp = new (window.AudioContext || window.webkitAudioContext)();
    const voiceBuffers = {};
    if (window.__extVoice) {
      // áudios externos injetados (testes/integrações)
      for (let i = 0; i < project.blocks.length; i++) {
        const url = window.__extVoice[i];
        if (!url) continue;
        setProgress(45 + (i / project.blocks.length) * 18, `Narração ${i + 1}/${project.blocks.length}…`);
        try {
          const ab = await fetch(url.startsWith('http') ? '/proxy?url=' + encodeURIComponent(url) : url).then(r => r.arrayBuffer());
          voiceBuffers[i] = await actxTmp.decodeAudioData(ab);
        } catch (e) { console.warn('voz externa falhou bloco ' + i, e); }
      }
    } else if (voice !== 'none') {
      let quotaRetries = 0;
      let engine = 'gemini';
      for (let i = 0; i < project.blocks.length; i++) {
        setProgress(45 + (i / project.blocks.length) * 18, `Narração ${i + 1}/${project.blocks.length}…`);
        const line = project.blocks[i].narration;
        try {
          if (engine === 'eleven') {
            voiceBuffers[i] = await actxTmp.decodeAudioData(await elevenTTS(line));
          } else {
            const { bytes, rate } = await gemTTS(
              'Narre como documentarista, tom grave, calmo e envolvente, em português do Brasil: ' + line,
              voice
            );
            voiceBuffers[i] = pcmToAudioBuffer(actxTmp, bytes, rate);
          }
        } catch (e) {
          console.warn('TTS falhou bloco ' + i, e);
          if (e.status === 429 && engine === 'gemini') {
            // no máx. 2 esperas; depois tenta ElevenLabs; por fim segue sem voz
            if (quotaRetries < 2) { quotaRetries++; setProgress(null, 'Limite de voz atingido, aguardando 25s…'); await sleep(25000); i--; continue; }
            if (settings.elKey) { engine = 'eleven'; toast('Voz do Gemini esgotada — usando ElevenLabs de reserva.', 5000); i--; continue; }
            toast('⚠️ Cota diária de voz esgotada — o vídeo sairá sem narração (renova amanhã).', 7000);
            break;
          }
          if (engine === 'eleven') { toast('⚠️ ElevenLabs falhou — seguindo sem narração.', 6000); break; }
        }
        await sleep(400);
      }
    }
    donePhase('voice');

    /* 5 — timeline */
    const blocks = [];
    let t = 0;
    project.blocks.forEach((b, i) => {
      const vb = voiceBuffers[i];
      const est = Math.max(5.5, b.narration.split(/\s+/).length / 2.4);
      const dur = vb ? vb.duration + 1.0 : est;
      blocks.push({ kind: 'block', index: i, block: b, start: t, dur });
      t += dur;
    });
    blocks.push({ kind: 'endcard', start: t, dur: 2.4 });
    t += 2.4;
    const timeline = { blocks, total: t };

    /* 6 — render + gravação */
    setPhase('render');
    await document.fonts.load('80px "Archivo Black"');
    await document.fonts.load('600 30px Inter');

    const cv = $('#stage');
    if (aspect === '9:16') { cv.width = 720; cv.height = 1280; } else { cv.width = 1280; cv.height = 720; }
    const renderer = new VoxRenderer(cv, project, timeline, assets);
    renderer.draw(0);

    const actx = new (window.AudioContext || window.webkitAudioContext)();
    await actx.resume();
    // re-cria buffers no contexto de gravação
    const vb2 = {};
    for (const k of Object.keys(voiceBuffers)) {
      const src = voiceBuffers[k];
      const nb = actx.createBuffer(1, src.length, src.sampleRate);
      nb.getChannelData(0).set(src.getChannelData(0));
      vb2[k] = nb;
    }
    const dest = actx.createMediaStreamDestination();
    const t0 = buildAudioGraph(actx, dest, timeline, vb2);

    const stream = cv.captureStream(30);
    dest.stream.getAudioTracks().forEach(tr => stream.addTrack(tr));
    const mime = ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find(m => MediaRecorder.isTypeSupported(m)) || '';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const recDone = new Promise(res => { rec.onstop = res; });
    rec.start(500);

    await new Promise((resolve) => {
      let finished = false;
      const step = () => {
        if (finished) return;
        const tt = actx.currentTime - t0;
        if (tt >= 0) renderer.draw(tt);
        setProgress(65 + clamp01(tt / timeline.total) * 34, `Renderizando… ${Math.round(clamp01(tt / timeline.total) * 100)}% — mantenha esta tela aberta`);
        if (tt >= timeline.total + 0.3) { finished = true; clearInterval(iv); resolve(); return; }
        requestAnimationFrame(step);
      };
      // timer de segurança: continua mesmo se o rAF for pausado pelo navegador
      const iv = setInterval(step, 100);
      requestAnimationFrame(step);
    });

    rec.stop();
    await recDone;
    actx.close(); actxTmp.close();
    donePhase('render');
    setProgress(100, 'Pronto!');

    const blob = new Blob(chunks, { type: mime || 'video/webm' });
    const url = URL.createObjectURL(blob);
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    const slug = (project.title || topic).toLowerCase().normalize('NFD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 40);
    $('#resultVideo').src = url;
    const dl = $('#btnDownload');
    dl.href = url; dl.download = `voxlab-${slug}.${ext}`;
    renderScriptView(project);
    $('#progressCard').classList.add('hidden');
    $('#resultCard').classList.remove('hidden');
    $('#resultCard').scrollIntoView({ behavior: 'smooth' });
    toast('🎬 Vídeo gerado com sucesso!');
  } catch (e) {
    console.error(e);
    if (e.status === 400 || e.status === 403) toast('Chave Gemini inválida — confira nas configurações ⚙️', 6000);
    else if (e.status === 429) toast('Limite diário do Gemini atingido. Tente de novo mais tarde.', 6000);
    else toast('Erro: ' + e.message, 6000);
    $('#progressCard').classList.add('hidden');
  } finally {
    busy = false;
    $('#btnGenerate').disabled = false;
  }
}

function renderScriptView(project) {
  const box = $('#scriptView');
  box.innerHTML = '';
  const h = document.createElement('div');
  h.className = 'script-block';
  h.innerHTML = `<b>TÍTULO</b><br>${escapeHtml(project.title || '')}`;
  box.appendChild(h);
  project.blocks.forEach((b, i) => {
    const d = document.createElement('div');
    d.className = 'script-block';
    d.innerHTML = `<b>Bloco ${i + 1} · ${b.scene.type}</b><br>${escapeHtml(b.narration)}`;
    box.appendChild(d);
  });
}
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

/* ---------- Settings ---------- */
function openSettings() {
  $('#inpKey').value = settings.key || '';
  $('#inpElKey').value = settings.elKey || '';
  $('#settingsModal').classList.remove('hidden');
}
function saveSettings() {
  settings.key = $('#inpKey').value.trim();
  settings.elKey = $('#inpElKey').value.trim();
  localStorage.setItem(LS, JSON.stringify(settings));
  $('#settingsModal').classList.add('hidden');
  toast(settings.key ? '🔑 Chave salva!' : 'Chave removida');
}

/* ---------- Eventos ---------- */
$('#btnGenerate').addEventListener('click', generate);
$('#btnSettings').addEventListener('click', openSettings);
$('#btnSaveKey').addEventListener('click', saveSettings);
$('#btnCloseSettings').addEventListener('click', () => $('#settingsModal').classList.add('hidden'));
$('#btnScriptToggle').addEventListener('click', () => $('#scriptView').classList.toggle('hidden'));
$('#btnAgain').addEventListener('click', () => {
  $('#resultCard').classList.add('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
if (!settings.key) setTimeout(() => toast('👋 Bem-vindo! Toque em ⚙️ e cole sua chave Gemini grátis para começar.', 6000), 800);
