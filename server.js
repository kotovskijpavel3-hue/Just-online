'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8'
};

/* ---------- статика ---------- */

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

/* ---------- состояние комнаты ---------- */

/** id -> { id, name, color, x, y, comment, lastSeen } */
const users = new Map();

const PALETTE = [
  '#ff5c7c', '#38e8c8', '#ffd166', '#8b7bff',
  '#4cc9f0', '#ff8f4d', '#b6f36b', '#ff7bd5'
];

const ADJ = ['Быстрый', 'Тихий', 'Хитрый', 'Дерзкий', 'Лунный', 'Неоновый',
  'Сонный', 'Резкий', 'Пушистый', 'Космический', 'Ржавый', 'Стеклянный'];
const NOUN = ['Лис', 'Кит', 'Ёж', 'Барс', 'Кот', 'Ворон',
  'Спрут', 'Койот', 'Мотылёк', 'Дракон', 'Пингвин', 'Сурок'];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function makeName() {
  return `${pick(ADJ)} ${pick(NOUN)}`;
}

function makeColor(taken) {
  const free = PALETTE.filter((c) => !taken.includes(c));
  return free.length ? pick(free) : pick(PALETTE);
}

const clamp01 = (n) => (typeof n === 'number' && isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5);

function publicUser(u) {
  return { id: u.id, name: u.name, color: u.color, x: u.x, y: u.y, comment: u.comment };
}

/* ---------- websocket ---------- */

const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 });

function send(ws, type, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(Object.assign({ type }, payload)));
  }
}

function broadcast(type, payload, exceptId) {
  const data = JSON.stringify(Object.assign({ type }, payload));
  for (const [id, u] of users) {
    if (id === exceptId) continue;
    if (u.ws && u.ws.readyState === u.ws.OPEN) u.ws.send(data);
  }
}

wss.on('connection', (ws) => {
  const id = crypto.randomUUID().slice(0, 8);
  const taken = [...users.values()].map((u) => u.color);

  const user = {
    id,
    name: makeName(),
    color: makeColor(taken),
    x: 0.5,
    y: 0.5,
    comment: '',
    lastSeen: Date.now(),
    ws,
    alive: true
  };
  users.set(id, user);

  ws.on('pong', () => { user.alive = true; });

  send(ws, 'init', {
    you: publicUser(user),
    users: [...users.values()].filter((u) => u.id !== id).map(publicUser)
  });

  broadcast('join', { user: publicUser(user) }, id);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    user.lastSeen = Date.now();

    if (msg.type === 'cursor') {
      user.x = clamp01(msg.x);
      user.y = clamp01(msg.y);
      broadcast('move', { id, x: user.x, y: user.y }, id);
      return;
    }

    if (msg.type === 'comment') {
      const text = String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      user.comment = text;
      broadcast('comment', { id, text }, null);
      return;
    }

    if (msg.type === 'rename') {
      const name = String(msg.name || '').replace(/\s+/g, ' ').trim().slice(0, 28);
      if (!name) return;
      user.name = name;
      broadcast('rename', { id, name }, null);
    }
  });

  ws.on('close', () => {
    users.delete(id);
    broadcast('leave', { id }, null);
  });

  ws.on('error', () => {
    users.delete(id);
    broadcast('leave', { id }, null);
  });
});

// чистим мёртвые соединения
const heartbeat = setInterval(() => {
  for (const [id, u] of users) {
    if (!u.ws) continue;
    if (!u.alive) {
      users.delete(id);
      broadcast('leave', { id }, null);
      try { u.ws.terminate(); } catch { /* ignore */ }
      continue;
    }
    u.alive = false;
    try { u.ws.ping(); } catch { /* ignore */ }
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Just Online: http://localhost:${PORT}`);
});
