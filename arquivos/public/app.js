const $ = (id) => document.getElementById(id);

const el = {
  lobby: $('lobby'), stage: $('stage'), video: $('video'),
  room: $('room'), nick: $('nick'), btnEnter: $('btn-enter'),
  senha: $('senha'),
  lobbyStatus: $('lobby-status'),
  overlay: $('overlay'), overlayText: $('overlay-text'),
  chat: $('chat'), log: $('log'), chatForm: $('chat-form'), chatInput: $('chat-input'),
  unmute: $('unmute'), badge: $('badge'),
  warn: $('warn'), warnText: $('warn-text'),
  side: $('side'), people: $('people'), roomName: $('room-name'), count: $('count'),
  volFilm: $('vol-film'), volVoice: $('vol-voice'),
  vFilm: $('v-film'), vVoice: $('v-voice'),
  duck: $('duck'), ptt: $('ptt'),
  gate: $('gate'), gateTh: $('gate-th'), vGate: $('v-gate'), meterBar: $('meter-bar'),
  antieco: $('antieco'), vPiso: $('v-piso'),
  btnMic: $('btn-mic'), btnDeaf: $('btn-deaf'), btnShare: $('btn-share'),
  audios: $('audios'),
  diag: $('diag'), diagBody: $('diag-body'), diagVeredito: $('diag-veredito'),
  diagMsg: $('diag-msg'),
};

// ---------- estado ----------

let ws = null;
let pingTimer = null;
let saiu = false;          // o usuario clicou em sair: nao reconecta
let reconectando = false;
let tentativas = 0;
let myId = null;
let myName = 'anon';
let room = '';
let MAXP = 4;
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

let rawMic = null;         // o que o microfone capta, cru
let micChain = null;       // filtros + portao de ruido
let micStream = null;      // 1 faixa de audio: a sua voz, ja filtrada
let screenStream = null;   // tela + audio do filme (so quem transmite)
let sharerId = null;       // quem transmite agora ('me' se for voce)

let micOn = true;          // botao do microfone
let pttOn = false;         // modo "apertar pra falar"
let pttHeld = false;
let deaf = false;
let micAntesDoDeaf = true;

/** @type {Map<string, any>} */
const peers = new Map();

let audioCtx = null;
let myRow = null;
let falandoAgora = false;

let filmeAn = null;        // medidor do filme, usado pelo anti-eco
let filmeBuf = null;
let filmeStreamId = null;
let filmeSrc = null;

// ---------- WebKit: o Web Audio ROUBA o som ----------
//
// No Chrome da pra ligar a mesma faixa remota em dois lugares: o <audio>/<video>
// toca e um AnalyserNode mede em paralelo. No WebKit (todo navegador do iPhone,
// e o Safari do Mac) nao: assim que a faixa entra num createMediaStreamSource,
// ela sai do elemento e nao volta. O analisador fica com o som e o alto-falante
// fica com nada - o medidor mostrava -35 dB de filme com o iPhone mudo.
//
// A mesma cadeia quebra na saida: o createMediaStreamDestination do WebKit
// entrega uma faixa que muitas vezes nao carrega audio nenhum pro WebRTC, e a
// voz sai em 0 kbps pra sempre.
//
// Nos dois casos a saida e a mesma: no WebKit nao passa audio pelo Web Audio.
// O que se perde e medidor, portao e filtro caseiro - e o iPhone ja faz
// cancelamento de eco e supressao de ruido no proprio getUserMedia, que e a
// parte que importa. O que se ganha e o som.
const WEBKIT = (() => {
  const ua = navigator.userAgent;
  // iPad novo mente e diz que e Mac: touch no desktop entrega
  const ehIOS = /iPhone|iPad|iPod/.test(ua)
    || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const ehSafari = /Safari/.test(ua) && !/Chrome|Chromium|Android|CriOS|FxiOS|Edg/.test(ua);
  return ehIOS || ehSafari;
})();

const MIC_CONSTRAINTS = {
  audio: {
    echoCancellation: true,   // cancela o som do filme que sai do seu alto-falante
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
  video: false,
};

const TELA_CONSTRAINTS = {
  video: { frameRate: { ideal: 30, max: 60 } },
  audio: {
    // o filme nao e voz: qualquer processamento aqui destroi a trilha
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 2,
  },
};

// ---------- lobby ----------

const saved = localStorage.getItem('cinema');
if (saved) {
  try {
    const s = JSON.parse(saved);
    el.room.value = s.room || '';
    el.nick.value = s.nick || '';
    if (typeof s.gate === 'boolean') el.gate.checked = s.gate;
    if (typeof s.antieco === 'boolean') el.antieco.checked = s.antieco;
    if (typeof s.duck === 'boolean') el.duck.checked = s.duck;
    if (typeof s.ptt === 'boolean') el.ptt.checked = s.ptt;
    // o slider mudou de "dB absoluto" pra "margem acima do ruido": valor
    // negativo e de uma versao antiga, joga fora
    if (s.gateTh && Number(s.gateTh) > 0) el.gateTh.value = s.gateTh;
  } catch { /* ignora */ }
}
el.vGate.textContent = el.gateTh.value + ' dB';

el.btnEnter.onclick = () => entrar();
el.room.addEventListener('keydown', (e) => e.key === 'Enter' && entrar());
el.nick.addEventListener('keydown', (e) => e.key === 'Enter' && entrar());
el.senha.addEventListener('keydown', (e) => e.key === 'Enter' && entrar());

let cfgPronta = null;

async function pegarConfig() {
  if (cfgPronta) return cfgPronta;
  try {
    const cfg = await (await fetch('/config')).json();
    if (cfg.iceServers && cfg.iceServers.length) iceServers = cfg.iceServers;
    if (cfg.max) MAXP = cfg.max;
    cfgPronta = cfg;
    return cfg;
  } catch {
    return null; // usa o STUN padrao
  }
}

pegarConfig();

async function entrar() {
  room = el.room.value.trim().toLowerCase();
  if (!room) {
    el.lobbyStatus.textContent = 'Escolha um nome de sala.';
    return;
  }
  myName = el.nick.value.trim().slice(0, 24) || 'convidado';
  salvarPrefs();
  el.btnEnter.disabled = true;
  saiu = false; // pode estar true de uma tentativa com senha errada

  // o clique em "Entrar" e o gesto que libera audio automatico no navegador
  try {
    // um so por sessao: tentar de novo (senha errada) nao pode criar outro
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume().catch(() => {});
  } catch { audioCtx = null; }

  el.lobbyStatus.textContent = 'Pedindo o microfone...';
  try {
    rawMic = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    micStream = montarMic(rawMic);
    micStream.getAudioTracks()[0].contentHint = 'speech';
  } catch {
    rawMic = null;
    micStream = null;
    micOn = false;
  }

  await pegarConfig();

  conectar();
}

// ---------- sinalizacao ----------

const signal = (obj) => ws && ws.readyState === 1 && ws.send(JSON.stringify(obj));

function conectar() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host);

  ws.onopen = () => {
    signal({
      type: 'join', room, name: myName,
      senha: el.senha.value,
      state: { mic: micLive() },
    });
    // o tunel do Cloudflare fecha WebSocket parado ha 100 s, e depois que a
    // chamada negocia a sinalizacao fica muda. Esse ping segura a linha.
    clearInterval(pingTimer);
    pingTimer = setInterval(() => signal({ type: 'ping' }), 25000);
  };

  ws.onclose = () => {
    clearInterval(pingTimer);
    if (saiu || !myId) return;

    // O filme NAO passa por aqui: ele e ponto a ponto e continua rodando.
    // Entao nao tapa a tela - so avisa e tenta voltar sozinho.
    reconectando = true;
    el.badge.textContent = '⚠ reconectando...';
    el.badge.classList.add('bad');
    const espera = Math.min(1000 * Math.pow(2, tentativas++), 10000);
    setTimeout(() => { if (!saiu) conectar(); }, espera);
  };

  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    switch (msg.type) {
      case 'full':
        el.btnEnter.disabled = false;
        el.lobbyStatus.textContent = 'Essa sala ja esta cheia (' + msg.max + ' pessoas).';
        pararMic();
        ws.close();
        break;

      case 'senha-errada':
        saiu = true; // nao fica tentando reconectar com a senha errada
        el.btnEnter.disabled = false;
        el.lobbyStatus.textContent = msg.aberta
          ? 'Essa sala e aberta: deixe a senha em branco.'
          : 'Senha errada. Essa sala ja existe e tem outra senha.';
        el.senha.value = '';
        el.senha.focus();
        pararMic();
        break;

      case 'lotado':
        saiu = true;
        el.btnEnter.disabled = false;
        el.lobbyStatus.textContent =
          'O servidor esta com salas demais abertas. Tente daqui a pouco.';
        pararMic();
        break;

      case 'pong':
        break;

      case 'welcome': {
        const voltando = !!myId;
        myId = msg.id;
        MAXP = msg.max || MAXP;
        if (voltando) {
          // o servidor me deu um id novo: as conexoes velhas viraram fantasma
          for (const id of [...peers.keys()]) removePeer(id);
          reconectando = false;
          tentativas = 0;
          el.badge.classList.remove('bad');
          sys('Reconectado.');
        } else {
          abrirPalco();
          // dizer que a sala e nova pega o erro mais chato de todos: digitar o
          // nome errado e ficar esperando sozinho numa sala que so voce tem
          if (msg.criou) {
            const tipo = msg.temSenha ? 'com senha' : 'aberta, sem senha';
            el.overlayText.textContent =
              'Voce criou a sala "' + room + '" (' + tipo + '). Esperando as outras pessoas...';
            sys('Voce criou a sala "' + room + '" (' + tipo + ')');
          } else {
            sys('Voce entrou na sala "' + room + '"');
          }
        }
        for (const info of msg.peers) addPeer(info);
        anunciar();
        desenharPessoas();
        break;
      }

      case 'peer-joined':
        sys(msg.name + ' entrou');
        addPeer({ id: msg.id, name: msg.name, state: msg.state });
        anunciar();          // conta pro novato quais streams sao quais
        desenharPessoas();
        break;

      case 'peer-left':
        sys(msg.name + ' saiu');
        removePeer(msg.id);
        break;

      case 'desc':
        await onDesc(msg);
        break;

      case 'ice':
        await onIce(msg);
        break;

      case 'ids': {
        const p = peers.get(msg.from);
        if (!p) break;
        p.micStreamId = msg.mic || null;
        p.screenStreamId = msg.screen || null;
        resolverStreams(p);
        break;
      }

      case 'state': {
        const p = peers.get(msg.from);
        if (!p) break;
        p.mic = !!msg.mic;
        p.falando = !!msg.falando;   // referencia do anti-eco, ver tickGate
        if (typeof msg.nivel === 'number') p.nivelReportado = msg.nivel;
        const parou = p.sharing && !msg.sharing;
        p.sharing = !!msg.sharing;
        if (parou && sharerId === p.id) limparPalco(p.name + ' parou a transmissao.');
        desenharPessoas();
        atualizarBadge();
        break;
      }

      case 'chat':
        addMsg(msg.name, msg.text);
        break;
    }
  };
}

// avisa a sala qual stream e voz e qual e filme, e o estado dos botoes
function anunciar() {
  signal({
    type: 'ids',
    mic: micStream ? micStream.id : null,
    screen: screenStream ? screenStream.id : null,
  });
  signal({ type: 'state', mic: micLive(), sharing: !!screenStream });
}

function abrirPalco() {
  el.lobby.classList.add('hidden');
  el.stage.classList.remove('hidden');
  el.roomName.textContent = room;
  el.overlayText.textContent = 'Ninguem esta transmitindo ainda.';
  aplicarVolumes();
  atualizarMic();
  atualizarBadge();
  iniciarMedidor();
  if (WEBKIT) ajustarPainelWebkit();
  if (!micStream) {
    aviso('O microfone nao foi liberado - voce entrou <b>so ouvindo</b>.<br>' +
          'Para falar: libere o microfone nas permissoes do site e recarregue a pagina.');
  }
}

// No iPhone (e no Safari) metade destes controles e enfeite: o navegador nao
// deixa a pagina mexer no volume de um elemento de midia, e o Web Audio nao
// pode encostar nas faixas sem roubar o som delas. Deixar os controles ali,
// sem efeito, e o caminho mais curto pra pessoa achar que o problema e ela.
function ajustarPainelWebkit() {
  for (const alvo of [el.gate, el.antieco, el.duck, $('gate-wrap')]) {
    const cx = alvo === $('gate-wrap') ? alvo : alvo.closest('label');
    if (cx) cx.classList.add('hidden');
  }
  const nota = document.createElement('p');
  nota.className = 'nota-webkit';
  nota.innerHTML =
    'No <b>iPhone/Safari</b> quem manda no volume e o aparelho: os sliders acima ' +
    'nao tem efeito aqui. Se nao sai som, confira a <b>chavinha do silencioso</b>, ' +
    'os <b>botoes de volume enquanto o filme roda</b> e se ha fone/Bluetooth ' +
    'ligado.<br>Filtro e portao de microfone ficam desligados: o proprio iOS ja ' +
    'cancela eco e ruido.';
  el.volFilm.closest('.mixer').append(nota);
}

// ---------- peers (malha: uma conexao com cada pessoa) ----------

function addPeer({ id, name, state }) {
  if (peers.has(id) || id === myId) return peers.get(id);

  const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
  const p = {
    id, name: name || 'anon', pc,
    // regra fixa pra desempatar ofertas cruzadas (perfect negotiation)
    polite: Number(myId) > Number(id),
    makingOffer: false, ignoreOffer: false,
    pendingIce: iceOrfaos.get(id) || [], // o que chegou antes de eu existir
    streams: new Map(), micStreamId: null, screenStreamId: null,
    mic: !!(state && state.mic), sharing: !!(state && state.sharing),
    falando: false, nivelReportado: -120,
    muted: false, speaking: false, holdUntil: 0,
    audioEl: null, analyser: null, buf: null, nivel: 0,
    medSrc: null, medStreamId: null,
    // -1e9: "nunca avisei". Zero nao serve porque performance.now() comeca
    // do zero e o primeiro aviso ficaria travado pelos dois minutos iniciais.
    env: [], eco: 0, avisadoEm: -1e9,
    micSender: null, screenSenders: [], row: null,
  };
  peers.set(id, p);
  iceOrfaos.delete(id);

  pc.onicecandidate = (e) => e.candidate && signal({ type: 'ice', to: id, candidate: e.candidate });

  pc.onnegotiationneeded = () => { p.querOferta = true; oferecer(p); };

  // Quando a conexao volta pra 'stable', qualquer negociacao que ficou
  // pendente sai agora. Sem isso ela se perde pra sempre.
  pc.onsignalingstatechange = () => {
    if (pc.signalingState === 'stable' && p.querOferta) oferecer(p);
  };

  pc.ontrack = (e) => {
    const s = e.streams[0];
    if (!s) return;
    if (!p.streams.has(s.id)) {
      p.streams.set(s.id, s);
      s.addEventListener('removetrack', () => resolverStreams(p));
      s.addEventListener('addtrack', () => resolverStreams(p));
    }
    resolverStreams(p);
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') afinarSenders(p);
    if (s === 'failed') {
      p.falhas = (p.falhas || 0) + 1;
      try { pc.restartIce(); } catch { /* navegador antigo */ }
      sys('Conexao com ' + p.name + ' falhou. Tentando de novo (' + p.falhas + ')');

      // A segunda falha nao e mais azar de rede: e a conexao direta que nao
      // passa mesmo. Isso ficava escondido no chat, que comeca fechado.
      if (p.falhas >= 2) {
        aviso(
          'Nao consegui abrir conexao direta com <b>' + esc(p.name) + '</b>.<br>' +
          'O servidor so apresenta voces dois; o video e a voz tentam ir ' +
          'direto de um PC pro outro, e esse caminho nao passou - tipico de ' +
          'internet movel (4G) ou rede corporativa.<br>' +
          'Sem um servidor <b>TURN</b> configurado, nao ha o que fazer do lado ' +
          'de voces. Testem primeiro os dois no Wi-Fi de casa.'
        );
      }
    }
    desenharPessoas();
  };

  // suas faixas locais entram na conexao nova
  if (micStream) p.micSender = pc.addTrack(micStream.getAudioTracks()[0], micStream);
  if (screenStream) addScreenTo(p);

  return p;
}

function removePeer(id) {
  const p = peers.get(id);
  if (!p) return;
  try { p.pc.close(); } catch { /* ja fechada */ }
  if (p.audioEl) p.audioEl.remove();
  peers.delete(id);
  if (sharerId === id) limparPalco('A transmissao parou.');
  desenharPessoas();
  afinarTodos();
}

function addScreenTo(p) {
  p.screenSenders = [];
  const v = screenStream.getVideoTracks()[0];
  if (v) p.screenSenders.push(p.pc.addTrack(v, screenStream));
  const a = screenStream.getAudioTracks()[0];
  if (a) p.screenSenders.push(p.pc.addTrack(a, screenStream));
  afinarSenders(p);
}

function removeScreenFrom(p) {
  for (const s of p.screenSenders) {
    try { p.pc.removeTrack(s); } catch { /* ja removida */ }
  }
  p.screenSenders = [];
}

// ---------- negociacao ----------

// Candidatos que chegaram antes de o peer existir aqui. Nao da pra contar com
// a ordem: 'desc' e 'ice' podem passar na frente do aviso de 'peer-joined'.
const iceOrfaos = new Map();

// 'negotiationneeded' avisa UMA vez por mudanca. Se nesse instante a conexao
// nao estiver em 'stable' (ofertas que se cruzaram - comum quando o servidor
// de sinalizacao esta longe e a ida-e-volta passa de 100 ms), nao da pra
// simplesmente desistir: o aviso nao volta, e a faixa nova - a tela
// compartilhada, por exemplo - nunca chega do outro lado. Entao o pedido fica
// guardado em querOferta e sai quando a conexao permitir.
async function oferecer(p) {
  if (!p.querOferta || p.pc.signalingState !== 'stable') return;
  p.querOferta = false;
  try {
    p.makingOffer = true;
    const offer = await p.pc.createOffer();
    if (p.pc.signalingState !== 'stable') { p.querOferta = true; return; }
    await setLocal(p.pc, offer);
    signal({ type: 'desc', to: p.id, desc: p.pc.localDescription });
  } catch (err) {
    p.querOferta = true;
    console.warn('negociacao', err);
  } finally {
    p.makingOffer = false;
  }
}

// rede de seguranca, caso nenhum evento de mudanca de estado apareca
setInterval(() => {
  for (const p of peers.values()) if (p.querOferta) oferecer(p);
}, 3000);

async function onDesc(msg) {
  // negociacao de alguem que ainda nao anunciaram: cria a conexao na hora
  const p = peers.get(msg.from) || addPeer({ id: msg.from, name: msg.name });
  if (!p) return;
  const desc = msg.desc;
  const colisao = desc.type === 'offer' && (p.makingOffer || p.pc.signalingState !== 'stable');
  p.ignoreOffer = !p.polite && colisao;
  if (p.ignoreOffer) return;

  try {
    await p.pc.setRemoteDescription(desc);
    for (const c of p.pendingIce) await p.pc.addIceCandidate(c).catch(() => {});
    p.pendingIce = [];
    if (desc.type === 'offer') {
      const answer = await p.pc.createAnswer();
      await setLocal(p.pc, answer);
      signal({ type: 'desc', to: p.id, desc: p.pc.localDescription });
    }
  } catch (err) {
    console.warn('desc', err);
  }
}

async function onIce(msg) {
  const p = peers.get(msg.from);
  if (!p) {
    // guarda pra quando o peer aparecer, com teto pra nao virar lixo eterno
    if (iceOrfaos.size > 8) return;
    const fila = iceOrfaos.get(msg.from) || [];
    if (fila.length < 40) fila.push(msg.candidate);
    iceOrfaos.set(msg.from, fila);
    return;
  }
  if (!p.pc.remoteDescription) { p.pendingIce.push(msg.candidate); return; }
  try { await p.pc.addIceCandidate(msg.candidate); }
  catch (err) { if (!p.ignoreOffer) console.warn('ice', err); }
}

// O Opus do WebRTC vem mono e ~32 kbps por padrao, afinado pra voz. Para
// filme isso soa terrivel. Mas voz e filme sao faixas diferentes, entao cada
// uma leva o seu perfil: o filme ganha estereo e teto alto, a voz fica mono e
// barata (com DTX, que para de mandar pacote quando o portao fecha).
// 256 kbps era o teto anterior. Numa malha (cada um manda pra cada um) esse
// exagero e o primeiro a sofrer quando a subida entope: o Opus nao baixa a
// taxa do audio sozinho como o video baixa - ele so perde pacote, e o som
// some por meio segundo. 128 kbps estereo ja e transparente pra filme.
const OPUS_FILME = 'stereo=1;sprop-stereo=1;maxaveragebitrate=128000;useinbandfec=1';
const OPUS_VOZ = 'stereo=0;sprop-stereo=0;maxaveragebitrate=32000;useinbandfec=1;usedtx=1';

function mesclarFmtp(params, extras) {
  const chaves = extras.split(';').map((kv) => kv.split('=')[0]);
  const resto = params.split(';').filter((kv) => kv && !chaves.includes(kv.split('=')[0]));
  return resto.concat(extras.split(';')).join(';');
}

function afinarOpus(sdp) {
  const idMic = micStream ? micStream.id : null;
  return sdp.split(/(?=^m=)/m).map((sec) => {
    if (!sec.startsWith('m=audio')) return sec;
    const m = sec.match(/a=rtpmap:(\d+) opus\/48000\/2/);
    if (!m) return sec;
    const pt = m[1];
    // a secao que carrega o meu microfone e a da voz; o resto e filme
    const extras = idMic && sec.includes('a=msid:' + idMic) ? OPUS_VOZ : OPUS_FILME;
    const fmtp = new RegExp('a=fmtp:' + pt + ' (.*)');
    if (fmtp.test(sec)) {
      return sec.replace(fmtp, (_full, params) => 'a=fmtp:' + pt + ' ' + mesclarFmtp(params, extras));
    }
    return sec.replace(
      'a=rtpmap:' + pt + ' opus/48000/2',
      'a=rtpmap:' + pt + ' opus/48000/2\r\na=fmtp:' + pt + ' ' + extras
    );
  }).join('');
}

// aplica o munging; se o navegador recusar, cai de volta no SDP original
async function setLocal(pc, desc) {
  try {
    await pc.setLocalDescription({ type: desc.type, sdp: afinarOpus(desc.sdp) });
  } catch {
    await pc.setLocalDescription(desc);
  }
}

// Aqui nao existe servidor de midia: cada um manda uma copia inteira do video
// pra cada outra pessoa. Com 3 convidados, um teto de 1,8 Mbps por copia vira
// 5,4 Mbps de subida - mais do que quase toda internet de casa aguenta.
//
// Pior: cada RTCPeerConnection estima a banda por conta propria e nenhuma sabe
// das outras. Tres delas medem o MESMO cano e cada uma se acha dona dele. Da
// fila no roteador, e fila vira perda em rajada - o som do filme sumindo de
// tempos em tempos.
//
// Entao o teto e de subida TOTAL, dividido entre as copias.
const TETO_SUBIDA = 3000000; // bits/s de video, somando todas as copias

function bitrateVideo() {
  const n = Math.max(1, peers.size);
  return Math.max(600000, Math.round(TETO_SUBIDA / n));
}

async function afinarSenders(p) {
  const ajusta = async (sender, fn) => {
    if (!sender || !sender.track) return;
    const prm = sender.getParameters();
    if (!prm.encodings || !prm.encodings.length) prm.encodings = [{}];
    fn(prm);
    await sender.setParameters(prm).catch(() => {});
  };

  // networkPriority decide quem perde primeiro quando a banda acaba. Sem isso
  // o video - que come 20x mais - disputa de igual pra igual com o audio e
  // ganha, porque e ele que enche a fila.
  await ajusta(p.micSender, (prm) => {
    prm.encodings[0].maxBitrate = 40000;
    prm.encodings[0].networkPriority = 'high';
    prm.encodings[0].priority = 'high';
  });

  for (const s of p.screenSenders) {
    if (s.track && s.track.kind === 'video') {
      await ajusta(s, (prm) => {
        prm.encodings[0].maxBitrate = bitrateVideo();
        prm.encodings[0].networkPriority = 'low';
        prm.encodings[0].priority = 'low';
        // 'maintain-resolution' proibia encolher a imagem, entao o video
        // insistia numa banda que nao existia. 'balanced' deixa ele ceder
        // resolucao no aperto - e o audio passa inteiro.
        prm.degradationPreference = 'balanced';
      });
    } else {
      await ajusta(s, (prm) => {
        prm.encodings[0].maxBitrate = 128000;
        prm.encodings[0].networkPriority = 'high';
        prm.encodings[0].priority = 'high';
      });
    }
  }
}

function afinarTodos() {
  for (const p of peers.values()) afinarSenders(p);
}

// ---------- separar voz de filme ----------

function resolverStreams(p) {
  for (const [sid, s] of p.streams) {
    const temVideo = s.getVideoTracks().length > 0;
    // o anuncio 'ids' manda; sem ele, video = tela, so audio = voz
    const ehTela = p.screenStreamId ? sid === p.screenStreamId : temVideo;
    const ehVoz = p.micStreamId ? sid === p.micStreamId : (!ehTela && s.getAudioTracks().length > 0);

    if (ehTela) {
      if (temVideo) ligarTela(p, s);
      else if (sharerId === p.id) limparPalco(p.name + ' parou a transmissao.');
    } else if (ehVoz) {
      ligarVoz(p, s);
    }
  }
}

function ligarVoz(p, s) {
  if (p.audioEl && p.audioEl.srcObject === s) return;
  if (!p.audioEl) {
    p.audioEl = document.createElement('audio');
    p.audioEl.autoplay = true;
    p.audioEl.playsInline = true;
    el.audios.append(p.audioEl);
  }
  p.audioEl.srcObject = s;
  p.audioEl.play().catch(() => el.unmute.classList.remove('hidden'));
  aplicarVolumes();
  medidorPara(p, s);
}

function medidorFilme(s) {
  if (WEBKIT || !audioCtx) return;   // medir aqui deixaria o filme mudo
  if (filmeStreamId === s.id || s.getAudioTracks().length === 0) return;
  try {
    // o no de origem tem que ficar guardado: sem ninguem apontando pra ele o
    // Chrome coleta o no e o medidor passa a devolver silencio pra sempre -
    // e o silencio aqui faz o anti-eco achar que ninguem esta tocando nada
    filmeSrc = audioCtx.createMediaStreamSource(s);
    filmeAn = audioCtx.createAnalyser();
    filmeAn.fftSize = 512;
    filmeBuf = new Float32Array(filmeAn.fftSize);
    filmeSrc.connect(filmeAn);
    filmeStreamId = s.id;
  } catch { filmeAn = null; filmeSrc = null; }
}

function ligarTela(p, s) {
  sharerId = p.id;
  if (el.video.srcObject !== s) {
    el.video.srcObject = s;
    tocarVideo();
  }
  medidorFilme(s);
  el.overlay.classList.add('hidden');
  if (s.getAudioTracks().length === 0) {
    aviso(esc(p.name) + ' esta transmitindo <b>sem audio</b> - ninguem vai ouvir o filme.<br>' +
          'Peca pra clicar em <b>Parar</b>, depois <b>Transmitir</b> de novo, ' +
          'marcando <b>Compartilhar audio da guia</b>.');
  } else {
    el.warn.classList.add('hidden');
  }
  atualizarBadge();
}

function limparPalco(texto) {
  sharerId = null;
  filmeAn = null;
  filmeStreamId = null;
  filmeSrc = null;
  el.video.srcObject = null;
  el.video.muted = false;
  el.overlay.classList.remove('hidden');
  el.overlayText.textContent = texto || 'Ninguem esta transmitindo.';
  atualizarBadge();
}

// navegador bloqueia audio automatico: tenta tocar, senao pede um clique
async function tocarVideo() {
  el.video.muted = false;
  aplicarVolumes();
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
  await el.video.play().catch(() => {});
  for (const p of peers.values()) if (p.audioEl) p.audioEl.play().catch(() => {});
  if (audioCtx) audioCtx.resume().catch(() => {});
  aplicarVolumes();
  el.unmute.classList.add('hidden');
};

// ---------- transmitir a tela ----------

el.btnShare.onclick = () => (screenStream ? pararTransmissao() : comecarTransmissao());

async function comecarTransmissao() {
  const outro = [...peers.values()].find((p) => p.sharing);
  if (outro) {
    sys(outro.name + ' ja esta transmitindo. Peca pra parar antes.');
    return;
  }

  let s;
  try {
    s = await navigator.mediaDevices.getDisplayMedia(TELA_CONSTRAINTS);
  } catch {
    return; // cancelou a janela do navegador
  }

  screenStream = s;
  const a = s.getAudioTracks()[0];
  if (a) a.contentHint = 'music';
  const v = s.getVideoTracks()[0];
  if (v) {
    v.contentHint = 'detail';
    v.addEventListener('ended', () => pararTransmissao());
  }

  for (const p of peers.values()) addScreenTo(p);

  sharerId = 'me';
  el.video.srcObject = screenStream;
  el.video.muted = true; // o filme ja toca no seu PC: nao duplica nem realimenta
  el.overlay.classList.add('hidden');
  el.btnShare.classList.add('on');
  el.btnShare.textContent = '⏹ Parar';

  if (!a) {
    aviso(
      'Voce esta transmitindo <b>sem audio</b> - ninguem vai ouvir o filme.<br>' +
      'Clique em <b>Parar</b> e depois <b>Transmitir</b> de novo. Na janela do Chrome:<br>' +
      '&bull; aba <b>Guia do Chrome</b> &rarr; marque <b>Compartilhar audio da guia</b><br>' +
      '&bull; ou aba <b>Tela inteira</b> &rarr; marque <b>Compartilhar audio do sistema</b><br>' +
      'A aba <b>Janela</b> nunca envia audio.'
    );
  } else if (v && v.getSettings && v.getSettings().displaySurface === 'monitor') {
    // audio do sistema = tudo que sai da sua caixa de som, inclusive as vozes
    // da sala. Isso volta pra todo mundo e e a causa numero 1 do eco.
    aviso(
      'Voce escolheu <b>Tela inteira</b> com <b>audio do sistema</b>. Isso captura ' +
      'tambem as <b>vozes da sala</b> saindo do seu alto-falante e devolve pra todo ' +
      'mundo - e isso que faz as vozes ecoarem.<br>' +
      'Solucao: use <b>fone de ouvido</b>, ou pare e compartilhe pela aba ' +
      '<b>Guia do Chrome</b> marcando <b>Compartilhar audio da guia</b> ' +
      '(essa envia so o som do filme).'
    );
  } else {
    el.warn.classList.add('hidden');
  }

  anunciar();
  desenharPessoas();
  atualizarBadge();
}

function pararTransmissao() {
  if (!screenStream) return;
  screenStream.getTracks().forEach((t) => t.stop());
  for (const p of peers.values()) removeScreenFrom(p);
  screenStream = null;
  el.btnShare.classList.remove('on');
  el.btnShare.textContent = '\u{1F5A5} Transmitir';
  limparPalco('Voce parou a transmissao.');
  anunciar();
  desenharPessoas();
}

// ---------- microfone, surdina, apertar pra falar ----------

function micLive() {
  return !!micStream && micOn && !deaf && (!pttOn || pttHeld);
}

function atualizarMic() {
  const live = micLive();
  if (micStream) micStream.getAudioTracks().forEach((t) => { t.enabled = live; });
  el.btnMic.textContent = live ? '\u{1F399}' : '\u{1F507}';
  el.btnMic.classList.toggle('off', !live);
  el.btnMic.disabled = !micStream;
  if (myRow) myRow.classList.toggle('mudo', !live);
  const falando = live && !!(micChain && micChain.aberto);
  ultimoFalando = falando;
  signal({
    type: 'state', mic: live, sharing: !!screenStream,
    falando, nivel: Math.round(micChain ? micChain.nivelDb : -120),
  });
}

el.btnMic.onclick = () => { micOn = !micOn; atualizarMic(); desenharPessoas(); };

function alternarSurdina() {
  deaf = !deaf;
  if (deaf) { micAntesDoDeaf = micOn; micOn = false; }
  else { micOn = micAntesDoDeaf; }
  el.btnDeaf.classList.toggle('off', deaf);
  el.btnDeaf.textContent = deaf ? '\u{1F507}' : '\u{1F3A7}';
  atualizarMic();
  aplicarVolumes();
  desenharPessoas();
}

el.btnDeaf.onclick = () => alternarSurdina();

pttOn = el.ptt.checked;
el.ptt.onchange = () => { pttOn = el.ptt.checked; pttHeld = false; atualizarMic(); salvarPrefs(); };

const digitando = (e) => e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName);

addEventListener('keydown', (e) => {
  if (e.key === 'Control' && pttOn && !pttHeld) { pttHeld = true; atualizarMic(); }
  if (digitando(e) || el.stage.classList.contains('hidden')) return;
  if (e.key === 'm' || e.key === 'M') { micOn = !micOn; atualizarMic(); desenharPessoas(); }
  if (e.key === 'd' || e.key === 'D') alternarSurdina();
});

addEventListener('keyup', (e) => {
  if (e.key === 'Control' && pttOn && pttHeld) { pttHeld = false; atualizarMic(); }
});

addEventListener('blur', () => { if (pttHeld) { pttHeld = false; atualizarMic(); } });

function pararMic() {
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (rawMic) rawMic.getTracks().forEach((t) => t.stop());
  micStream = null;
  rawMic = null;
  micChain = null;
}

// ---------- filtro de ruido do microfone ----------
//
// O que sai daqui e o que os outros escutam. A cadeia e:
//
//   mic cru -> corta grave -> corta agudo -> compressor -> portao -> envio
//
// O corte de grave tira ronco de ventilador e batida na mesa; o de agudo tira
// chiado; o compressor equilibra quem fala longe do mic; o portao fecha o
// microfone quando voce esta calado - e o portao que mata o eco residual, o
// teclado e a TV do vizinho, porque nada disso passa do limiar.

function montarMic(raw) {
  if (!audioCtx) return raw;
  // WebKit: a saida do Web Audio chega vazia no WebRTC. Melhor o mic cru, que
  // ja vem com eco e ruido tratados pelo proprio sistema, do que voz muda.
  if (WEBKIT) { micChain = null; return raw; }
  try {
    const src = audioCtx.createMediaStreamSource(raw);

    // 1. corta grave: ronco de ventilador, ar condicionado, batida na mesa
    const hp = audioCtx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 85; hp.Q.value = 0.7;

    // 2. tira o "abafado" da faixa 200-400 Hz, onde a voz embola com o filme
    const lama = audioCtx.createBiquadFilter();
    lama.type = 'peaking'; lama.frequency.value = 300; lama.Q.value = 1; lama.gain.value = -3;

    // 3. presenca: e essa faixa que faz a voz ser ENTENDIDA por cima do filme
    const presenca = audioCtx.createBiquadFilter();
    presenca.type = 'peaking'; presenca.frequency.value = 2800; presenca.Q.value = 0.9;
    presenca.gain.value = 4;

    // 4. tira chiado e sibilancia acima da voz
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 10000;

    // 5. compressor: quem fala longe do microfone para de sumir
    const comp = audioCtx.createDynamicsCompressor();
    comp.threshold.value = -26; comp.knee.value = 24; comp.ratio.value = 4;
    comp.attack.value = 0.005; comp.release.value = 0.18;

    // 6. o portao (controlado pelo tickGate)
    const gate = audioCtx.createGain();
    gate.gain.value = 1;

    // 7. recupera o volume que o compressor tirou
    const makeup = audioCtx.createGain();
    makeup.gain.value = 1.6;

    // 8. limitador: makeup + compressor podem estourar; isso segura o teto
    const lim = audioCtx.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20;
    lim.attack.value = 0.001; lim.release.value = 0.05;

    const an = audioCtx.createAnalyser();
    an.fftSize = 512;

    // voz e mono: destino estereo dobraria a banda a troco de nada
    const dst = audioCtx.createMediaStreamDestination();
    dst.channelCount = 1;
    dst.channelCountMode = 'explicit';

    src.connect(hp); hp.connect(lama); lama.connect(presenca);
    presenca.connect(lp); lp.connect(comp);
    comp.connect(an);            // mede depois dos filtros, antes do portao
    comp.connect(gate); gate.connect(makeup); makeup.connect(lim); lim.connect(dst);

    micChain = {
      gate, an, buf: new Float32Array(an.fftSize),
      hold: 0, aberto: true,
      piso: -60,                 // estimativa do ruido de fundo, em dB
      eco: -60,                  // quanto do som dos outros volta pelo mic
      amostras: [], conta: 0,    // medidas do eco, ver tickGate
      nivelDb: -90,
    };
    return dst.stream;
  } catch {
    micChain = null;
    return raw; // sem Web Audio: manda o microfone cru, melhor que mudo
  }
}

function db(rms) {
  return 20 * Math.log10(Math.max(rms, 1e-6));
}

// Quanto som o SEU computador esta tocando agora: as vozes dos outros mais o
// filme, cada um no volume em que voce os deixou. E a referencia do anti-eco:
// se o microfone esta captando menos que isso, o que ele capta e a propria
// caixa de som voltando - nao a sua voz.
function referenciaDb() {
  if (deaf) return -120;
  let lin = 0;
  const vozes = Number(el.volVoice.value) / 100;
  for (const p of peers.values()) {
    if (p.muted) continue;
    lin = Math.max(lin, p.nivel * vozes);
  }
  if (filmeAn) lin = Math.max(lin, nivel(filmeAn, filmeBuf) * el.video.volume);
  return db(lin);
}

// No celular, medir o audio RECEBIDO pelo Web Audio quase sempre devolve
// silencio - a referenciaDb acima fica cega e o anti-eco nunca fecha o
// microfone. A saida e nao depender de medir: cada um ja sabe o proprio nivel
// e avisa por mensagem. O numero que ele manda e o mesmo que o analisador
// mediria do outro lado, porque e a mesma faixa de audio.
function referenciaAvisadaDb() {
  if (deaf) return -120;
  const vozes = Number(el.volVoice.value) / 100;
  const ajuste = 20 * Math.log10(Math.max(vozes, 0.0001)); // volume que voce escolheu
  let melhor = -120;
  for (const p of peers.values()) {
    if (p.muted || !p.falando) continue;
    melhor = Math.max(melhor, p.nivelReportado + ajuste);
  }
  return melhor;
}

let ultimoFalando = null;
let ultimoNivelAvisado = -120;
let ultimoAnuncioVoz = 0;

function anunciarVoz(falando, nivelDb) {
  const agora = performance.now();
  const mudouMuito = Math.abs(nivelDb - ultimoNivelAvisado) > 3;
  if (falando === ultimoFalando && !mudouMuito) return;
  if (agora - ultimoAnuncioVoz < 180) return; // teto de ~5 avisos por segundo
  ultimoFalando = falando;
  ultimoNivelAvisado = nivelDb;
  ultimoAnuncioVoz = agora;
  signal({
    type: 'state', mic: micLive(), sharing: !!screenStream,
    falando, nivel: Math.round(nivelDb),
  });
}

function tickGate() {
  if (!micChain) return;

  const agora = performance.now();

  // niveis dos outros primeiro: o medidor e o anti-eco usam os mesmos numeros
  for (const p of peers.values()) {
    if (p.analyser) p.nivel = nivel(p.analyser, p.buf);
  }

  const nivelDb = db(nivel(micChain.an, micChain.buf));
  micChain.nivelDb = nivelDb;

  // Piso de ruido automatico: desce depressa, sobe devagar, pra achar sozinho
  // o barulho da casa sem acompanhar a sua voz.
  //
  // O silencio digital NAO entra na conta. A supressao de ruido do proprio
  // navegador zera o sinal entre as palavras, e um piso que seguisse esses
  // zeros desabaria pro fundo da escala em menos de meio segundo. O limiar
  // ficaria absurdamente baixo e o portao abriria pra qualquer coisa -
  // inclusive pro eco, que e justamente o que ele deveria barrar.
  if (nivelDb > -95) {
    const passo = nivelDb < micChain.piso ? 0.02 : 0.0006;
    micChain.piso += (nivelDb - micChain.piso) * passo;
  }
  micChain.piso = Math.max(-85, Math.min(-25, micChain.piso));

  const margem = Number(el.gateTh.value);

  // Enquanto outra pessoa fala, exijo 12 dB a mais da sua voz. E o que impede
  // o alto-falante do celular de devolver a voz dela. Funciona mesmo quando a
  // medicao do audio recebido nao funciona - caso do navegador do celular.
  const limiar = micChain.piso + margem;
  micChain.limiar = limiar;

  // Alguem esta falando agora? Medido aqui (desktop) ou avisado por mensagem
  // (unico jeito que funciona no navegador do celular).
  const tocando = Math.max(referenciaDb(), referenciaAvisadaDb());
  const outroFalando = tocando > -70;

  // Quanto do som dos outros volta pelo SEU microfone nao da pra adivinhar:
  // depende de fone, caixa, volume, distancia - varia 40 dB entre aparelhos.
  // Entao a gente mede, guardando o seu nivel enquanto o outro fala.
  //
  // O truque esta em como resumir essas amostras. Media nao serve: se voce
  // falar junto, a sua voz entra na conta, a estimativa sobe e voce se tranca
  // pra fora - foi exatamente o que aconteceu na primeira versao disto.
  // O eco ACOMPANHA a fala do outro o tempo todo; a sua voz e esporadica e
  // fica na cauda alta. Entao usamos um percentil baixo, que ignora a cauda.
  if (outroFalando && nivelDb > -95) {
    micChain.amostras.push(nivelDb);
    if (micChain.amostras.length > 200) micChain.amostras.shift(); // ~5 s
  }

  micChain.conta = (micChain.conta + 1) % 10;
  if (micChain.conta === 0 && micChain.amostras.length >= 20) {
    const ord = [...micChain.amostras].sort((a, b) => a - b);
    micChain.eco = ord[Math.floor(ord.length * 0.3)];
  }

  // sem ninguem falando nao ha eco pra barrar; sem amostras ainda nao da pra
  // afirmar nada, entao nao atrapalha
  const temEstimativa = micChain.amostras.length >= 20;
  const passaEco = !el.antieco.checked || !outroFalando || !temEstimativa
    || nivelDb > micChain.eco + 8;

  if (nivelDb > limiar && passaEco) micChain.hold = agora + 300;
  const aberto = !el.gate.checked || agora < micChain.hold;

  anunciarVoz(aberto && micLive(), nivelDb);

  if (aberto !== micChain.aberto) {
    micChain.aberto = aberto;
    const g = micChain.gate.gain;
    const t = audioCtx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    // fechado nao e silencio absoluto: -34 dB soa natural, sem "bombear"
    g.linearRampToValueAtTime(aberto ? 1 : 0.02, t + (aberto ? 0.015 : 0.18));
  }

  const pct = Math.max(0, Math.min(100, ((nivelDb + 80) / 80) * 100));
  el.meterBar.style.width = pct + '%';
  el.meterBar.parentElement.classList.toggle('fechado', !aberto);
  el.vPiso.textContent = Math.round(micChain.piso) + ' dB';
}

function salvarPrefs() {
  localStorage.setItem('cinema', JSON.stringify({
    room, nick: myName,
    gate: el.gate.checked, gateTh: el.gateTh.value, antieco: el.antieco.checked,
    duck: el.duck.checked, ptt: el.ptt.checked,
  }));
}

el.gate.onchange = () => { salvarPrefs(); };
el.antieco.onchange = () => { salvarPrefs(); };
el.gateTh.oninput = () => {
  el.vGate.textContent = el.gateTh.value + ' dB';
  salvarPrefs();
};

// ---------- volumes e "quem esta falando" ----------

let volFilmeAlvo = 1;
let duckLigado = false;   // o filme esta abaixado agora?
let duckAte = 0;          // segura abaixado ate este instante

function aplicarVolumes() {
  const filme = Number(el.volFilm.value) / 100;
  const vozes = Number(el.volVoice.value) / 100;
  el.vFilm.textContent = el.volFilm.value + '%';
  el.vVoice.textContent = el.volVoice.value + '%';

  const abaixa = duckLigado ? 0.35 : 1;
  volFilmeAlvo = (deaf ? 0 : filme) * abaixa;

  for (const p of peers.values()) {
    if (p.audioEl) p.audioEl.volume = deaf || p.muted ? 0 : vozes;
  }
}

el.volFilm.oninput = () => aplicarVolumes();
el.volVoice.oninput = () => aplicarVolumes();
el.duck.onchange = () => { aplicarVolumes(); salvarPrefs(); };

// Antes isto media a PRIMEIRA faixa que aparecesse e nunca mais trocava. Se a
// negociacao entregasse o audio do filme antes do anuncio 'ids' chegar, o
// medidor ficava preso no filme: p.nivel virava o volume do filme, o abafador
// nunca soltava e o anti-eco entendia "tem gente falando o tempo todo" - o
// portao do seu microfone nao abria mais.
function medidorPara(p, s) {
  if (WEBKIT || !audioCtx) return;   // medir aqui deixaria a voz muda
  if (p.medStreamId === s.id) return;
  try {
    // guardar o no e obrigatorio: solto, o Chrome coleta e o medidor zera
    p.medSrc = audioCtx.createMediaStreamSource(s);
    p.analyser = audioCtx.createAnalyser();
    p.analyser.fftSize = 512;
    p.buf = new Float32Array(p.analyser.fftSize);
    p.nivel = 0;
    p.env = [];
    p.medSrc.connect(p.analyser); // analyser sem destino: so mede, nao toca
    p.medStreamId = s.id;
  } catch { p.analyser = null; p.medSrc = null; p.medStreamId = null; }
}

let meuAnalyser = null;
let meuSrc = null;
let meuBuf = null;
let meuHold = 0;

function iniciarMedidor() {
  // WEBKIT: derivar o microfone pro Web Audio esvazia a faixa que vai pro
  // WebRTC - era isso que deixava "minha voz indo" em 0 kbps no iPhone. Sem
  // medidor proprio o portao tambem nao roda, e nao faz falta: o iOS ja cancela
  // eco e ruido dentro do getUserMedia.
  if (audioCtx && micStream && !meuAnalyser && !WEBKIT) {
    try {
      meuSrc = audioCtx.createMediaStreamSource(micStream);
      meuAnalyser = audioCtx.createAnalyser();
      meuAnalyser.fftSize = 512;
      meuBuf = new Float32Array(meuAnalyser.fftSize);
      meuSrc.connect(meuAnalyser); // guardado, senao o Chrome coleta o no
    } catch { meuAnalyser = null; meuSrc = null; }
  }
  setInterval(medir, 100);
  setInterval(tickGate, 25); // o portao precisa reagir mais rapido que a UI
}

function nivel(analyser, buf) {
  analyser.getFloatTimeDomainData(buf);
  let soma = 0;
  for (let i = 0; i < buf.length; i++) soma += buf[i] * buf[i];
  return Math.sqrt(soma / buf.length);
}

function medir() {
  const agora = performance.now();
  let alguem = false;

  for (const p of peers.values()) {
    // Sem analisador (WebKit) o unico sinal de que essa pessoa esta falando e o
    // aviso que ela mesma manda pelo 'state'. Antes o laco desistia no
    // 'continue' e o iPhone nunca acendia nome nem acionava o abafador.
    const alto = p.analyser ? p.nivel > 0.02 : p.falando;
    if (!deaf && !p.muted && alto) p.holdUntil = agora + 350;
    const falando = agora < p.holdUntil;
    if (falando !== p.speaking) {
      p.speaking = falando;
      if (p.row) p.row.classList.toggle('speaking', falando);
    }
    if (falando) alguem = true;
  }

  if (meuAnalyser) {
    const meuNivel = nivel(meuAnalyser, meuBuf);
    if (micLive() && meuNivel > 0.02) meuHold = agora + 350;
    const eu = agora < meuHold;
    if (myRow) myRow.classList.toggle('speaking', eu);
    if (eu) alguem = true;
    // Sem cadeia de audio o tickGate nem roda, e e ele quem avisa "estou
    // falando". Sem esse aviso o anti-eco dos outros fica cego pra este aqui.
    if (!micChain) anunciarVoz(eu && micLive(), db(meuNivel));
  }

  falandoAgora = alguem;

  // O filme so volta 700 ms depois da ultima fala. Sem essa espera, cada
  // silabazinha - ou cada eco que abre o microfone de alguem - derruba o
  // volume e devolve logo em seguida. De longe soa como se o som do filme
  // ficasse sumindo sozinho de tempos em tempos.
  if (alguem) duckAte = agora + 700;
  const ligado = el.duck.checked && agora < duckAte;
  if (ligado !== duckLigado) { duckLigado = ligado; aplicarVolumes(); }

  // e a volta e bem mais lenta que a descida: abaixar rapido nao incomoda,
  // subir rapido chama atencao
  const v = el.video.volume;
  if (Math.abs(v - volFilmeAlvo) > 0.005) {
    const passo = volFilmeAlvo < v ? 0.3 : 0.05;
    el.video.volume = Math.max(0, Math.min(1, v + (volFilmeAlvo - v) * passo));
  }

  registrarEnvelopes();
}

// ---------- quem esta ecoando ----------
//
// Nenhum filtro do SEU lado conserta o eco: quem produz e o alto-falante da
// outra pessoa devolvendo a sua voz pro microfone dela. Da pra descobrir quem
// e: guardo o desenho do meu volume ao longo do tempo e comparo com o que
// volta de cada um, atrasado. Se bater forte num atraso fixo, achei o culpado.

const ENV_MAX = 120; // 12 s de historico, uma amostra a cada 100 ms
const meuEnv = [];

function registrarEnvelopes() {
  if (!micChain) return;
  meuEnv.push(micChain.aberto ? micChain.nivelDb : -90);
  if (meuEnv.length > ENV_MAX) meuEnv.shift();
  for (const p of peers.values()) {
    p.env.push(db(p.nivel));
    if (p.env.length > ENV_MAX) p.env.shift();
  }
}

function correlacao(a, b, atraso) {
  const n = Math.min(a.length, b.length) - atraso;
  if (n < 40) return 0;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i + atraso]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i + atraso] - mb;
    num += x * y; va += x * x; vb += y * y;
  }
  if (va < 1 || vb < 1) return 0;
  return num / Math.sqrt(va * vb);
}

function procurarEco() {
  if (!micChain || meuEnv.length < ENV_MAX) return;

  // so faz sentido comparar se eu realmente falei nesse trecho
  const falei = meuEnv.filter((v) => v > micChain.piso + 10).length;
  if (falei < 15) return;

  for (const p of peers.values()) {
    if (p.env.length < ENV_MAX) continue;

    let melhor = 0;
    for (let atraso = 1; atraso <= 8; atraso++) { // 100 ms a 800 ms
      melhor = Math.max(melhor, correlacao(meuEnv, p.env, atraso));
    }

    if (melhor > 0.62) p.eco = Math.min(6, p.eco + 1);
    else p.eco = Math.max(0, p.eco - 1);

    // tres deteccoes seguidas antes de acusar alguem, e no maximo uma vez
    // a cada dois minutos
    if (p.eco >= 3 && performance.now() - p.avisadoEm > 120000) {
      p.avisadoEm = performance.now();
      p.eco = 0;
      sys(p.name + ' esta devolvendo a sua voz (eco)');
      aviso(
        '<b>' + esc(p.name) + '</b> esta ecoando voce: a sua voz sai no ' +
        'alto-falante dessa pessoa e volta pelo microfone dela.<br>' +
        'Quem resolve e ela, <b>colocando fone de ouvido</b>. ' +
        'Mexer nas suas opcoes nao adianta.'
      );
    }
  }
}

setInterval(procurarEco, 4000);

// ---------- vigia do som que some ----------
//
// Quando o som do filme corta "de tempos em tempos", so existem duas
// explicacoes: ou alguem daqui abaixou o volume (o abafador, a surdina), ou o
// audio nao chegou. As duas soam igual pro ouvido, e so a segunda aparece nas
// estatisticas: concealedSamples conta as amostras que o navegador INVENTOU
// pra tapar buraco de pacote perdido. Passou de ~1% do que chegou, da pra
// ouvir. Passou de 3%, corta feio.

let avisoRedeEm = -1e9;

async function vigiarSom() {
  for (const p of peers.values()) {
    if (p.pc.connectionState !== 'connected') continue;

    let st;
    try { st = await p.pc.getStats(); } catch { continue; }

    // As duas faixas de audio caem na mesma peneira, e somar as duas estraga a
    // conta: a voz vai com DTX, entao quando o portao fecha ela PARA de mandar
    // pacote e o navegador conta esse silencio como amostra inventada. Com o
    // portao fechado a maior parte do tempo, a soma passava de 3% sozinha e o
    // aviso disparava com a rede inteira. Aqui so o filme e julgado, e o
    // silencio inventado de proposito (silentConcealedSamples) sai da conta.
    const idsVoz = p.audioEl && p.audioEl.srcObject
      ? p.audioEl.srcObject.getAudioTracks().map((t) => t.id) : [];

    let cortes = 0, amostras = 0, bytes = 0, achouFilme = false;
    st.forEach((r) => {
      if (r.type !== 'inbound-rtp' || r.kind !== 'audio') return;
      if (idsVoz.includes(r.trackIdentifier)) return;
      achouFilme = true;
      cortes += (r.concealedSamples || 0) - (r.silentConcealedSamples || 0);
      amostras += r.totalSamplesReceived || 0;
      bytes += r.bytesReceived || 0;
    });

    diagnosticarMudo(p, achouFilme ? bytes : null);

    // sem faixa de filme nao ha o que vigiar, e a conta velha nao serve mais
    if (!achouFilme) { p.somAnt = null; p.cortePct = undefined; continue; }

    const ant = p.somAnt;
    p.somAnt = { cortes, amostras };
    if (!ant) continue;

    const dAmostras = amostras - ant.amostras;
    if (dAmostras < 4000) continue; // quase nada chegou: nao da pra concluir
    // Math.max(0, ...): contador que reinicia (renegociacao, ICE restart) daria
    // delta negativo agora e um pico absurdo na leitura seguinte
    p.cortePct = (Math.max(0, cortes - ant.cortes) / dAmostras) * 100;

    if (p.cortePct > 3 && performance.now() - avisoRedeEm > 120000) {
      avisoRedeEm = performance.now();
      sys('Audio de ' + p.name + ' chegando picotado (' + p.cortePct.toFixed(1) + '% perdido)');
      aviso(
        'O som esta <b>se perdendo no caminho</b>, nao sendo abaixado por filtro.<br>' +
        'Mexer nas opcoes desta pagina nao resolve: falta banda entre voces.<br>' +
        '&bull; quem transmite deve estar no <b>cabo</b> ou perto do roteador;<br>' +
        '&bull; menos gente na sala = menos copias do video subindo;<br>' +
        '&bull; feche downloads e outras abas de video na maquina de quem transmite.'
      );
    }
  }
}

setInterval(vigiarSom, 2000);

// ---------- "nao sai som nenhum" ----------
//
// Quatro coisas diferentes soam exatamente igual: o audio do filme nao chega;
// chega e o navegador esta segurando o autoplay; chega e o volume daqui esta
// no chao; chega e vem mudo da origem (a pessoa compartilhou a aba errada).
// O aviso de rede acusava a rede em todos os quatro casos. Aqui cada um e
// medido, e so o culpado aparece.

let avisoMudoEm = -1e9;

function diagnosticarMudo(p, bytes) {
  if (sharerId !== p.id || bytes === null) {
    p.bytesFilmeAnt = undefined;
    p.semBytes = 0;
    p.semNivel = 0;
    return;
  }

  const ant = p.bytesFilmeAnt;
  p.bytesFilmeAnt = bytes;
  if (ant === undefined) return;

  // ~2 kbps de piso: abaixo disso nao esta chegando audio nenhum
  p.semBytes = bytes - ant > 500 ? 0 : (p.semBytes || 0) + 1;

  // silencio digital de verdade, nao cena calada: -75 dB por 30 s seguidos
  const mudoAgora = filmeAn && db(nivel(filmeAn, filmeBuf)) < -75;
  p.semNivel = mudoAgora ? (p.semNivel || 0) + 1 : 0;

  if (performance.now() - avisoMudoEm < 120000) return;
  // ligarTela ja avisa quando a transmissao vem sem faixa de audio nenhuma
  if (!el.video.srcObject || el.video.srcObject.getAudioTracks().length === 0) return;

  let texto = null;
  if (p.semBytes >= 3) {
    texto = 'A imagem passa, mas a <b>faixa de som do filme nao esta chegando</b> ' +
            'aqui.<br>Peca pra ' + esc(p.name) + ' clicar em <b>Parar</b> e ' +
            '<b>Transmitir</b> de novo.';
  } else if (el.video.muted) {
    el.unmute.classList.remove('hidden');
    texto = 'O som do filme esta chegando, mas o navegador <b>segurou o audio</b>.<br>' +
            'Clique em <b>Clique para ativar o som</b>, no meio da tela.';
  } else if (el.video.volume < 0.05) {
    texto = 'O som do filme esta chegando e o navegador esta tocando - o volume ' +
            '<b>daqui</b> e que esta no chao.<br>Confira o slider <b>Filme</b> e o ' +
            'botao de <b>surdina</b> (o fone, tecla D).';
  } else if (p.semNivel >= 15) {
    texto = 'O som do filme chega, mas vem <b>mudo da origem</b>.<br>' +
            esc(p.name) + ' compartilhou uma aba que nao esta tocando som. ' +
            'Tem que ser a aba do filme, com <b>Compartilhar audio da guia</b> marcado.';
  }
  if (!texto) return;

  avisoMudoEm = performance.now();
  sys('Som do filme mudo aqui - ver o aviso na tela');
  aviso(texto);
}

// Diagnostico: abra o console do navegador (F12) e digite  await cinemaDiag()
window.cinemaDiag = async () => {
  const pessoas = [];

  for (const p of peers.values()) {
    const info = {
      nome: p.name,
      conexao: p.pc.connectionState,     // 'connected' e o unico que presta
      ice: p.pc.iceConnectionState,
      nivelDb: +db(p.nivel).toFixed(1),
      falando: p.falando,                // avisado por ele, nao medido aqui
      nivelAvisadoDb: p.nivelReportado,
      eco: p.eco,
      mutado: p.muted,
      // % do audio que o navegador teve que inventar nos ultimos 2 s.
      // Acima de 1 da pra ouvir; acima de 3 o som corta feio. Se este numero
      // for zero e mesmo assim o som some, a causa e local (volume/filtro).
      cortePct: p.cortePct === undefined ? null : +p.cortePct.toFixed(2),
    };

    try {
      const st = await p.pc.getStats();
      const bytes = { recebeVoz: 0, recebeFilme: 0, recebeVideo: 0, mandaVoz: 0, mandaVideo: 0 };
      let par = null;

      // as duas faixas de audio caem na mesma peneira; sem separar, uma
      // sobrescreve a outra e o numero nao quer dizer nada
      const idsVoz = p.audioEl && p.audioEl.srcObject
        ? p.audioEl.srcObject.getAudioTracks().map((t) => t.id) : [];

      st.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') {
          const ehVoz = idsVoz.includes(r.trackIdentifier);
          if (ehVoz) bytes.recebeVoz = r.bytesReceived;
          else bytes.recebeFilme = r.bytesReceived;
          info[ehVoz ? 'voz' : 'filme'] = {
            perda: r.packetsLost,
            jitter: +(r.jitter || 0).toFixed(4),
            // amostras que o navegador INVENTOU porque o pacote nao chegou
            cortes: r.concealedSamples,
            amostras: r.totalSamplesReceived,
          };
        }
        if (r.type === 'inbound-rtp' && r.kind === 'video') bytes.recebeVideo = r.bytesReceived;
        if (r.type === 'outbound-rtp' && r.kind === 'audio') bytes.mandaVoz = r.bytesSent;
        if (r.type === 'outbound-rtp' && r.kind === 'video') bytes.mandaVideo = r.bytesSent;
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') par = r;
      });

      info.bytes = bytes;
      if (par) {
        const local = st.get(par.localCandidateId);
        const remoto = st.get(par.remoteCandidateId);
        // host = mesma rede, srflx = passou pelo STUN, relay = precisou de TURN
        info.caminho = (local ? local.candidateType : '?') + ' -> ' + (remoto ? remoto.candidateType : '?');
      } else {
        info.caminho = 'nenhum caminho fechou (ICE nao passou)';
      }
    } catch { info.bytes = 'sem estatisticas'; }

    pessoas.push(info);
  }

  // O navegador aceita o pedido de cancelamento de eco mas nem sempre entrega.
  // Varios navegadores de celular respondem 'false' aqui - e ai o unico
  // anti-eco que sobra e o nosso, feito na mao.
  let processamentoDoNavegador = 'sem microfone';
  if (rawMic && rawMic.getAudioTracks()[0]) {
    const t = rawMic.getAudioTracks()[0];
    const s = t.getSettings ? t.getSettings() : {};
    processamentoDoNavegador = {
      cancelamentoDeEco: s.echoCancellation,
      supressaoDeRuido: s.noiseSuppression,
      ganhoAutomatico: s.autoGainControl,
      dispositivo: t.label || '(sem nome)',
      taxa: s.sampleRate,
    };
  }

  return {
    sala: room,
    microfoneLiberado: !!micStream,
    processamentoDoNavegador,
    euTransmitindo: !!screenStream,
    recebendoTelaDe: sharerId,
    servidor: ws && ws.readyState === 1 ? 'conectado' : 'CAIDO',
    mic: micChain ? {
      nivelDb: +micChain.nivelDb.toFixed(1),
      piso: +micChain.piso.toFixed(1),
      limiar: +(micChain.limiar ?? micChain.piso + Number(el.gateTh.value)).toFixed(1),
      aberto: micChain.aberto,
      ecoAprendido: +micChain.eco.toFixed(1),
      ganho: +micChain.gate.gain.value.toFixed(3),
    } : 'sem cadeia de audio (microfone negado?)',
    referenciaDb: +referenciaDb().toFixed(1),
    referenciaAvisadaDb: +referenciaAvisadaDb().toFixed(1),
    antieco: el.antieco.checked,
    filtro: el.gate.checked,
    pessoas,
  };
};


// ---------- painel de diagnostico do som ----------
//
// Mesma informacao do cinemaDiag() acima, so que em portugues e sem F12.
// Quando o som some, o que resolve e saber QUAL das quatro coisas aconteceu -
// e ninguem vai abrir o console do navegador no meio do filme.

const diagAnt = new Map();  // ultima leitura de bytes por pessoa, pra virar kbps
let diagTimer = null;
let diagUltimo = null;

// bytes/ms x 8 = kbit/s. A taxa diz muito mais que o total acumulado: o total
// cresce igual quando esta chegando agora e quando parou cinco minutos atras.
function kbps(dBytes, dt) {
  return dt > 0 ? Math.round((dBytes * 8) / dt) : 0;
}

async function lerDiag() {
  const agora = performance.now();
  const pessoas = [];

  for (const p of peers.values()) {
    const linha = {
      nome: p.name,
      conexao: p.pc.connectionState,
      caminho: '-',
      voz: 0, filme: 0, video: 0, mandaVoz: 0, mandaVideo: 0,
      cortePct: p.cortePct,
      transmitindo: sharerId === p.id,
      temFaixaFilme: false,
      medido: false,
    };

    let st = null;
    try { st = await p.pc.getStats(); } catch { /* sem estatisticas */ }

    if (st) {
      const idsVoz = p.audioEl && p.audioEl.srcObject
        ? p.audioEl.srcObject.getAudioTracks().map((t) => t.id) : [];
      const bruto = { voz: 0, filme: 0, video: 0, mandaVoz: 0, mandaVideo: 0 };
      let par = null;

      st.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') {
          if (idsVoz.includes(r.trackIdentifier)) {
            bruto.voz += r.bytesReceived || 0;
          } else {
            bruto.filme += r.bytesReceived || 0;
            linha.temFaixaFilme = true;
          }
        }
        if (r.type === 'inbound-rtp' && r.kind === 'video') bruto.video += r.bytesReceived || 0;
        if (r.type === 'outbound-rtp' && r.kind === 'audio') bruto.mandaVoz += r.bytesSent || 0;
        if (r.type === 'outbound-rtp' && r.kind === 'video') bruto.mandaVideo += r.bytesSent || 0;
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') par = r;
      });

      // host = mesma rede, srflx = passou pelo STUN, relay = precisou de TURN
      if (par) {
        const loc = st.get(par.localCandidateId);
        const rem = st.get(par.remoteCandidateId);
        linha.caminho = (loc ? loc.candidateType : '?') + ' → ' + (rem ? rem.candidateType : '?');
      } else {
        linha.caminho = p.pc.connectionState === 'connected' ? 'fechando...' : 'ICE nao passou';
      }

      const ant = diagAnt.get(p.id);
      diagAnt.set(p.id, Object.assign({ t: agora }, bruto));
      if (ant) {
        const dt = agora - ant.t;
        linha.medido = true;
        linha.voz = kbps(bruto.voz - ant.voz, dt);
        linha.filme = kbps(bruto.filme - ant.filme, dt);
        linha.video = kbps(bruto.video - ant.video, dt);
        linha.mandaVoz = kbps(bruto.mandaVoz - ant.mandaVoz, dt);
        linha.mandaVideo = kbps(bruto.mandaVideo - ant.mandaVideo, dt);
      }
    }

    pessoas.push(linha);
  }

  const tela = el.video.srcObject;
  return {
    servidor: !!(ws && ws.readyState === 1),
    micLiberado: !!micStream,
    euTransmitindo: !!screenStream,
    recebendoDe: sharerId && sharerId !== 'me' && peers.get(sharerId)
      ? peers.get(sharerId).name : null,
    temTela: !!(tela && tela.getVideoTracks().length),
    temFaixaAudio: !!(tela && tela.getAudioTracks().length),
    segurado: el.video.muted,
    volumeFilme: Math.round(el.video.volume * 100),
    sliderFilme: Number(el.volFilm.value),
    abafando: duckLigado,
    surdina: deaf,
    nivelFilmeDb: filmeAn ? +db(nivel(filmeAn, filmeBuf)).toFixed(1) : null,
    webkit: WEBKIT,
    pessoas,
  };
}

// A ordem importa: cada teste so faz sentido se o anterior passou. Nao adianta
// falar de volume enquanto nao esta chegando byte nenhum.
function vereditoDiag(d) {
  if (!d.servidor) return ['ruim', 'O <b>servidor da sala caiu</b>. Recarregue a pagina.'];
  if (d.euTransmitindo) {
    return ['ok', 'Voce e quem transmite: aqui o filme fica <b>mudo de proposito</b>, ' +
                  'porque ele ja toca direto na sua maquina. Quem tem que ouvir sao os outros.'];
  }
  if (!d.temTela) return ['ok', 'Ninguem esta transmitindo agora.'];
  if (!d.temFaixaAudio) {
    return ['ruim', 'A transmissao chegou <b>sem faixa de audio nenhuma</b>. Quem transmite ' +
                    'precisa parar e transmitir de novo marcando <b>Compartilhar audio da guia</b>.'];
  }

  const dono = d.pessoas.find((x) => x.transmitindo);
  if (dono && dono.medido && dono.filme < 2) {
    return ['ruim', 'A imagem passa, mas o <b>som do filme nao esta chegando</b> (0 kbps). ' +
                    'Peca pra quem transmite clicar em Parar e Transmitir de novo.'];
  }
  if (d.segurado) {
    return ['ruim', 'O som chega, mas o navegador <b>segurou o audio</b>. Clique no botao ' +
                    '<b>Clique para ativar o som</b>, no meio da tela.'];
  }
  if (d.surdina) return ['ruim', 'A <b>surdina</b> esta ligada (botao do fone, tecla D).'];
  if (d.volumeFilme < 5) {
    return ['ruim', 'O som chega e o navegador esta tocando - o <b>volume daqui</b> e que ' +
                    'esta no chao. Suba o slider <b>Filme</b>.'];
  }
  if (d.nivelFilmeDb !== null && d.nivelFilmeDb < -75) {
    return ['ruim', 'O som chega, mas vem <b>mudo</b>: silencio digital neste instante. ' +
                    'Se o filme deveria estar tocando, quem transmite escolheu a aba errada.'];
  }
  if (dono && dono.cortePct > 3) {
    return ['ruim', 'O som chega <b>picotado</b> (' + dono.cortePct.toFixed(1) +
                    '% perdido no caminho). Falta banda entre voces.'];
  }
  if (WEBKIT) {
    return ['ok', 'Som do filme chegando e tocando. Se nao sai nada no iPhone, o resto e ' +
                  'do proprio aparelho: <b>chavinha do lado esquerdo</b> (modo silencioso), ' +
                  'os botoes de volume <b>enquanto o filme roda</b>, ou fone/Bluetooth ' +
                  'conectado levando o som pra outro lugar.'];
  }
  return ['ok', 'Som do filme chegando e tocando. Se mesmo assim nao sai nada, o problema ' +
                'esta fora da pagina: volume do sistema ou saida de audio errada.'];
}

function dgSecao(titulo) {
  const d = document.createElement('div');
  d.className = 'dg';
  const t = document.createElement('div');
  t.className = 'dg-t';
  t.textContent = titulo;
  d.append(t);
  return d;
}

function dgLinha(pai, rotulo, valor, classe) {
  const l = document.createElement('div');
  l.className = 'dg-l';
  const b = document.createElement('b');
  b.textContent = rotulo;
  const i = document.createElement('i');
  if (classe) i.className = classe;
  i.textContent = valor;
  l.append(b, i);
  pai.append(l);
}

function renderDiag(d) {
  const [tom, texto] = vereditoDiag(d);
  el.diagVeredito.className = 'diag-veredito' + (tom === 'ruim' ? ' ruim' : '');
  el.diagVeredito.innerHTML = texto;

  const corpo = document.createElement('div');

  const aqui = dgSecao('aqui, nesta pagina');
  dgLinha(aqui, 'Servidor da sala', d.servidor ? 'conectado' : 'CAIDO',
          d.servidor ? 'ok' : 'ruim');
  dgLinha(aqui, 'Meu microfone', d.micLiberado ? 'liberado' : 'negado',
          d.micLiberado ? 'ok' : 'ruim');
  dgLinha(aqui, 'Transmissao', d.euTransmitindo ? 'sou eu'
    : d.recebendoDe ? 'de ' + d.recebendoDe : d.temTela ? 'recebendo' : 'ninguem');
  dgLinha(aqui, 'Faixa de audio na tela', !d.temTela ? '-'
    : d.temFaixaAudio ? 'existe' : 'NAO VEIO',
          !d.temTela ? '' : d.temFaixaAudio ? 'ok' : 'ruim');
  dgLinha(aqui, 'Navegador tocando', d.segurado ? 'SEGUROU' : 'sim',
          d.segurado ? 'ruim' : 'ok');
  dgLinha(aqui, 'Volume real do filme', d.volumeFilme + '%',
          d.volumeFilme < 5 ? 'ruim' : d.volumeFilme < 50 ? 'meio' : 'ok');
  dgLinha(aqui, 'Slider Filme', d.sliderFilme + '%');
  dgLinha(aqui, 'Abafador agora', d.abafando ? 'abaixando' : 'parado',
          d.abafando ? 'meio' : '');
  dgLinha(aqui, 'Surdina', d.surdina ? 'LIGADA' : 'desligada', d.surdina ? 'ruim' : '');
  dgLinha(aqui, 'Nivel do filme',
          d.nivelFilmeDb === null ? 'sem medidor' : d.nivelFilmeDb + ' dB',
          d.nivelFilmeDb === null ? '' : d.nivelFilmeDb < -75 ? 'ruim' : 'ok');
  dgLinha(aqui, 'Motor de audio', d.webkit ? 'WebKit (medidor desligado)' : 'padrao');
  corpo.append(aqui);

  if (!d.pessoas.length) {
    const so = dgSecao('pessoas');
    dgLinha(so, 'Ninguem na sala', 'so voce');
    corpo.append(so);
  }

  for (const x of d.pessoas) {
    const sec = dgSecao(x.nome + (x.transmitindo ? '  (transmitindo)' : ''));
    dgLinha(sec, 'Conexao', x.conexao, x.conexao === 'connected' ? 'ok' : 'ruim');
    dgLinha(sec, 'Caminho', x.caminho);
    dgLinha(sec, 'Voz chegando', x.medido ? x.voz + ' kbps' : 'medindo...',
            !x.medido ? '' : x.voz > 0 ? 'ok' : 'meio');
    if (x.transmitindo || x.temFaixaFilme) {
      dgLinha(sec, 'Filme chegando', x.medido ? x.filme + ' kbps' : 'medindo...',
              !x.medido ? '' : x.filme > 2 ? 'ok' : 'ruim');
      dgLinha(sec, 'Video chegando', x.medido ? x.video + ' kbps' : 'medindo...',
              !x.medido ? '' : x.video > 20 ? 'ok' : 'meio');
      dgLinha(sec, 'Som perdido no caminho',
              x.cortePct === undefined ? 'medindo...' : x.cortePct.toFixed(1) + '%',
              x.cortePct === undefined ? '' : x.cortePct > 3 ? 'ruim'
                : x.cortePct > 1 ? 'meio' : 'ok');
    }
    dgLinha(sec, 'Minha voz indo', x.medido ? x.mandaVoz + ' kbps' : 'medindo...');
    if (d.euTransmitindo) {
      dgLinha(sec, 'Meu video indo', x.medido ? x.mandaVideo + ' kbps' : 'medindo...',
              !x.medido ? '' : x.mandaVideo > 20 ? 'ok' : 'ruim');
    }
    corpo.append(sec);
  }

  el.diagBody.replaceChildren(...corpo.childNodes);
}

// versao em texto, pra colar num chat ou mandar pra quem for consertar
function diagTexto(d) {
  const linhas = [
    'DIAGNOSTICO DO SOM - sala ' + room + ' - ' + new Date().toLocaleString('pt-BR'),
    'veredito: ' + vereditoDiag(d)[1].replace(/<[^>]+>/g, ''),
    '',
    'servidor=' + (d.servidor ? 'ok' : 'CAIDO') +
      ' mic=' + (d.micLiberado ? 'ok' : 'negado') +
      ' euTransmitindo=' + d.euTransmitindo +
      ' recebendoDe=' + (d.recebendoDe || '-'),
    'tela: video=' + d.temTela + ' faixaAudio=' + d.temFaixaAudio +
      ' seguradoPeloNavegador=' + d.segurado + ' webkit=' + d.webkit,
    'volumeReal=' + d.volumeFilme + '% slider=' + d.sliderFilme + '%' +
      ' abafando=' + d.abafando + ' surdina=' + d.surdina +
      ' nivelFilme=' + (d.nivelFilmeDb === null ? 'sem medidor' : d.nivelFilmeDb + 'dB'),
    '',
  ];
  for (const x of d.pessoas) {
    linhas.push('[' + x.nome + ']' + (x.transmitindo ? ' TRANSMITINDO' : ''));
    linhas.push('  conexao=' + x.conexao + ' caminho=' + x.caminho);
    linhas.push('  recebe voz=' + x.voz + 'kbps filme=' + x.filme +
                'kbps video=' + x.video + 'kbps');
    linhas.push('  envia voz=' + x.mandaVoz + 'kbps video=' + x.mandaVideo + 'kbps');
    linhas.push('  perdido=' + (x.cortePct === undefined ? '-' : x.cortePct.toFixed(2) + '%'));
  }
  return linhas.join('\n');
}

async function tickDiag() {
  diagUltimo = await lerDiag();
  renderDiag(diagUltimo);
}

// a primeira leitura so guarda os totais; a taxa em kbps aparece na segunda
function abrirDiag() {
  el.diag.classList.remove('hidden');
  el.diagMsg.textContent = '';
  tickDiag();
  clearInterval(diagTimer);
  diagTimer = setInterval(tickDiag, 1000);
}

function fecharDiag() {
  el.diag.classList.add('hidden');
  clearInterval(diagTimer);
  diagTimer = null;
  diagAnt.clear();   // taxa velha nao vale nada quando o painel reabrir
}

$('btn-diag').onclick = () =>
  (el.diag.classList.contains('hidden') ? abrirDiag() : fecharDiag());
$('diag-close').onclick = fecharDiag;

$('diag-copiar').onclick = async () => {
  if (!diagUltimo) return;
  const txt = diagTexto(diagUltimo);
  try {
    await navigator.clipboard.writeText(txt);
    el.diagMsg.textContent = 'copiado';
  } catch {
    // area de transferencia bloqueada (http, permissao): joga no chat, que da
    // pra selecionar com o mouse - e abre o chat, senao cai num painel fechado
    sys(txt);
    el.chat.classList.remove('hidden');
    el.diagMsg.textContent = 'nao deu pra copiar - joguei no chat';
  }
  setTimeout(() => { el.diagMsg.textContent = ''; }, 2500);
};

// ---------- lista de pessoas ----------

function linha(nome, opc) {
  const div = document.createElement('div');
  div.className = 'person' + (opc.speaking ? ' speaking' : '') + (opc.mic ? '' : ' mudo');

  const av = document.createElement('div');
  av.className = 'av';
  av.textContent = (nome[0] || '?').toUpperCase();

  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = nome + (opc.me ? ' (voce)' : '');

  const tags = document.createElement('span');
  tags.className = 'tags';
  tags.textContent = (opc.sharing ? '\u{1F5A5}' : '') + (opc.mic ? '' : ' \u{1F507}');

  div.append(av, nm, tags);

  if (!opc.me) {
    const b = document.createElement('button');
    b.className = 'mini' + (opc.mutado ? ' off' : '');
    b.title = opc.mutado ? 'Ouvir de novo' : 'Silenciar essa pessoa';
    b.textContent = opc.mutado ? '\u{1F507}' : '\u{1F50A}';
    b.onclick = opc.onMute;
    div.append(b);
  }
  return div;
}

function desenharPessoas() {
  el.people.innerHTML = '';

  myRow = linha(myName, { me: true, mic: micLive(), sharing: !!screenStream });
  el.people.append(myRow);

  for (const p of peers.values()) {
    p.row = linha(p.name, {
      mic: p.mic, sharing: p.sharing, mutado: p.muted, speaking: p.speaking,
      onMute: () => { p.muted = !p.muted; aplicarVolumes(); desenharPessoas(); },
    });
    el.people.append(p.row);
  }

  el.count.textContent = (peers.size + 1) + '/' + MAXP;
}

function atualizarBadge() {
  if (reconectando) return; // o aviso de reconexao manda no cracha
  if (screenStream) {
    const temAudio = screenStream.getAudioTracks().length > 0;
    el.badge.textContent = temAudio ? '\u{1F534} transmitindo com audio' : '\u{1F534} transmitindo SEM audio';
    el.badge.classList.toggle('bad', !temAudio);
    return;
  }
  if (sharerId) {
    const s = el.video.srcObject;
    const temAudio = !!s && s.getAudioTracks().length > 0;
    el.badge.textContent = !temAudio ? '⚠ filme sem audio'
      : el.video.muted ? '\u{1F507} clique pra ouvir o filme' : '\u{1F3AC} assistindo';
    el.badge.classList.toggle('bad', !temAudio);
    return;
  }
  el.badge.textContent = '\u{1F5E3} so voz';
  el.badge.classList.remove('bad');
}

setInterval(atualizarBadge, 2000);

// ---------- chat e avisos ----------

// nomes vem de outras pessoas: nunca vao crus pro innerHTML
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function aviso(html) {
  el.warnText.innerHTML = html;
  el.warn.classList.remove('hidden');
}

function addMsg(quem, texto) {
  const div = document.createElement('div');
  div.className = 'msg';
  const w = document.createElement('span');
  w.className = 'who';
  w.textContent = quem + ':';
  const t = document.createElement('span');
  t.textContent = ' ' + texto;
  div.append(w, t);
  el.log.append(div);
  el.log.scrollTop = el.log.scrollHeight;
  el.chat.classList.remove('hidden');
}

function sys(texto) {
  const div = document.createElement('div');
  div.className = 'msg sys';
  div.textContent = texto;
  el.log.append(div);
  el.log.scrollTop = el.log.scrollHeight;
}

el.chatForm.onsubmit = (e) => {
  e.preventDefault();
  const texto = el.chatInput.value.trim();
  if (!texto) return;
  signal({ type: 'chat', text: texto });
  addMsg(myName, texto);
  el.chatInput.value = '';
};

// ---------- botoes ----------

$('btn-chat').onclick = () => el.chat.classList.toggle('hidden');
$('btn-people').onclick = () => el.side.classList.toggle('aberta');
$('warn-close').onclick = () => el.warn.classList.add('hidden');
$('btn-full').onclick = () =>
  document.fullscreenElement ? document.exitFullscreen() : el.stage.requestFullscreen();

// em tela cheia some a lista de nomes: fica so o filme
function marcarTelaCheia() {
  const cheia = !!(document.fullscreenElement || document.webkitFullscreenElement);
  el.stage.classList.toggle('cheia', cheia);
  if (cheia) el.side.classList.remove('aberta');
}
document.addEventListener('fullscreenchange', marcarTelaCheia);
document.addEventListener('webkitfullscreenchange', marcarTelaCheia);
$('btn-leave').onclick = () => sair();
el.video.addEventListener('dblclick', () => $('btn-full').click());

function sair() {
  saiu = true;
  clearInterval(pingTimer);
  pararMic();
  if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
  for (const p of peers.values()) { try { p.pc.close(); } catch { /* ja fechada */ } }
  if (ws) ws.close();
  location.reload();
}

addEventListener('beforeunload', () => { if (ws) ws.close(); });
