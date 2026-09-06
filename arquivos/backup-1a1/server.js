import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

process.title = 'Cinema - servidor';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
};

// TURN opcional (necessario quando os dois lados estao atras de NAT simetrico)
const iceServers = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];
if (process.env.TURN_URL) {
  iceServers.push({
    urls: process.env.TURN_URL.split(','),
    username: process.env.TURN_USER,
    credential: process.env.TURN_PASS,
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/config') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ iceServers }));
    return;
  }

  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.resolve(PUBLIC, '.' + path.normalize(file));
  if (!full.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404).end('nao encontrado');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

/** @type {Map<string, Set<import('ws').WebSocket>>} */
const rooms = new Map();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, except) {
  const peers = rooms.get(room);
  if (!peers) return;
  for (const p of peers) if (p !== except) send(p, msg);
}

wss.on('connection', (ws) => {
  ws.room = null;
  ws.name = 'anon';

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'join') {
      const room = String(msg.room || '').trim().toLowerCase();
      if (!room) return;
      ws.room = room;
      ws.name = String(msg.name || 'anon').slice(0, 24);
      if (!rooms.has(room)) rooms.set(room, new Set());
      const peers = rooms.get(room);
      // avisa quem ja esta na sala que chegou gente
      broadcast(room, { type: 'peer-joined', name: ws.name }, ws);
      peers.add(ws);
      send(ws, { type: 'joined', room, peers: peers.size });
      return;
    }

    if (!ws.room) return;

    // sinalizacao (offer/answer/ice) e chat: repassa para o outro lado
    if (['offer', 'answer', 'ice', 'chat', 'sync', 'bye'].includes(msg.type)) {
      broadcast(ws.room, { ...msg, name: ws.name }, ws);
    }
  });

  ws.on('close', () => {
    const peers = rooms.get(ws.room);
    if (!peers) return;
    peers.delete(ws);
    broadcast(ws.room, { type: 'peer-left', name: ws.name }, ws);
    if (peers.size === 0) rooms.delete(ws.room);
  });
});

server.listen(PORT, () => {
  console.log(`\n  Cinema rodando em http://localhost:${PORT}\n`);
});
