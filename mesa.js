#!/usr/bin/env node
// Mesa de cartas: a zero-dependency shared card table for phones on the same Wi-Fi.
// Run: node mesa.js   (then open the printed URL on every phone)
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const SAVE = path.join(__dirname, 'mesa-state.json');
const HTML = fs.readFileSync(__filename, 'utf8').split('/*__HTML__')[2].split('__HTML__*/')[0];

const FR_SUITS = ['S', 'H', 'D', 'C'];
const FR_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SP_SUITS = ['oros', 'copas', 'espadas', 'bastos'];

function rid() {
  return crypto.randomBytes(5).toString('hex');
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildDeck(cfg) {
  const cards = [];
  for (let c = 0; c < cfg.copies; c++) {
    if (cfg.type === 'spanish') {
      const ranks = cfg.spanish48 ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [1, 2, 3, 4, 5, 6, 7, 10, 11, 12];
      for (const s of SP_SUITS) for (const r of ranks) cards.push({ id: `${c}${s}${r}`, s, r: String(r) });
    } else {
      for (const s of FR_SUITS) for (const r of FR_RANKS) cards.push({ id: `${c}${s}${r}`, s, r });
    }
    if (cfg.jokers) for (let j = 0; j < 2; j++) cards.push({ id: `${c}X${j}`, s: 'X', r: 'JOKER' });
  }
  return shuffle(cards);
}

function deckLabel(cfg) {
  const base = cfg.type === 'spanish' ? `española ${cfg.spanish48 ? 48 : 40}` : 'francesa 52';
  return `${cfg.copies > 1 ? cfg.copies + ' barajas' : 'baraja'} ${base}${cfg.jokers ? ' + jokers' : ''}`;
}

function freshState() {
  const config = { type: 'french', spanish48: false, jokers: false, copies: 1 };
  return { config, deck: buildDeck(config), discard: [], table: [], players: {}, order: [], turn: 0, log: [] };
}

let state;
try {
  state = JSON.parse(fs.readFileSync(SAVE, 'utf8'));
} catch {
  state = freshState();
}

function save() {
  try {
    fs.writeFileSync(SAVE, JSON.stringify(state));
  } catch {}
}

function log(msg) {
  state.log.push(msg);
  if (state.log.length > 50) state.log.splice(0, state.log.length - 50);
}

function takeFromHand(p, ids) {
  if (!Array.isArray(ids) || !ids.length) throw new Error('Selecciona cartas primero');
  const cards = ids.map((id) => {
    const c = p.hand.find((h) => h.id === id);
    if (!c) throw new Error('Esa carta ya no está en tu mano');
    return c;
  });
  p.hand = p.hand.filter((h) => !ids.includes(h.id));
  return cards;
}

function findGroup(id) {
  const g = state.table.find((t) => t.id === id);
  if (!g) throw new Error('Ese grupo ya no está en la mesa');
  return g;
}

function drawFromDeck() {
  const c = state.deck.pop();
  if (!c) throw new Error('El mazo está vacío');
  return c;
}

function cardName(c) {
  if (c.s === 'X') return 'Joker';
  const sym = { S: '♠', H: '♥', D: '♦', C: '♣', oros: ' de oros', copas: ' de copas', espadas: ' de espadas', bastos: ' de bastos' };
  return c.r + sym[c.s];
}

function handle(msg) {
  const { pid, type } = msg;
  if (typeof pid !== 'string' || !pid) throw new Error('Falta identificador');
  if (type === 'join') {
    const name = String(msg.name || '').trim().slice(0, 16);
    if (!name) throw new Error('Escribe tu nombre');
    if (state.players[pid]) {
      state.players[pid].name = name;
    } else {
      state.players[pid] = { name, hand: [], score: 0, revealed: false };
      state.order.push(pid);
      log(`${name} se sentó a la mesa`);
    }
    return;
  }
  const p = state.players[pid];
  if (!p) throw new Error('Primero únete a la mesa');
  const me = p.name;
  switch (type) {
    case 'newGame': {
      const c = msg.config || {};
      const cfg = {
        type: c.type === 'spanish' ? 'spanish' : 'french',
        spanish48: !!c.spanish48,
        jokers: !!c.jokers,
        copies: Math.min(Math.max(parseInt(c.copies) || 1, 1), 3),
      };
      state.config = cfg;
      state.deck = buildDeck(cfg);
      state.discard = [];
      state.table = [];
      for (const id of state.order) Object.assign(state.players[id], { hand: [], revealed: false });
      log(`${me} empezó partida nueva: ${deckLabel(cfg)}`);
      break;
    }
    case 'deal': {
      const n = Math.min(Math.max(parseInt(msg.n) || 0, 1), 40);
      let dealt = 0;
      for (let i = 0; i < n; i++)
        for (const id of state.order) {
          const c = state.deck.pop();
          if (c) state.players[id].hand.push(c), dealt++;
        }
      log(`${me} repartió ${n} carta${n > 1 ? 's' : ''} a cada uno${dealt < n * state.order.length ? ' (se acabó el mazo)' : ''}`);
      break;
    }
    case 'draw':
      p.hand.push(drawFromDeck());
      log(`${me} robó del mazo`);
      break;
    case 'drawDiscard': {
      const c = state.discard.pop();
      if (!c) throw new Error('El descarte está vacío');
      p.hand.push(c);
      log(`${me} tomó ${cardName(c)} del descarte`);
      break;
    }
    case 'discard': {
      const cards = takeFromHand(p, msg.cards);
      state.discard.push(...cards);
      log(`${me} descartó ${cards.map(cardName).join(', ')}`);
      break;
    }
    case 'play': {
      if (msg.group) {
        const g = findGroup(msg.group);
        const cards = takeFromHand(p, msg.cards);
        g.cards.push(...cards);
        log(`${me} agregó ${cards.map(cardName).join(', ')} a la mesa`);
      } else {
        const cards = takeFromHand(p, msg.cards);
        state.table.push({ id: rid(), owner: me, cards });
        log(`${me} bajó ${cards.map(cardName).join(', ')}`);
      }
      break;
    }
    case 'take': {
      const g = findGroup(msg.group);
      if (msg.card) {
        const i = g.cards.findIndex((c) => c.id === msg.card);
        if (i < 0) throw new Error('Esa carta ya no está en la mesa');
        const [c] = g.cards.splice(i, 1);
        p.hand.push(c);
        log(`${me} tomó ${cardName(c)} de la mesa`);
      } else {
        p.hand.push(...g.cards);
        log(`${me} tomó ${g.cards.length} carta${g.cards.length > 1 ? 's' : ''} de la mesa`);
        g.cards = [];
      }
      state.table = state.table.filter((t) => t.cards.length);
      break;
    }
    case 'give': {
      const to = state.players[msg.to];
      if (!to) throw new Error('Ese jugador ya no está');
      const cards = takeFromHand(p, msg.cards);
      to.hand.push(...cards);
      log(`${me} le pasó ${cards.length} carta${cards.length > 1 ? 's' : ''} a ${to.name}`);
      break;
    }
    case 'reorder': {
      const ids = msg.cards;
      if (!Array.isArray(ids) || ids.length !== p.hand.length) throw new Error('Tu mano cambió, intenta de nuevo');
      const byId = new Map(p.hand.map((c) => [c.id, c]));
      const next = ids.map((id) => byId.get(id));
      if (next.some((c) => !c) || new Set(ids).size !== ids.length) throw new Error('Tu mano cambió, intenta de nuevo');
      p.hand = next;
      return; // no log, purely cosmetic
    }
    case 'reveal':
      p.revealed = !p.revealed;
      log(`${me} ${p.revealed ? 'mostró' : 'ocultó'} su mano`);
      break;
    case 'flip': {
      const c = drawFromDeck();
      state.discard.push(c);
      log(`${me} dio vuelta ${cardName(c)} al descarte`);
      break;
    }
    case 'toTable': {
      const c = drawFromDeck();
      state.table.push({ id: rid(), owner: 'Mazo', cards: [c] });
      log(`${me} puso ${cardName(c)} en la mesa`);
      break;
    }
    case 'recycle': {
      const top = state.discard.pop();
      state.deck = shuffle(state.deck.concat(state.discard));
      state.discard = top ? [top] : [];
      log(`${me} rebarajó el descarte en el mazo`);
      break;
    }
    case 'shuffleDeck':
      shuffle(state.deck);
      log(`${me} barajó el mazo`);
      break;
    case 'score': {
      const t = state.players[msg.target];
      if (!t) throw new Error('Ese jugador ya no está');
      const d = Math.max(-100, Math.min(100, parseInt(msg.d) || 0));
      t.score += d;
      log(`${me}: puntaje de ${t.name} ${d > 0 ? '+' : ''}${d} → ${t.score}`);
      break;
    }
    case 'endTurn': {
      if (!state.order.length) break;
      state.turn = (state.turn + 1) % state.order.length;
      log(`Turno de ${state.players[state.order[state.turn]].name}`);
      break;
    }
    case 'setTurn': {
      const i = state.order.indexOf(msg.target);
      if (i < 0) throw new Error('Ese jugador ya no está');
      state.turn = i;
      log(`Turno de ${state.players[msg.target].name}`);
      break;
    }
    case 'kick': {
      const id = msg.target;
      const t = state.players[id];
      if (!t) throw new Error('Ese jugador ya no está');
      state.deck.unshift(...t.hand);
      delete state.players[id];
      state.order = state.order.filter((o) => o !== id);
      if (state.turn >= state.order.length) state.turn = 0;
      log(`${t.name} salió de la mesa (sus cartas volvieron al fondo del mazo)`);
      break;
    }
    default:
      throw new Error('Acción desconocida');
  }
}

// ---- networking ----
const clients = new Set();

function view(pid) {
  return {
    me: state.players[pid] ? pid : null,
    config: state.config,
    deckCount: state.deck.length,
    discard: state.discard.slice(-1),
    discardCount: state.discard.length,
    table: state.table,
    turn: state.order[state.turn] || null,
    log: state.log.slice(-5),
    players: state.order.map((id) => {
      const p = state.players[id];
      return {
        id,
        name: p.name,
        count: p.hand.length,
        score: p.score,
        revealed: p.revealed,
        online: [...clients].some((c) => c.pid === id),
        hand: id === pid || p.revealed ? p.hand : null,
      };
    }),
  };
}

function broadcast() {
  for (const c of clients) c.res.write(`data: ${JSON.stringify(view(c.pid))}\n\n`);
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(HTML);
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 1500\n\n');
    const client = { pid: url.searchParams.get('pid') || '', res };
    clients.add(client);
    broadcast();
    req.on('close', () => {
      clients.delete(client);
      broadcast();
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api') {
    let body = '';
    req.on('data', (d) => {
      body += d;
      if (body.length > 100000) req.destroy();
    });
    req.on('end', () => {
      try {
        handle(JSON.parse(body));
        save();
        broadcast();
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e.message });
      }
    });
    return;
  }
  res.writeHead(404);
  res.end('No encontrado');
});

// keep SSE connections alive through phone/hotspot idle timeouts
setInterval(() => {
  for (const c of clients) c.res.write(': ping\n\n');
}, 15000);

server.listen(PORT, '0.0.0.0', () => {
  let urls = [];
  try {
    urls = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && (i.family === 'IPv4' || i.family === 4) && !i.internal)
      .map((i) => `http://${i.address}:${PORT}`);
  } catch {}
  console.log('\n🃏 Mesa de cartas lista. Abre en cada teléfono (misma red Wi-Fi):\n');
  if (urls.length) for (const u of urls) console.log('   ' + u);
  else console.log(`   http://<IP de este equipo>:${PORT}   (en hotspot Android suele ser http://192.168.43.1:${PORT})`);
  console.log(`\n   En este mismo equipo: http://localhost:${PORT}\n   Ctrl+C para cerrar. La partida se guarda en ${SAVE}\n`);
});

/*__HTML__
<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#0f3d22">
<title>Mesa de cartas</title>
<style>
:root{--felt:#166534;--felt2:#0b3019;--ink:#f1f5f2;--muted:#a7c4b2;--accent:#facc15;--panel:rgba(0,0,0,.28)}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%}
body{background:radial-gradient(circle at 50% 25%,var(--felt),var(--felt2) 75%);background-color:var(--felt2);color:var(--ink);font:15px/1.3 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;overflow:hidden;user-select:none;-webkit-user-select:none}
button{font:inherit;border:0;border-radius:10px;padding:9px 12px;background:#f1f5f2;color:#0b3019;font-weight:650;flex:none;cursor:pointer}
button.sec{background:rgba(255,255,255,.14);color:var(--ink)}
button.warn{background:#fca5a5;color:#450a0a}
input,select{font:inherit;padding:9px 10px;border-radius:10px;border:0;background:#f1f5f2;color:#0b3019}
[hidden]{display:none!important}
#join{display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;height:100%;padding:24px;text-align:center}
#join h1{margin:0;font-size:28px}
#join input{width:100%;max-width:280px;text-align:center;font-size:18px}
#game{display:flex;flex-direction:column;height:100%}
#top{display:flex;gap:6px;padding:8px;padding-top:max(8px,env(safe-area-inset-top));overflow-x:auto;flex:none;align-items:stretch}
#dot{width:10px;height:10px;border-radius:50%;background:#ef4444;flex:none;align-self:center}
#dot.on{background:#4ade80}
.pl{flex:none;background:var(--panel);border-radius:10px;padding:5px 9px;font-size:13px;border:2px solid transparent;min-width:84px}
.pl.turn{border-color:var(--accent)}
.pl .n{font-weight:700;white-space:nowrap}
.pl.off .n{opacity:.45}
.pl .sc{display:flex;gap:6px;align-items:center;margin-top:3px}
.pl .sc button{padding:1px 8px;border-radius:6px;font-size:13px}
#mid{flex:1;overflow-y:auto;padding:4px 8px 12px}
#log{font-size:12px;color:var(--muted);min-height:16px;margin:0 2px 6px}
#log div:last-child{color:var(--ink)}
#piles{display:flex;gap:18px;justify-content:center;margin:6px 0 12px}
.pile{display:flex;flex-direction:column;align-items:center;gap:4px;font-size:12px;color:var(--muted)}
.card{width:50px;height:72px;border-radius:7px;background:#fff;color:#111;position:relative;box-shadow:0 1px 3px rgba(0,0,0,.45);flex:none;font-weight:750;transition:transform .12s}
.card .r{position:absolute;top:3px;left:4px;font-size:15px;line-height:1.05;text-align:center}
.card .big{position:absolute;right:3px;bottom:2px;font-size:24px;line-height:1}
.card.sp .r{font-size:17px}
.card.joker .r{font-size:9px;letter-spacing:-.3px}
.card.back{background:repeating-linear-gradient(45deg,#7f1d1d 0 6px,#991b1b 6px 12px);border:3px solid #fff}
.card.empty{background:transparent;border:2px dashed rgba(255,255,255,.3);box-shadow:none}
.card.sel{transform:translateY(-12px);box-shadow:0 0 0 3px var(--accent),0 4px 10px rgba(0,0,0,.5)}
.card.tsel{box-shadow:0 0 0 3px var(--accent)}
#table{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start}
.grp{background:var(--panel);border-radius:10px;padding:16px 8px 8px;display:flex;position:relative;border:2px solid transparent;min-height:96px}
.grp.gsel{border-color:var(--accent)}
.grp .who{position:absolute;top:2px;left:8px;font-size:10px;color:var(--muted)}
.grp .card+.card{margin-left:-24px}
.empty-msg{color:var(--muted);font-size:13px;text-align:center;width:100%;padding:16px 0}
.rev{margin-top:10px}
.rev .t{font-size:12px;color:var(--muted);margin-bottom:4px}
.rev .cards{display:flex;flex-wrap:wrap;gap:3px}
#bottom{flex:none;background:rgba(0,0,0,.35);padding:8px 8px max(10px,env(safe-area-inset-bottom));border-top:1px solid rgba(255,255,255,.1)}
#acts{display:flex;gap:6px;overflow-x:auto;padding-bottom:8px}
#acts button{padding:8px 11px;font-size:14px}
#hand{display:flex;flex-wrap:wrap;gap:4px;padding-top:12px;min-height:84px;max-height:42vh;overflow-y:auto}
#hand .info{color:var(--muted);font-size:13px;align-self:center}
#ov{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center;z-index:10}
.sheet{background:#0f2c1b;width:100%;max-width:520px;max-height:88vh;overflow-y:auto;border-radius:16px 16px 0 0;padding:16px 16px max(16px,env(safe-area-inset-bottom))}
.sheet h3{margin:14px 0 8px;font-size:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
.sheet h3:first-child{margin-top:0}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.row+.row{margin-top:8px}
#toast{position:fixed;left:50%;top:60px;transform:translateX(-50%);background:#111;color:#fff;padding:10px 14px;border-radius:10px;font-size:14px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:20;max-width:90vw;text-align:center}
#toast.show{opacity:1}
</style>
</head>
<body>
<div id="join">
  <h1>🃏 Mesa de cartas</h1>
  <div style="color:var(--muted)">Escribe tu nombre para sentarte</div>
  <input id="name" maxlength="16" placeholder="Tu nombre" autocomplete="off">
  <button id="joinBtn">Entrar</button>
</div>
<div id="game" hidden>
  <div id="top"><div id="dot"></div><div id="players" style="display:contents"></div></div>
  <div id="mid">
    <div id="log"></div>
    <div id="piles"></div>
    <div id="table"></div>
    <div id="revealed"></div>
  </div>
  <div id="bottom">
    <div id="acts"></div>
    <div id="hand"></div>
  </div>
</div>
<div id="ov" hidden><div class="sheet" id="sheet"></div></div>
<div id="toast"></div>
<script>
const $ = (s) => document.querySelector(s);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};
let pid = store.get('pid');
if (!pid) { pid = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set('pid', pid); }
let S = null, sel = [], tsel = null, sheet = null;

const FR = { S: ['♠', '#111'], H: ['♥', '#d0021b'], D: ['♦', '#d0021b'], C: ['♣', '#111'] };
const SP = { oros: ['🪙', '#a16207'], copas: ['🏆', '#b91c1c'], espadas: ['⚔️', '#1e3a8a'], bastos: ['🪵', '#166534'] };
const SUIT_ORDER = { S: 0, H: 1, C: 2, D: 3, oros: 4, copas: 5, espadas: 6, bastos: 7, X: 9 };
const rankVal = (r) => ({ A: 1, J: 11, Q: 12, K: 13, JOKER: 99 })[r] || +r;

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

function cardHTML(c, attrs, cls) {
  attrs = attrs || ''; cls = cls || '';
  if (c.s === 'X') return '<div class="card joker ' + cls + '" ' + attrs + '><span class="r">JOKER</span><span class="big">🃏</span></div>';
  const fr = FR[c.s], d = fr || SP[c.s];
  return '<div class="card ' + (fr ? '' : 'sp ') + cls + '" ' + attrs + ' style="color:' + d[1] + '"><span class="r">' + c.r + (fr ? '<br>' + d[0] : '') + '</span><span class="big">' + d[0] + '</span></div>';
}

let toastT;
function toast(m) {
  const t = $('#toast'); t.textContent = m; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200);
}

async function act(type, data) {
  try {
    const r = await fetch('/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ pid: pid, type: type }, data || {})) });
    const j = await r.json();
    if (!j.ok) toast(j.error);
    return j.ok;
  } catch (e) { toast('Sin conexión con la mesa'); return false; }
}

function connect() {
  const es = new EventSource('/events?pid=' + encodeURIComponent(pid));
  es.onmessage = (e) => { S = JSON.parse(e.data); render(); };
  es.onopen = () => { $('#dot').className = 'on'; };
  es.onerror = () => { $('#dot').className = ''; };
}

function meP() { return S && S.players.find((p) => p.id === pid); }

function render() {
  const me = meP();
  $('#join').hidden = !!me; $('#game').hidden = !me;
  if (!me) { if (!$('#name').value) $('#name').value = store.get('name') || ''; return; }
  const hand = me.hand;
  sel = sel.filter((id) => hand.some((c) => c.id === id));
  if (tsel) {
    const g = S.table.find((g) => g.id === tsel.g);
    if (!g) tsel = null; else if (tsel.c && !g.cards.some((c) => c.id === tsel.c)) tsel.c = null;
  }

  $('#players').innerHTML = S.players.map((p) =>
    '<div class="pl ' + (p.id === S.turn ? 'turn ' : '') + (p.online ? '' : 'off') + '">' +
    '<div class="n">' + (p.id === S.turn ? '▶ ' : '') + esc(p.name) + (p.id === pid ? ' (tú)' : '') + '</div>' +
    '<div>🂠 ' + p.count + (p.revealed ? ' · 👁' : '') + '</div>' +
    '<div class="sc"><button class="sec" data-score="' + p.id + '" data-d="-1">−</button><b>' + p.score + '</b><button class="sec" data-score="' + p.id + '" data-d="1">+</button></div></div>'
  ).join('');

  $('#log').innerHTML = S.log.slice(-3).map((l) => '<div>' + esc(l) + '</div>').join('');

  const top = S.discard[S.discard.length - 1];
  $('#piles').innerHTML =
    '<div class="pile" data-act="draw">' + (S.deckCount ? '<div class="card back"></div>' : '<div class="card empty"></div>') + '<div>Mazo (' + S.deckCount + ')</div><div>toca = robar</div></div>' +
    '<div class="pile" data-act="drawDiscard">' + (top ? cardHTML(top) : '<div class="card empty"></div>') + '<div>Descarte (' + S.discardCount + ')</div><div>toca = tomar</div></div>';

  $('#table').innerHTML = S.table.length ? S.table.map((g) =>
    '<div class="grp ' + (tsel && tsel.g === g.id ? 'gsel' : '') + '" data-g="' + g.id + '"><span class="who">' + esc(g.owner || '') + '</span>' +
    g.cards.map((c) => cardHTML(c, 'data-tc="' + c.id + '"', tsel && tsel.c === c.id ? 'tsel' : '')).join('') + '</div>'
  ).join('') : '<div class="empty-msg">Mesa vacía · selecciona cartas de tu mano y toca «Bajar»</div>';

  $('#revealed').innerHTML = S.players.filter((p) => p.id !== pid && p.hand).map((p) =>
    '<div class="rev"><div class="t">Mano de ' + esc(p.name) + '</div><div class="cards">' + p.hand.map((c) => cardHTML(c)).join('') + '</div></div>'
  ).join('');

  const a = [];
  if (sel.length) {
    a.push('<button data-act="play">Bajar (' + sel.length + ')</button>');
    if (tsel) a.push('<button data-act="add">Agregar al grupo</button>');
    a.push('<button data-act="discard">Descartar</button>');
    a.push('<button class="sec" data-act="giveMenu">Pasar a…</button>');
    a.push('<button class="sec" data-act="gather">Juntar ⇤</button>');
    a.push('<button class="sec" data-act="clearSel">✕</button>');
  } else if (tsel) {
    if (tsel.c) a.push('<button data-act="takeCard">Tomar carta</button>');
    a.push('<button data-act="takeGroup">Tomar grupo</button>');
    a.push('<button class="sec" data-act="clearSel">✕</button>');
  } else {
    if (S.turn === pid) a.push('<button data-act="endTurn">Terminar turno ▶</button>');
    a.push('<button class="sec" data-act="sortSuit">Ordenar palo</button>');
    a.push('<button class="sec" data-act="sortRank">Ordenar número</button>');
  }
  a.push('<button class="sec" data-act="menu">☰ Menú</button>');
  $('#acts').innerHTML = a.join('');

  $('#hand').innerHTML = hand.length ? hand.map((c) => cardHTML(c, 'data-id="' + c.id + '"', sel.includes(c.id) ? 'sel' : '')).join('')
    : '<div class="info">No tienes cartas. Abre ☰ Menú para empezar y repartir.</div>';

  if (sheet) renderSheet();
}

function renderSheet() {
  const me = meP();
  let h = '';
  if (sheet === 'give') {
    h += '<h3>Pasar ' + sel.length + ' carta(s) a</h3><div class="row">';
    h += S.players.filter((p) => p.id !== pid).map((p) => '<button data-give="' + p.id + '">' + esc(p.name) + '</button>').join('') || 'No hay más jugadores';
    h += '</div><div class="row" style="margin-top:14px"><button class="sec" data-act="close">Cancelar</button></div>';
  } else {
    const c = S.config;
    const deckVal = c.type === 'spanish' ? (c.spanish48 ? 'sp48' : 'sp40') : 'fr';
    h += '<h3>Partida nueva</h3>';
    h += '<div class="row"><select id="cfgDeck">' +
      [['fr', 'Francesa (52) ♠♥♦♣'], ['sp40', 'Española (40) 🪙🏆⚔️🪵'], ['sp48', 'Española (48, con 8 y 9)']].map((o) => '<option value="' + o[0] + '"' + (o[0] === deckVal ? ' selected' : '') + '>' + o[1] + '</option>').join('') +
      '</select><select id="cfgCopies">' + [1, 2, 3].map((n) => '<option value="' + n + '"' + (n === c.copies ? ' selected' : '') + '>' + n + ' baraja' + (n > 1 ? 's' : '') + '</option>').join('') + '</select></div>';
    h += '<div class="row"><label><input type="checkbox" id="cfgJokers"' + (c.jokers ? ' checked' : '') + '> Con 2 jokers por baraja</label></div>';
    h += '<div class="row"><button data-act="newGame">Barajar y empezar</button></div>';
    h += '<h3>Repartir</h3><div class="row"><input id="dealN" type="number" min="1" max="40" value="' + (store.get('dealN') || 7) + '" style="width:80px"> cartas a cada uno <button data-act="deal">Repartir</button></div>';
    h += '<h3>Mazo</h3><div class="row"><button class="sec" data-act="flip">Voltear al descarte</button><button class="sec" data-act="toTable">Voltear a la mesa</button></div>';
    h += '<div class="row"><button class="sec" data-act="recycle">Descarte → mazo</button><button class="sec" data-act="shuffleDeck">Barajar mazo</button></div>';
    h += '<h3>Mi mano</h3><div class="row"><button class="sec" data-act="reveal">' + (me && me.revealed ? 'Ocultar mi mano' : 'Mostrar mi mano a todos') + '</button></div>';
    h += '<h3>Jugadores</h3>' + S.players.map((p) => '<div class="row"><span style="flex:1">' + esc(p.name) + (p.online ? '' : ' (desconectado)') + '</span><button class="sec" data-turn="' + p.id + '">Darle el turno</button><button class="warn" data-kick="' + p.id + '">Sacar</button></div>').join('');
    h += '<div class="row" style="margin-top:16px"><button data-act="close" style="flex:1">Cerrar</button></div>';
  }
  $('#sheet').innerHTML = h;
}

function openSheet(k) { sheet = k; renderSheet(); $('#ov').hidden = false; }
function closeSheet() { sheet = null; $('#ov').hidden = true; }

function reorder(cards) { act('reorder', { cards: cards.map((c) => c.id) }); }

async function doAct(k) {
  const hand = meP().hand;
  switch (k) {
    case 'draw': case 'drawDiscard': case 'endTurn': case 'flip': case 'toTable': case 'reveal': case 'shuffleDeck':
      act(k); break;
    case 'recycle':
      if (confirm('¿Rebarajar el descarte en el mazo (dejando la carta de arriba)?')) act(k); break;
    case 'play': act('play', { cards: sel }); sel = []; break;
    case 'add': act('play', { cards: sel, group: tsel.g }); sel = []; tsel = null; break;
    case 'discard': act('discard', { cards: sel }); sel = []; break;
    case 'giveMenu': openSheet('give'); return;
    case 'gather': reorder(sel.map((id) => hand.find((c) => c.id === id)).concat(hand.filter((c) => !sel.includes(c.id)))); sel = []; break;
    case 'clearSel': sel = []; tsel = null; render(); break;
    case 'takeCard': act('take', { group: tsel.g, card: tsel.c }); tsel = null; break;
    case 'takeGroup': act('take', { group: tsel.g }); tsel = null; break;
    case 'sortSuit': reorder(hand.slice().sort((a, b) => SUIT_ORDER[a.s] - SUIT_ORDER[b.s] || rankVal(a.r) - rankVal(b.r))); break;
    case 'sortRank': reorder(hand.slice().sort((a, b) => rankVal(a.r) - rankVal(b.r) || SUIT_ORDER[a.s] - SUIT_ORDER[b.s])); break;
    case 'menu': openSheet('menu'); return;
    case 'close': closeSheet(); return;
    case 'newGame': {
      if (!confirm('¿Empezar partida nueva? Se recogen todas las cartas (los puntajes se mantienen).')) return;
      const d = $('#cfgDeck').value;
      const ok = await act('newGame', { config: { type: d === 'fr' ? 'french' : 'spanish', spanish48: d === 'sp48', jokers: $('#cfgJokers').checked, copies: +$('#cfgCopies').value } });
      if (ok) closeSheet();
      return;
    }
    case 'deal': {
      const n = +$('#dealN').value; store.set('dealN', n);
      if (await act('deal', { n: n })) closeSheet();
      return;
    }
  }
  if (sheet && k !== 'reveal') closeSheet();
}

document.addEventListener('click', (e) => {
  if (e.target.id === 'ov') return closeSheet();
  const t = e.target.closest('[data-id],[data-tc],[data-g],[data-act],[data-score],[data-give],[data-kick],[data-turn]');
  if (!t || !S) return;
  const ds = t.dataset;
  if (ds.id) { sel = sel.includes(ds.id) ? sel.filter((x) => x !== ds.id) : sel.concat(ds.id); return render(); }
  if (ds.tc) {
    const g = t.closest('[data-g]').dataset.g;
    tsel = tsel && tsel.c === ds.tc ? null : { g: g, c: ds.tc };
    return render();
  }
  if (ds.g) { tsel = tsel && tsel.g === ds.g && !tsel.c ? null : { g: ds.g, c: null }; return render(); }
  if (ds.score) return act('score', { target: ds.score, d: +ds.d });
  if (ds.give) { act('give', { to: ds.give, cards: sel }); sel = []; return closeSheet(); }
  if (ds.turn) { act('setTurn', { target: ds.turn }); return closeSheet(); }
  if (ds.kick) {
    const p = S.players.find((x) => x.id === ds.kick);
    if (p && confirm('¿Sacar a ' + p.name + ' de la mesa? Sus cartas vuelven al mazo.')) act('kick', { target: ds.kick });
    return;
  }
  if (ds.act) doAct(ds.act);
});

function join() {
  const n = $('#name').value.trim();
  if (!n) return toast('Escribe tu nombre');
  store.set('name', n);
  act('join', { name: n });
}
$('#joinBtn').onclick = join;
$('#name').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
connect();
</script>
</body>
</html>
__HTML__*/
