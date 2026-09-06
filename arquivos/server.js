import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const MAX_PEERS = Number(process.env.MAX_PEERS || 4);

// Teto de salas simultaneas. Hospedado num endereco publico, sem isso alguem
// pode abrir sala infinita e usar o servico como infra propria.
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 20);

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
    res.end(JSON.stringify({ iceServers, max: MAX_PEERS }));
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
// nome da sala -> { peers: Set<ws>, senha: string }
// A senha e escolhida por quem CRIA a sala. Vazia = sala aberta. Ela vive
// enquanto a sala tiver gente: esvaziou, some, e o proximo que entrar com esse
// nome cria a sala de novo e escolhe a senha dele.
const rooms = new Map();
let nextId = 1;

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, except) {
  const sala = rooms.get(room);
  if (!sala) return;
  for (const p of sala.peers) if (p !== except) send(p, msg);
}

function findPeer(room, id) {
  const sala = rooms.get(room);
  if (!sala) return null;
  for (const p of sala.peers) if (p.id === id) return p;
  return null;
}

// mensagens enderecadas a UM peer (negociacao ponto a ponto)
const DIRECT = new Set(['desc', 'ice']);
// mensagens que interessam a sala toda
const BROADCAST = new Set(['ids', 'state', 'chat']);

// O Cloudflare derruba WebSocket parado ha 100 segundos, e depois que a
// chamada negocia a sinalizacao nao tem mais nada a dizer. Sem esse
// batimento a sala "cai" sozinha uns dois minutos depois de conectar.
const BATIMENTO = 25000;

const batimento = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.vivo === false) {
      ws.terminate(); // nao respondeu ao ping anterior: socket morto
      continue;
    }
    ws.vivo = false;
    try { ws.ping(); } catch { /* ja fechando */ }
  }
}, BATIMENTO);

wss.on('close', () => clearInterval(batimento));

wss.on('connection', (ws) => {
  ws.id = String(nextId++);
  ws.room = null;
  ws.name = 'anon';
  ws.state = { mic: false, sharing: false };
  ws.vivo = true;

  ws.on('pong', () => { ws.vivo = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // batimento vindo do cliente: alguns proxies so contam trafego da aplicacao
    if (msg.type === 'ping') {
      ws.vivo = true;
      send(ws, { type: 'pong' });
      return;
    }

    if (msg.type === 'join') {
      if (ws.room) return;

      const room = String(msg.room || '').trim().toLowerCase().slice(0, 60);
      if (!room) return;

      // espaco e quebra de linha grudados em senha copiada nao contam
      const senha = String(msg.senha || '').trim().slice(0, 100);

      let sala = rooms.get(room);
      const criou = !sala;

      if (criou) {
        if (rooms.size >= MAX_ROOMS) {
          send(ws, { type: 'lotado' });
          return;
        }
        // primeiro a chegar define a senha da sala (vazia = sala aberta)
        sala = { peers: new Set(), senha };
        rooms.set(room, sala);
      } else if (sala.senha !== senha) {
        // 'aberta' distingue "errou a senha" de "digitou senha numa sala que
        // nao tem senha" - erros diferentes, avisos diferentes
        send(ws, { type: 'senha-errada', aberta: !sala.senha });
        // fecha em vez de deixar tentar de novo na mesma conexao: cada palpite
        // custa um handshake novo
        setTimeout(() => ws.close(), 50);
        return;
      }

      if (sala.peers.size >= MAX_PEERS) {
        // a sala acabou de ser criada por causa deste join; se ele nao entra,
        // nao pode ficar sala fantasma no mapa
        if (criou) rooms.delete(room);
        send(ws, { type: 'full', max: MAX_PEERS });
        return;
      }

      ws.room = room;
      ws.name = String(msg.name || 'anon').slice(0, 24);
      ws.state = {
        mic: !!(msg.state && msg.state.mic),
        sharing: false,
      };

      // quem ja esta na sala, para o recem-chegado abrir uma conexao com cada um
      send(ws, {
        type: 'welcome',
        id: ws.id,
        max: MAX_PEERS,
        criou,                       // criou a sala ou entrou numa existente
        temSenha: !!sala.senha,
        peers: [...sala.peers].map((p) => ({ id: p.id, name: p.name, state: p.state })),
      });

      broadcast(room, { type: 'peer-joined', id: ws.id, name: ws.name, state: ws.state }, ws);
      sala.peers.add(ws);
      return;
    }

    if (!ws.room) return;

    if (msg.type === 'state') {
      ws.state = {
        mic: !!msg.mic,
        sharing: !!msg.sharing,
      };
    }

    if (msg.type === 'chat') {
      msg.text = String(msg.text || '').slice(0, 300);
      if (!msg.text) return;
    }

    if (DIRECT.has(msg.type)) {
      const alvo = findPeer(ws.room, String(msg.to || ''));
      if (alvo) send(alvo, { ...msg, from: ws.id, name: ws.name });
      return;
    }

    if (BROADCAST.has(msg.type)) {
      broadcast(ws.room, { ...msg, from: ws.id, name: ws.name }, ws);
    }
  });

  ws.on('close', () => {
    const sala = rooms.get(ws.room);
    if (!sala) return;
    sala.peers.delete(ws);
    broadcast(ws.room, { type: 'peer-left', id: ws.id, name: ws.name }, ws);
    // sala vazia deixa de existir - e a senha dela vai junto
    if (sala.peers.size === 0) rooms.delete(ws.room);
  });
});

server.listen(PORT, () => {
  console.log(`\n  Cinema rodando em http://localhost:${PORT}  (ate ${MAX_PEERS} pessoas por sala)\n`);
});
