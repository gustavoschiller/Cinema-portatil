const $ = (id) => document.getElementById(id);

const el = {
  lobby: $('lobby'), stage: $('stage'), video: $('video'),
  room: $('room'), nick: $('nick'),
  btnHost: $('btn-host'), btnGuest: $('btn-guest'),
  lobbyStatus: $('lobby-status'),
  badge: $('badge'), peers: $('peers'),
  overlay: $('overlay'), overlayText: $('overlay-text'),
  chat: $('chat'), log: $('log'), chatForm: $('chat-form'), chatInput: $('chat-input'),
  unmute: $('unmute'),
  audio: $('audio-badge'), warn: $('warn'), warnText: $('warn-text'),
  btnSource: $('btn-source'),
};

let ws = null;
let pc = null;
let localStream = null;
let isHost = false;
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
let myName = 'anon';
let pendingIce = [];

// ---------- lobby ----------

const saved = localStorage.getItem('cinema');
if (saved) {
  const { room, nick } = JSON.parse(saved);
  el.room.value = room || '';
  el.nick.value = nick || '';
}

el.btnHost.onclick = () => start(true);
el.btnGuest.onclick = () => start(false);
el.room.addEventListener('keydown', (e) => e.key === 'Enter' && start(true));

async function start(host) {
  const room = el.room.value.trim().toLowerCase();
  if (!room) {
    el.lobbyStatus.textContent = 'Escolha um nome de sala.';
    return;
  }
  myName = el.nick.value.trim() || (host ? 'anfitriao' : 'convidado');
  isHost = host;
  localStorage.setItem('cinema', JSON.stringify({ room, nick: myName }));

  el.btnHost.disabled = el.btnGuest.disabled = true;

  if (host) {
    try {
      el.lobbyStatus.textContent = 'Escolha a janela/guia para compartilhar...';
      localStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
        },
      });
    } catch (err) {
      el.lobbyStatus.textContent = 'Compartilhamento cancelado: ' + err.message;
      el.btnHost.disabled = el.btnGuest.disabled = false;
      return;
    }
    const atrack = localStream.getAudioTracks()[0];
    if (atrack) {
      // desliga o processamento de voz: queremos musica/filme, nao chamada
      atrack.contentHint = 'music';
    }
    // se ele parar o compartilhamento pelo botao do Chrome, volta pro lobby
    localStream.getVideoTracks()[0].addEventListener('ended', () => leave());
  }

  try {
    const res = await fetch('/config');
    const cfg = await res.json();
    if (cfg.iceServers && cfg.iceServers.length) iceServers = cfg.iceServers;
  } catch { /* usa o STUN padrao */ }

  connect(room);
}

// ---------- sinalizacao ----------

function connect(room) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', room, name: myName }));
    el.lobby.classList.add('hidden');
    el.stage.classList.remove('hidden');
    el.badge.textContent = isHost ? '\u{1F534} transmitindo' : '\u{1F440} assistindo';

    if (isHost) {
      el.video.srcObject = localStream;
      el.video.muted = true; // evita eco/microfonia no proprio PC
      el.overlay.classList.add('hidden');
      el.btnSource.classList.remove('hidden');
      checkHostAudio();
    } else {
      el.overlayText.textContent = 'Esperando a transmissao...';
    }
    startAudioWatch();
  };

  ws.onclose = () => {
    el.overlay.classList.remove('hidden');
    el.overlayText.textContent = 'Conexao com o servidor caiu. Recarregue a pagina.';
  };

  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);

    switch (msg.type) {
      case 'joined':
        updatePeers(msg.peers);
        if (isHost && msg.peers > 1) makeOffer();
        break;

      case 'peer-joined':
        sys(msg.name + ' entrou');
        updatePeers(2);
        if (isHost) makeOffer();
        break;

      case 'peer-left':
        sys(msg.name + ' saiu');
        updatePeers(1);
        if (!isHost) {
          el.overlay.classList.remove('hidden');
          el.overlayText.textContent = 'A transmissao parou.';
        }
        break;

      case 'offer':
        await onOffer(msg.sdp);
        break;

      case 'answer':
        if (pc && pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(msg.sdp);
          await drainIce();
        }
        break;

      case 'ice':
        if (!pc || !pc.remoteDescription) pendingIce.push(msg.candidate);
        else await pc.addIceCandidate(msg.candidate).catch(() => {});
        break;

      case 'chat':
        addMsg(msg.name, msg.text);
        break;
    }
  };
}

const signal = (obj) => ws && ws.readyState === 1 && ws.send(JSON.stringify(obj));

// ---------- WebRTC ----------

function newPeer() {
  if (pc) pc.close();
  pendingIce = [];
  pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });

  pc.onicecandidate = (e) => e.candidate && signal({ type: 'ice', candidate: e.candidate });

  pc.ontrack = (e) => {
    if (el.video.srcObject !== e.streams[0]) {
      el.video.srcObject = e.streams[0];
      tryPlay();
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') {
      el.overlay.classList.add('hidden');
      el.peers.textContent = 'conectado';
    } else if (s === 'failed') {
      el.overlay.classList.remove('hidden');
      el.overlayText.textContent =
        'Nao foi possivel conectar direto (NAT restritivo). E preciso um servidor TURN.';
    } else if (s === 'disconnected') {
      el.peers.textContent = 'reconectando...';
    }
  };

  return pc;
}

// O Opus do WebRTC vem mono e ~32 kbps por padrao, afinado pra voz.
// Para filme isso soa terrivel, entao pedimos estereo e bitrate alto no SDP.
function opusEstereo(sdp) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/);
  if (!m) return sdp;
  const pt = m[1];
  const extras = 'stereo=1;sprop-stereo=1;maxaveragebitrate=256000;useinbandfec=1';
  const fmtp = new RegExp('a=fmtp:' + pt + ' (.*)');
  if (fmtp.test(sdp)) {
    return sdp.replace(fmtp, (_full, params) => {
      let p = params;
      for (const kv of extras.split(';')) {
        const key = kv.split('=')[0];
        if (!new RegExp('(^|;)' + key + '=').test(p)) p += ';' + kv;
      }
      return 'a=fmtp:' + pt + ' ' + p;
    });
  }
  return sdp.replace(
    'a=rtpmap:' + pt + ' opus/48000/2',
    'a=rtpmap:' + pt + ' opus/48000/2\r\na=fmtp:' + pt + ' ' + extras
  );
}

// aplica o munging; se o navegador recusar, cai de volta no SDP original
async function setLocal(desc) {
  try {
    await pc.setLocalDescription({ type: desc.type, sdp: opusEstereo(desc.sdp) });
  } catch {
    await pc.setLocalDescription(desc);
  }
}

async function makeOffer() {
  newPeer();
  for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

  // prioriza qualidade de imagem sobre framerate e libera bitrate alto
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    const p = sender.getParameters();
    p.encodings = [{ maxBitrate: 6000000 }];
    p.degradationPreference = 'maintain-resolution';
    await sender.setParameters(p).catch(() => {});
  }

  // tira o teto de bitrate do audio tambem
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'audio') continue;
    const p = sender.getParameters();
    p.encodings = [{ maxBitrate: 256000 }];
    await sender.setParameters(p).catch(() => {});
  }

  const offer = await pc.createOffer();
  await setLocal(offer);
  signal({ type: 'offer', sdp: pc.localDescription });
}

async function onOffer(sdp) {
  newPeer();
  await pc.setRemoteDescription(sdp);
  await drainIce();
  const answer = await pc.createAnswer();
  await setLocal(answer);
  signal({ type: 'answer', sdp: pc.localDescription });
}

async function drainIce() {
  for (const c of pendingIce) await pc.addIceCandidate(c).catch(() => {});
  pendingIce = [];
}

// navegador bloqueia audio automatico: tenta tocar, senao pede um clique
async function tryPlay() {
  el.video.muted = false;
  el.video.volume = 1;
  try {
    await el.video.play();
    if (el.video.muted) throw new Error('mudo');
    el.unmute.classList.add('hidden');
  } catch {
    el.video.muted = true;
    await el.video.play().catch(() => {});
    el.unmute.classList.remove('hidden');
  }
}

$('btn-unmute').onclick = async () => {
  el.video.muted = false;
  el.video.volume = 1;
  await el.video.play().catch(() => {});
  el.unmute.classList.add('hidden');
};

// ---------- diagnostico de audio ----------

function warn(html) {
  el.warnText.innerHTML = html;
  el.warn.classList.remove('hidden');
}

function checkHostAudio() {
  if (localStream.getAudioTracks().length > 0) return true;
  el.audio.textContent = 'sem audio';
  el.audio.classList.add('bad');
  warn(
    'Voce esta compartilhando <b>sem audio</b> — ela nao vai ouvir nada.<br>' +
    'Clique em <b>Trocar fonte</b> e, na janela do Chrome:<br>' +
    '&bull; aba <b>Guia do Chrome</b> &rarr; marque <b>Compartilhar audio da guia</b><br>' +
    '&bull; ou aba <b>Tela inteira</b> &rarr; marque <b>Compartilhar audio do sistema</b><br>' +
    'A aba <b>Janela</b> nunca envia audio.'
  );
  return false;
}

let lastBytes = 0;
let audioTimer = null;

function startAudioWatch() {
  clearInterval(audioTimer);
  audioTimer = setInterval(async () => {
    if (!pc || pc.connectionState !== 'connected') return;
    const stats = await pc.getStats().catch(() => null);
    if (!stats) return;

    let bytes = null;
    stats.forEach((r) => {
      if (isHost && r.type === 'outbound-rtp' && r.kind === 'audio') bytes = r.bytesSent;
      if (!isHost && r.type === 'inbound-rtp' && r.kind === 'audio') bytes = r.bytesReceived;
    });

    if (bytes === null) {
      el.audio.textContent = isHost ? 'sem audio' : 'ele nao envia audio';
      el.audio.classList.add('bad');
      if (!isHost) {
        warn('A transmissao chegou <b>sem faixa de audio</b>. Quem transmite precisa recompartilhar marcando a opcao de audio.');
      }
      return;
    }

    const fluindo = bytes > lastBytes;
    lastBytes = bytes;

    if (!fluindo) {
      el.audio.textContent = 'audio parado';
      el.audio.classList.add('bad');
      return;
    }

    el.audio.classList.remove('bad');
    el.warn.classList.add('hidden');

    if (isHost) {
      el.audio.textContent = 'audio enviando';
    } else if (el.video.muted) {
      el.audio.textContent = 'audio chegando (mudo)';
      el.unmute.classList.remove('hidden');
    } else {
      el.audio.textContent = 'audio ok';
    }
  }, 2000);
}

// trocar a fonte sem sair da sala (util quando esqueceu de marcar o audio)
async function changeSource() {
  let novo;
  try {
    novo = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      },
    });
  } catch {
    return;
  }

  localStream.getTracks().forEach((t) => t.stop());
  localStream = novo;
  const atrack = localStream.getAudioTracks()[0];
  if (atrack) atrack.contentHint = 'music';
  localStream.getVideoTracks()[0].addEventListener('ended', () => leave());

  el.video.srcObject = localStream;
  el.audio.classList.remove('bad');
  el.warn.classList.add('hidden');
  lastBytes = 0;
  checkHostAudio();

  // renegocia do zero com a fonte nova
  makeOffer();
}

$('btn-source').onclick = () => changeSource();
$('warn-close').onclick = () => el.warn.classList.add('hidden');

// ---------- UI ----------

function updatePeers(n) {
  el.peers.textContent = n > 1 ? '2 na sala' : 'sozinho na sala';
}

function addMsg(who, text) {
  const div = document.createElement('div');
  div.className = 'msg';
  const w = document.createElement('span');
  w.className = 'who';
  w.textContent = who + ':';
  const t = document.createElement('span');
  t.textContent = ' ' + text;
  div.append(w, t);
  el.log.append(div);
  el.log.scrollTop = el.log.scrollHeight;
  if (el.chat.classList.contains('hidden')) el.chat.classList.remove('hidden');
}

function sys(text) {
  const div = document.createElement('div');
  div.className = 'msg sys';
  div.textContent = text;
  el.log.append(div);
  el.log.scrollTop = el.log.scrollHeight;
}

el.chatForm.onsubmit = (e) => {
  e.preventDefault();
  const text = el.chatInput.value.trim();
  if (!text) return;
  signal({ type: 'chat', text });
  addMsg(myName, text);
  el.chatInput.value = '';
};

$('btn-chat').onclick = () => el.chat.classList.toggle('hidden');
$('btn-full').onclick = () =>
  document.fullscreenElement ? document.exitFullscreen() : el.stage.requestFullscreen();
$('btn-leave').onclick = () => leave();

el.video.addEventListener('dblclick', () => $('btn-full').click());

function leave() {
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  if (pc) pc.close();
  if (ws) ws.close();
  location.reload();
}
