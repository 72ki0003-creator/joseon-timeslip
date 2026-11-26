// 朝鮮タイムスリップ 同時参加サーバー
// ・学校のPCで動かす（同じWi-Fiの人が参加）
// ・インターネット上のサーバー（Render など）に置く（どこからでも「部屋コード」で参加）
// のどちらにも使えます。Claude のアカウントは不要。必要なのは Node.js だけ（npm install 不要）。
//
// 使い方:  node server.js        （ポートを変えるとき: PORT=8090 node server.js）
//
// しくみ:
//   GET  /              ゲーム本体（同じフォルダの index.html）
//   GET  /mp/hello      このサーバーかどうかの確認
//   GET  /mp/stream     同じ部屋の参加者全員の状態を 1秒に約10回 届ける（Server-Sent Events）
//   POST /mp/state      自分の状態（位置・向き・身分・ニックネーム）を送る
//   GET  /mp/peers      同じ部屋の参加者（/mp/stream が使えない回線のための予備。0.3秒ごとに取りに来る）
//   POST /mp/bye        ページを閉じたときの退出
// インターネットに公開する:  node server.js --public
//   Cloudflare の「Quick Tunnel」（アカウント不要・無料）で https://〜.trycloudflare.com の URL を作ります。
//   このPCが起動していて、この画面が開いている間だけ使えます。URL は起動するたびに変わります。
// 部屋は「部屋コード」（英数字4〜8文字）で分かれます。同じコードを入れた人どうしだけが見えます。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC = process.argv.includes('--public') || process.env.PUBLIC === '1';
const MAX_PER_ROOM = Number(process.env.MAX_PLAYERS) || 60;   // 1部屋の上限
const MAX_TOTAL = Number(process.env.MAX_TOTAL) || 600;        // サーバー全体の上限
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 100;
const MAX_STREAMS_PER_IP = Number(process.env.MAX_STREAMS_PER_IP) || 120; // 学校は1つのIPから大勢つながる
const TICK_MS = 100;
const EXPIRE_MS = 15000;
const MAX_BODY = 1024;
const ID_RE = /^[a-z0-9]{8,24}$/;
const ROOM_RE = /^[A-Z0-9]{4,8}$/;
const DEFAULT_ROOM = 'OPEN';
const CLASSES = ['royal', 'yangban', 'jungin', 'commoner'];

const INDEX = path.join(__dirname, 'index.html');
if (!fs.existsSync(INDEX)) {
  console.error('index.html が見つかりません。server.js と同じフォルダに置いてください。');
  process.exit(1);
}

// rooms: code -> { players: Map(id -> {p, t}), streams: Map(id -> res), lastSent }
const rooms = new Map();
const left = new Map();        // 退出した id -> 時刻（遅れて届いた状態で復活させない）
const ipStreams = new Map();   // IP -> 接続数
let total = 0;

function roomOf(code, create) {
  let r = rooms.get(code);
  if (!r && create) {
    if (rooms.size >= MAX_ROOMS) return null;
    r = { players: new Map(), streams: new Map() };
    rooms.set(code, r);
  }
  return r;
}
function normRoom(v) {
  const c = String(v || '').toUpperCase();
  return c === '' ? DEFAULT_ROOM : (ROOM_RE.test(c) ? c : null);
}
function clientIp(req) {
  // Render などの前段がある場合は X-Forwarded-For の先頭を使う
  const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return f || req.socket.remoteAddress || '?';
}

function clean(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v * 100) / 100)) : null);
  const n = String(raw.n ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, 12);
  const x = num(raw.x, -60, 70), z = num(raw.z, -90, 70);
  if (!n || x === null || z === null) return null;
  return {
    n, x, z,
    c: CLASSES.includes(raw.c) ? raw.c : 'commoner',
    g: raw.g === 'm' || raw.g === 'f' ? raw.g : '',
    s: typeof raw.s === 'string' && /^[a-z]{1,16}$/.test(raw.s) ? raw.s : 'w',
    r: num(raw.r, -100, 100) ?? 0,
    v: num(raw.v, 0, 2) ?? 0,
  };
}

function readBody(req, cb) {
  let size = 0; const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    try { cb(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch (e) { cb(null); }
  });
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('id') || '';
  const code = normRoom(url.searchParams.get('room'));

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(INDEX).pipe(res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, '{"ok":true}');
  if (req.method === 'GET' && url.pathname === '/mp/hello') {
    return send(res, 200, JSON.stringify({ app: 'joseon-timeslip', v: 2, rooms: true }));
  }
  if (req.method === 'GET' && url.pathname === '/mp/stream') {
    if (!ID_RE.test(id) || !code) return send(res, 400, '{"error":"bad request"}');
    const ip = clientIp(req);
    if ((ipStreams.get(ip) || 0) >= MAX_STREAMS_PER_IP) return send(res, 429, '{"error":"too many"}');
    const room = roomOf(code, true);
    if (!room) return send(res, 503, '{"error":"busy"}');
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    // つながったことがすぐわかるように、今の参加者を最初に1回送る
    res.write(`data: ${JSON.stringify({ room: code, peers: [...room.players].map(([pid, x]) => ({ id: pid, p: x.p })) })}\n\n`);
    const old = room.streams.get(id);
    if (old) old.end();
    room.streams.set(id, res);
    res.lastSent = '';
    ipStreams.set(ip, (ipStreams.get(ip) || 0) + 1);
    req.on('close', () => {
      if (room.streams.get(id) === res) room.streams.delete(id);
      ipStreams.set(ip, Math.max(0, (ipStreams.get(ip) || 1) - 1));
      if (!ipStreams.get(ip)) ipStreams.delete(ip);
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/mp/peers') {
    if (!ID_RE.test(id) || !code) return send(res, 400, '{"error":"bad request"}');
    const room = rooms.get(code);
    const pl = room && room.players.get(id);
    if (pl) pl.t = Math.max(pl.t, Date.now() - 1000);
    return send(res, 200, JSON.stringify({ room: code, peers: room ? [...room.players].map(([pid, x]) => ({ id: pid, p: x.p })) : [] }));
  }
  if (req.method === 'POST' && url.pathname === '/mp/state') {
    if (!ID_RE.test(id) || !code) { req.resume(); return send(res, 400, '{"error":"bad request"}'); }
    if (left.has(id)) { req.resume(); return send(res, 410, '{"error":"left"}'); }
    const room = roomOf(code, true);
    if (!room) { req.resume(); return send(res, 503, '{"error":"busy"}'); }
    const isNew = !room.players.has(id);
    if (isNew && (room.players.size >= MAX_PER_ROOM || total >= MAX_TOTAL)) { req.resume(); return send(res, 503, '{"error":"full"}'); }
    readBody(req, (raw) => {
      const p = clean(raw);
      if (!p) return send(res, 400, '{"error":"bad state"}');
      const pl = room.players.get(id);
      const now = Date.now();
      // 送りすぎの抑制（1人1秒に30回まで）
      if (pl && now - pl.t < 33) return send(res, 429, '{"error":"slow down"}');
      if (!room.players.has(id)) { total++; console.log(`${time()} 参加: ${p.n}（部屋 ${code}・${room.players.size + 1}人）`); }
      room.players.set(id, { p, t: now });
      send(res, 204, '');
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/mp/bye') {
    req.resume();
    if (ID_RE.test(id)) {
      for (const [c, room] of rooms) {
        if (room.players.has(id)) {
          console.log(`${time()} 退出: ${room.players.get(id).p.n}（部屋 ${c}）`);
          room.players.delete(id);
          total--;
        }
      }
      left.set(id, Date.now());
    }
    return send(res, 204, '');
  }
  send(res, 404, '{"error":"not found"}');
});

// 部屋ごとに全員の状態を配る（変わったときだけ）。古い人は退出、空の部屋は片付ける
setInterval(() => {
  const now = Date.now();
  for (const [id, t] of left) if (now - t > 60000) left.delete(id);
  for (const [code, room] of rooms) {
    for (const [id, pl] of room.players) {
      if (room.streams.has(id)) { pl.t = Math.max(pl.t, now - 1000); continue; }
      if (now - pl.t > EXPIRE_MS) { console.log(`${time()} 退出（通信なし）: ${pl.p.n}（部屋 ${code}）`); room.players.delete(id); total--; }
    }
    if (!room.players.size && !room.streams.size) { rooms.delete(code); continue; }
    const data = JSON.stringify({ room: code, peers: [...room.players].map(([id, pl]) => ({ id, p: pl.p })) });
    for (const res of room.streams.values()) {
      if (res.lastSent === data) continue;
      res.lastSent = data;
      res.write(`data: ${data}\n\n`);
    }
  }
}, TICK_MS);
setInterval(() => { for (const room of rooms.values()) for (const res of room.streams.values()) res.write(': keep\n\n'); }, 15000);

function time() { return new Date().toTimeString().slice(0, 8); }

server.listen(PORT, '0.0.0.0', () => {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${PORT}`);
  }
  console.log('');
  console.log('  朝鮮タイムスリップ 同時参加サーバーが起動しました');
  console.log('');
  console.log(`  このPCで開く:        http://localhost:${PORT}`);
  if (urls.length) {
    console.log('  ほかのPC・スマホで開く（同じWi-Fiにつないでください）:');
    for (const u of urls) console.log(`      ${u}`);
  }
  console.log('');
  console.log('  ゲームの最初の画面で「部屋コード」を入れると、同じコードの人だけが同じ街に入ります。');
  console.log('  終了するときは、この画面で Ctrl + C を押してください。');
  console.log('');
  if (PUBLIC) startTunnel();
  else console.log('  違うWi-Fiや家からも参加できるようにするには:  node server.js --public\n');
});

// ---------- インターネットに公開（Cloudflare Quick Tunnel） ----------
// cloudflared（Cloudflare 公式の小さなプログラム）を使います。なければ公式の配布元から自動でダウンロードします。
const https = require('https');
const { spawn, execFileSync } = require('child_process');
function tunnelAsset() {
  const a = os.arch();
  if (process.platform === 'darwin') return { file: `cloudflared-darwin-${a === 'arm64' ? 'arm64' : 'amd64'}.tgz`, tgz: true, bin: 'cloudflared' };
  if (process.platform === 'win32') return { file: `cloudflared-windows-${a === 'ia32' ? '386' : 'amd64'}.exe`, bin: 'cloudflared.exe' };
  if (process.platform === 'linux') return { file: `cloudflared-linux-${a === 'arm64' ? 'arm64' : a === 'arm' ? 'arm' : 'amd64'}`, bin: 'cloudflared' };
  return null;
}
function download(url, dest, cb, hops = 0) {
  https.get(url, { headers: { 'User-Agent': 'joseon-timeslip' } }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 8) { res.resume(); return download(new URL(res.headers.location, url).href, dest, cb, hops + 1); }
    if (res.statusCode !== 200) { res.resume(); return cb(new Error(`HTTP ${res.statusCode}`)); }
    const total = Number(res.headers['content-length']) || 0;
    let got = 0, lastPct = -10;
    const out = fs.createWriteStream(dest);
    res.on('data', (c) => { got += c.length; const pct = total ? Math.floor((got / total) * 100) : 0; if (total && pct >= lastPct + 10) { lastPct = pct; process.stdout.write(`\r  ダウンロード中… ${pct}%   `); } });
    res.pipe(out);
    out.on('finish', () => { process.stdout.write('\n'); out.close(() => cb(null)); });
    out.on('error', cb);
  }).on('error', cb);
}
function findCloudflared(cb) {
  const asset = tunnelAsset();
  if (!asset) return cb(new Error('この OS には対応していません'));
  // 1) すでにインストールされている cloudflared
  try { execFileSync(process.platform === 'win32' ? 'where' : 'which', ['cloudflared'], { stdio: 'ignore' }); return cb(null, 'cloudflared'); } catch (e) { /* なければダウンロード */ }
  // 2) このフォルダの中に前にダウンロードしたもの
  const dir = path.join(__dirname, 'cloudflared');
  const bin = path.join(dir, asset.bin);
  if (fs.existsSync(bin)) return cb(null, bin);
  fs.mkdirSync(dir, { recursive: true });
  const url = process.env.CLOUDFLARED_URL || `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset.file}`;
  console.log('  インターネット公開用のプログラム（cloudflared）を、Cloudflare 公式の配布元からダウンロードします（初回だけ）。');
  console.log(`    ${url}`);
  const dest = asset.tgz ? path.join(dir, asset.file) : bin;
  download(url, dest, (err) => {
    if (err) return cb(err);
    try {
      if (asset.tgz) { execFileSync('tar', ['-xzf', dest, '-C', dir]); fs.unlinkSync(dest); }
      if (process.platform !== 'win32') fs.chmodSync(bin, 0o755);
    } catch (e) { return cb(e); }
    cb(null, bin);
  });
}
function startTunnel() {
  console.log('  インターネット公開の準備をしています…');
  findCloudflared((err, bin) => {
    if (err) {
      console.log(`  公開用のプログラムを用意できませんでした（${err.message}）。`);
      console.log('  同じWi-Fiの中では、上の URL で遊べます。');
      return;
    }
    let shown = false;
    const child = spawn(bin, ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const look = (buf) => {
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(String(buf));
      if (!m || shown) return;
      shown = true;
      const u = m[0];
      const line = '='.repeat(64);
      console.log('');
      console.log(line);
      console.log('  インターネットに公開しました（違うWi-Fi・家・スマホの回線からも参加できます）');
      console.log('');
      console.log(`      ${u}`);
      console.log('');
      console.log('  この URL と「部屋コード」を参加する人に伝えてください。');
      console.log(`  例:  ${u}/?room=ABCD  （ABCD を自分の部屋コードに変える）`);
      console.log('  ・この画面を閉じる／PCがスリープすると使えなくなります。');
      console.log('  ・URL は起動するたびに変わります。');
      console.log(line);
      console.log('');
      try { fs.writeFileSync(path.join(__dirname, '公開URL.txt'), `${u}\n`); } catch (e) { /* 書けなくてもよい */ }
    };
    child.stdout.on('data', look);
    child.stderr.on('data', look);
    child.on('exit', (code) => { if (!shown) console.log(`  公開に失敗しました（cloudflared が終了: ${code}）。インターネットにつながっているか確かめてください。`); else console.log('  インターネット公開が止まりました。'); });
    const stop = () => { try { child.kill(); } catch (e) { /* 止まっていてもよい */ } process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`ポート ${PORT} は使用中です。別の番号で起動してください（例: PORT=8090 node server.js）`);
  else console.error(e);
  process.exit(1);
});
