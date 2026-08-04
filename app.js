/* ============================================================
   VOXLAB — Fábrica de Documentários estilo Vox
   100% no navegador: Gemini (roteiro/imagens/voz) + Wikimedia
   + motor de animação em Canvas + exportação de vídeo.
   ============================================================ */
'use strict';

/* ---------- Config ---------- */
const PAL = {
  paper: '#F4EEE1', paper2: '#E9E0CC', yellow: '#FFD100', navy: '#12294B',
  coral: '#FF5A45', ink: '#14181F', white: '#FFFFFF'
};
const FIELD_BG = { yellow: PAL.yellow, paper: PAL.paper, navy: PAL.navy, coral: PAL.coral };
const FIELD_FG = { yellow: PAL.ink, paper: PAL.ink, navy: PAL.paper, coral: PAL.paper };
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
    "colorField": "yellow|paper|navy|coral",
    "label": "etiqueta curta da cena (2-4 palavras, MAIÚSCULAS)",
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
Use "colorField" variado (navy para momentos tensos, yellow/paper para dados, coral no máximo 1 vez).`;
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
    const bg = FIELD_BG[scene.colorField];
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = ctx.createPattern(this.noise, 'repeat'); ctx.fillRect(0, 0, W, H);
    // patch de halftone no canto
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = ctx.createPattern(scene.colorField === 'navy' ? this.htPaper : this.htInk, 'repeat');
    ctx.beginPath(); ctx.arc(W * 0.92, H * 0.1, Math.min(W, H) * 0.3, 0, 7); ctx.fill();
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

  subtitles(blk, p) {
    const narr = blk.block.narration || '';
    if (!narr) return;
    const { ctx, W, H, u } = this;
    const words = narr.split(/\s+/);
    const per = 7;
    const chunks = [];
    for (let i = 0; i < words.length; i += per) chunks.push(words.slice(i, i + per).join(' '));
    const idx = Math.min(chunks.length - 1, Math.floor(p * chunks.length));
    const text = chunks[idx];
    const fs = 30 * u;
    ctx.font = this.font(fs);
    // quebra em linhas
    const maxW = W * 0.86;
    const lines = [];
    let line = '';
    for (const w of text.split(' ')) {
      const t2 = line ? line + ' ' + w : w;
      if (ctx.measureText(t2).width > maxW && line) { lines.push(line); line = w; }
      else line = t2;
    }
    if (line) lines.push(line);
    const lh = fs * 1.5;
    let y = H * (this.vert ? 0.84 : 0.86) - (lines.length - 1) * lh;
    const enter = easeOutCubic(seg(p * chunks.length - idx, 0, 0.18));
    for (const ln of lines) {
      const tw = ctx.measureText(ln).width;
      ctx.save();
      ctx.globalAlpha = enter;
      ctx.translate(W / 2, y + (1 - enter) * 14 * u);
      ctx.fillStyle = PAL.ink;
      ctx.fillRect(-tw / 2 - 14 * u, -fs * 0.78, tw + 28 * u, fs * 1.42);
      ctx.fillStyle = PAL.white; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(ln, 0, 0);
      ctx.restore();
      y += lh;
    }
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

  /* ---- CENA: FOTO DE ARQUIVO ---- */
  scene_photo(blk, tb, p) {
    const { ctx, W, H, u } = this;
    const img = this.assets[blk.index];
    const enter = easeOutBack(seg(tb, 0.05, 0.6));
    const zoom = 1 + 0.07 * p;
    const fw = Math.min(W * 0.8, H * 0.62);
    const fh = fw * 0.78;
    const bx = W / 2 + (1 - enter) * W * 0.9;
    const by = H * (this.vert ? 0.42 : 0.46);
    ctx.save();
    ctx.translate(bx, by); ctx.rotate(-0.045); ctx.scale(zoom, zoom);
    // sombra + moldura polaroid
    ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 26 * u; ctx.shadowOffsetY = 12 * u;
    ctx.fillStyle = '#fff';
    const bord = fw * 0.045;
    ctx.fillRect(-fw / 2, -fh / 2, fw, fh + bord * 2.2);
    ctx.shadowColor = 'transparent';
    // imagem (crop cover)
    const iw = fw - bord * 2, ih = fh - bord * 2;
    if (img) {
      const r = Math.max(iw / img.width, ih / img.height);
      const sw = iw / r, sh = ih / r;
      ctx.save();
      ctx.beginPath(); ctx.rect(-iw / 2, -fh / 2 + bord, iw, ih); ctx.clip();
      ctx.filter = 'saturate(0.75) contrast(1.05)';
      ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, -iw / 2, -fh / 2 + bord, iw, ih);
      ctx.filter = 'none';
      ctx.restore();
    } else {
      ctx.fillStyle = PAL.paper2; ctx.fillRect(-iw / 2, -fh / 2 + bord, iw, ih);
      ctx.font = this.font(ih * 0.4); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(blk.block.scene.stack?.emoji || '🗞️', 0, -fh / 2 + bord + ih / 2);
    }
    // fitas
    const ta = easeOutBack(seg(tb, 0.55, 0.85));
    if (ta > 0) {
      ctx.save(); ctx.globalAlpha = ta;
      this.tape(-fw / 2 + bord, -fh / 2 + bord * 0.4, fw * 0.22, fw * 0.055, -0.5);
      this.tape(fw / 2 - bord, -fh / 2 + bord * 0.4, fw * 0.22, fw * 0.055, 0.55);
      ctx.restore();
    }
    ctx.restore();
    // alfinete cai
    const ps = seg(tb, 0.4, 0.62);
    if (ps > 0) {
      const drop = easeOutBack(ps);
      this.pin(bx, by - fh / 2 * zoom + (1 - drop) * -H * 0.2, drop * 1.35 * u);
    }
    // círculo de marcador
    this.markerEllipse(bx, by, fw * 0.58, fh * 0.58, seg(p, 0.55, 0.85),
      blk.block.scene.colorField === 'coral' ? PAL.ink : PAL.coral);
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
    words.forEach((w, i) => {
      const t0 = 0.15 + i * 0.22;
      const a = easeOutBack(seg(tb, t0, t0 + 0.35));
      if (a <= 0) return;
      const y = y0 + i * lh;
      const tw = ctx.measureText(w).width;
      // barra de destaque varre
      const sweep = easeOutCubic(seg(tb, t0 - 0.06, t0 + 0.22));
      ctx.fillStyle = i % 2 === 0 ? PAL.yellow : PAL.coral;
      if (scene.colorField === 'yellow') ctx.fillStyle = i % 2 === 0 ? PAL.white : PAL.coral;
      ctx.fillRect(W / 2 - tw / 2 - 12 * u, y - fs * 0.62, (tw + 24 * u) * sweep, fs * 1.18);
      ctx.save();
      ctx.translate(W / 2, y); ctx.scale(a, a);
      ctx.fillStyle = fg === PAL.paper ? PAL.ink : PAL.ink;
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

  /* ---- CENA: ROTA ---- */
  scene_route(blk, tb, p) {
    const { ctx, W, H, u } = this;
    const scene = blk.block.scene;
    const y = H * (this.vert ? 0.42 : 0.46);
    const ax = W * 0.2, bx2 = W * 0.8;
    // continentes de papel rasgado
    ctx.fillStyle = 'rgba(20,24,31,.09)';
    this.blob(ax, y + H * 0.05, W * 0.24);
    this.blob(bx2, y + H * 0.03, W * 0.2);
    // rota tracejada desenhando
    const prog = easeOutCubic(seg(tb, 0.35, 0.8));
    const cpx = W / 2, cpy = y - H * 0.16;
    ctx.strokeStyle = PAL.coral; ctx.lineWidth = 7 * u; ctx.setLineDash([18 * u, 14 * u]); ctx.lineCap = 'round';
    ctx.beginPath();
    for (let s = 0; s <= prog; s += 0.02) {
      const x = (1 - s) * (1 - s) * ax + 2 * (1 - s) * s * cpx + s * s * bx2;
      const yy = (1 - s) * (1 - s) * y + 2 * (1 - s) * s * cpy + s * s * y;
      s === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
    }
    ctx.stroke(); ctx.setLineDash([]);
    // ponto viajante
    if (prog > 0.02) {
      const s = prog;
      const x = (1 - s) * (1 - s) * ax + 2 * (1 - s) * s * cpx + s * s * bx2;
      const yy = (1 - s) * (1 - s) * y + 2 * (1 - s) * s * cpy + s * s * y;
      ctx.fillStyle = PAL.ink;
      ctx.beginPath(); ctx.arc(x, yy, 12 * u, 0, 7); ctx.fill();
    }
    // pinos + etiquetas
    const pa = easeOutBack(seg(tb, 0.1, 0.35));
    const pb = easeOutBack(seg(tb, 0.75, 0.98));
    if (pa > 0) { this.pin(ax, y, pa * 1.3 * u); this.routeLabel(scene.route.from, ax, y + 40 * u, pa); }
    if (pb > 0) { this.pin(bx2, y, pb * 1.3 * u); this.routeLabel(scene.route.to, bx2, y + 40 * u, pb); }
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
    ctx.fillStyle = PAL.navy; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = ctx.createPattern(this.noise, 'repeat'); ctx.fillRect(0, 0, W, H);
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
    /* 1 — pesquisa */
    setPhase('research'); setProgress(4, 'Pesquisando fatos na web…');
    let research = '';
    try {
      research = await gemText(
        `Pesquise fatos verificáveis sobre: "${topic}". Liste em tópicos: números-chave, datas, lugares, nomes, uma virada contraintuitiva e comparações concretas. Seja factual e denso. Responda em português.`,
        { search: true }
      );
    } catch (e) { console.warn('pesquisa falhou', e); }
    donePhase('research');

    /* 2 — roteiro */
    setPhase('script'); setProgress(14, 'Escrevendo o roteiro estilo Vox…');
    const project = await makeScript(topic, seconds, research);
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
    if (voice !== 'none') {
      let quotaRetries = 0;
      for (let i = 0; i < project.blocks.length; i++) {
        setProgress(45 + (i / project.blocks.length) * 18, `Narração ${i + 1}/${project.blocks.length}…`);
        const line = project.blocks[i].narration;
        try {
          const { bytes, rate } = await gemTTS(
            'Narre como documentarista, tom grave, calmo e envolvente, em português do Brasil: ' + line,
            voice
          );
          voiceBuffers[i] = pcmToAudioBuffer(actxTmp, bytes, rate);
        } catch (e) {
          console.warn('TTS falhou bloco ' + i, e);
          if (e.status === 429) {
            // no máx. 2 esperas; se a cota diária acabou, segue sem narração
            if (quotaRetries < 2) { quotaRetries++; setProgress(null, 'Limite de voz atingido, aguardando 25s…'); await sleep(25000); i--; continue; }
            toast('⚠️ Cota diária de voz esgotada — o vídeo sairá sem narração (renova amanhã).', 7000);
            break;
          }
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
  $('#settingsModal').classList.remove('hidden');
}
function saveSettings() {
  settings.key = $('#inpKey').value.trim();
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
