// Servidor estático mínimo para testes locais do VoxLab
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
function pipeRemote(url, res, depth) {
  if (depth > 3) { res.writeHead(508); res.end(); return; }
  https.get(url, (pr) => {
    if (pr.statusCode >= 300 && pr.statusCode < 400 && pr.headers.location) { pipeRemote(pr.headers.location, res, depth + 1); return; }
    res.writeHead(pr.statusCode, { 'Content-Type': pr.headers['content-type'] || 'application/octet-stream' });
    pr.pipe(res);
  }).on('error', () => { res.writeHead(502); res.end(); });
}
const ROOT = __dirname;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  // recebe um vídeo gerado e salva em /videos (uso local apenas)
  if (req.method === 'POST' && p === '/save') {
    const name = (new URLSearchParams(req.url.split('?')[1] || '').get('name') || 'video.mp4').replace(/[^\w.-]/g, '_');
    const dir = path.join(ROOT, 'videos');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    const out = fs.createWriteStream(path.join(dir, name));
    req.pipe(out);
    req.on('end', () => { res.writeHead(200); res.end('ok'); });
    return;
  }
  // proxy simples p/ mídia externa (uso local apenas)
  if (req.method === 'GET' && p === '/proxy') {
    const target = new URLSearchParams(req.url.split('?')[1] || '').get('url') || '';
    if (!/^https:\/\//.test(target)) { res.writeHead(400); res.end(); return; }
    pipeRemote(target, res, 0);
    return;
  }
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(8734, () => console.log('VoxLab em http://localhost:8734'));
