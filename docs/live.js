// Live table: one phone hosts (runs MesaEngine), the others connect to it directly
// over WebRTC (see net.js). Pairing = two QR scans per guest. No server, no internet.
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const E = window.MesaEngine, N = window.Net;
  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');

  // Secret identity: proves to the host that you're the same player after a reconnect.
  let pid = ls.get('cartas-pid');
  if (typeof pid !== 'string' || pid.length < 16) { pid = hex(16); ls.set('cartas-pid', pid); }
  const getName = () => ls.get('cartas-myname') || '';
  const setName = (n) => ls.set('cartas-myname', n);

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
  function say(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200); }
  function link(kind, code) { return location.origin + location.pathname + '#' + kind + '=' + code; }
  function qrSvg(text) { const q = qrcode(0, 'L'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 3, scalable: true }); }
  function send(dc, m) { try { if (dc.readyState === 'open') dc.send(JSON.stringify(m)); } catch (e) {} }

  // ---------- state ----------
  const L = { active: false, role: null, screen: 'pair', pair: null };
  let S = null, sel = [], tsel = null, sheet = null;
  let H = null;                 // host: { state, seat }
  const conns = new Map();      // host: seat -> conn
  let invite = null;            // host: current invitation
  let slot = crypto.getRandomValues(new Uint8Array(1))[0];
  let G = null;                 // guest: { o, pending, next, lost }
  let scanStop = null;

  function stopScan() { if (scanStop) scanStop(); scanStop = null; }
  function attachVideo(el, stream) {
    if (!el || !stream) return;
    el.srcObject = stream;
    el.setAttribute('playsinline', ''); el.muted = true;
    const p = el.play(); if (p && p.catch) p.catch(() => {});
  }

  // ---------- wake lock (phones that sleep drop the connection) ----------
  let wake = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && !wake && document.visibilityState === 'visible') {
        wake = await navigator.wakeLock.request('screen');
        wake.addEventListener('release', () => { wake = null; });
      }
    } catch (e) {}
  }
  function releaseWake() { try { if (wake) wake.release(); } catch (e) {} wake = null; }
  document.addEventListener('visibilitychange', () => { if (L.active) keepAwake(); });

  // ---------- screens ----------
  function enter() { L.active = true; $('#live').hidden = false; keepAwake(); window.appRender(); }
  function pairStep(step, data) { L.screen = 'pair'; L.pair = Object.assign({ step: step }, data || {}); enter(); renderPair(); }
  function enterTable() { L.screen = 'table'; stopScan(); N.closeCamera(); enter(); renderPair(); renderTable(); }

  function exit(wipe) {
    closeSheet(); stopScan(); N.closeCamera();
    if (L.role === 'host') {
      conns.forEach((c) => { c.dropped = true; try { c.pc.close(); } catch (e) {} });
      conns.clear();
      if (invite && invite.o) try { invite.o.pc.close(); } catch (e) {}
      invite = null;
      if (wipe) ls.del('cartas-live-host');
      H = null;
    } else if (G) {
      G.lost = true; try { G.o.pc.close(); } catch (e) {}
      G = null;
    }
    if (wipe) ls.del('cartas-live-role');
    S = null; sel = []; tsel = null;
    L.active = false; L.role = null;
    $('#live').hidden = true; releaseWake();
    window.appRender();
  }

  // ================= HOST =================
  function saveHost() { ls.set('cartas-live-host', H); }
  function onlineMap() {
    const o = {}; o[H.seat] = true;
    conns.forEach((c, seat) => { if (c.up) o[seat] = true; });
    return o;
  }
  function broadcast() {
    if (!H) return;
    const on = onlineMap();
    conns.forEach((c, seat) => send(c.dc, { t: 'view', v: E.view(H.state, seat, on, H.seat) }));
    S = E.view(H.state, H.seat, on, H.seat);
    if (L.screen === 'table') renderTable();
  }
  function hostAct(seat, msg) {
    if (msg.type === 'kick' && msg.target === H.seat) throw new Error('El anfitrión no puede sacarse a sí mismo');
    E.handle(H.state, seat, msg);
    if (msg.type === 'kick') {
      const c = conns.get(msg.target);
      if (c) { send(c.dc, { t: 'kicked' }); conns.delete(msg.target); c.dropped = true; setTimeout(() => { try { c.pc.close(); } catch (e) {} }, 400); }
    }
    saveHost(); broadcast();
  }

  function startHost(name) {
    setName(name);
    const state = E.fresh();
    H = { state: state, seat: E.join(state, pid, name) };
    L.role = 'host'; ls.set('cartas-live-role', 'host'); saveHost();
    broadcast(); enterTable(); openInvite();
  }
  function resumeHost() {
    const saved = ls.get('cartas-live-host');
    if (!saved || !saved.state) return;
    H = saved;
    if (!H.state.players[H.seat]) H.seat = E.join(H.state, pid, getName() || 'Anfitrión');
    L.role = 'host';
    broadcast(); enterTable();
    if (H.state.order.length > 1) say('Mesa recuperada. Toca «＋ Invitar» para que los demás se reconecten (conservan sus cartas).');
  }

  function wireHostConn(o) {
    const c = { pc: o.pc, dc: o.dc, seat: null, up: false };
    o.dc.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } hostMsg(c, m); };
    o.dc.onclose = () => dropConn(c);
    o.pc.onconnectionstatechange = () => {
      const st = o.pc.connectionState;
      if (st === 'failed' || st === 'closed') {
        if (invite && invite.o === o && !invite.done) setInv('No se pudo conectar. ¿Están en el mismo Wi-Fi o hotspot? Algunos Wi-Fi de avión aíslan a los pasajeros: prueben con el hotspot de un Android.', true, true);
        dropConn(c);
      } else if (c.seat) {
        const up = st === 'connected';
        if (up !== c.up) { c.up = up; broadcast(); }
      }
    };
    return c;
  }
  function hostMsg(c, m) {
    if (m.t === 'hello') {
      if (typeof m.pid !== 'string' || m.pid.length < 16) return;
      if (m.pid === pid) { send(c.dc, { t: 'kicked' }); return dropConn(c); } // same browser as the host
      const seat = E.join(H.state, m.pid, m.name);
      const old = conns.get(seat);
      if (old && old !== c) { old.dropped = true; try { old.pc.close(); } catch (e) {} }
      c.seat = seat; c.up = true; conns.set(seat, c);
      send(c.dc, { t: 'welcome', seat: seat });
      saveHost(); broadcast();
      if (invite && invite.o.dc === c.dc) inviteDone(H.state.players[seat].name);
      return;
    }
    if (!c.seat || conns.get(c.seat) !== c) return;
    if (m.t === 'act') {
      try { hostAct(c.seat, m.msg || {}); send(c.dc, { t: 'res', id: m.id, ok: true }); }
      catch (err) { send(c.dc, { t: 'res', id: m.id, ok: false, error: err.message }); }
    }
  }
  function dropConn(c) {
    if (c.dropped) return;
    c.dropped = true;
    try { c.pc.close(); } catch (e) {}
    if (c.seat && conns.get(c.seat) === c) { conns.delete(c.seat); broadcast(); }
  }

  // ----- invitation sheet: show offer QR, scan the guest's answer QR -----
  async function openInvite() {
    sheet = 'invite';
    $('#lsheet').innerHTML =
      '<h3>Invitar jugador</h3>' +
      '<div class="muted" style="font-size:13px">1. El otro jugador escanea este código (con la cámara del teléfono o en la app: «Unirme»).</div>' +
      '<div class="qr big" id="ivQr" style="margin-top:10px"><div class="muted" style="color:#555;padding-top:90px;text-align:center">Preparando…</div></div>' +
      '<div class="muted" style="font-size:13px;margin-top:12px">2. Su teléfono mostrará otro código: apunta tu cámara a él.</div>' +
      '<video id="ivCam" class="cam" playsinline muted autoplay></video>' +
      '<div id="ivStatus" class="status"></div><div id="ivJoined" class="status ok"></div>' +
      '<details style="margin-top:10px"><summary class="muted">Sin cámara: copiar / pegar códigos</summary>' +
      '<div class="row" style="margin-top:8px"><button class="sec" data-act="copyOffer">Copiar invitación</button></div>' +
      '<div class="row"><input id="ivPaste" placeholder="Pega aquí la respuesta" style="flex:1;min-width:0"><button data-act="pasteAnswer">Usar</button></div></details>' +
      '<div class="row" style="margin-top:14px"><button data-act="close" style="flex:1">Listo</button></div>';
    $('#lov').hidden = false;
    let cam = null;
    try { cam = await N.openCamera(); } catch (e) { setInv('Sin cámara (' + (e.message || e.name) + '). Usa copiar / pegar abajo.', true); }
    if (sheet !== 'invite') { N.closeCamera(); return; }
    if (cam) attachVideo($('#ivCam'), cam); else $('#ivCam').hidden = true;
    await nextInvite();
  }
  async function nextInvite() {
    if (invite && invite.o && !invite.used) try { invite.o.pc.close(); } catch (e) {}
    invite = null; stopScan();
    slot = (slot + 1) & 255;
    try {
      const o = await N.createInvite(slot);
      if (sheet !== 'invite') { o.pc.close(); return; }
      invite = { o: o, used: false, done: false };
      wireHostConn(o);
      $('#ivQr').innerHTML = qrSvg(link('o', o.code));
      setInv('Esperando que escaneen tu código…');
      startAnswerScan();
    } catch (e) {
      $('#ivQr').innerHTML = '<div style="color:#7f1d1d;padding:20px;text-align:center">' + esc(e.message) + '</div>';
      setInv(e.message, true, true);
    }
  }
  function setInv(msg, bad, retry) {
    const el = $('#ivStatus'); if (!el) return;
    el.className = 'status' + (bad ? ' bad' : '');
    el.innerHTML = esc(msg) + (retry ? ' <button class="sec" data-act="newInvite">Reintentar</button>' : '');
  }
  function startAnswerScan() {
    stopScan();
    const v = $('#ivCam');
    if (!v || !v.srcObject) return;
    scanStop = N.scan(v, (text) => { useAnswer(text); return true; });
  }
  async function useAnswer(text) {
    try {
      if (!invite || !invite.o) throw new Error('Espera a que aparezca el código de invitación');
      if (invite.used) return;
      const a = N.extract(text);
      await invite.o.accept(a);
      invite.used = true;
      setInv('Conectando…');
      const inv = invite;
      setTimeout(() => { if (inv === invite && !inv.done) setInv('Sigue sin conectar. ¿Están en el mismo Wi-Fi o hotspot?', true, true); }, 15000);
    } catch (e) {
      say(e.message);
      setTimeout(() => { if (sheet === 'invite' && invite && !invite.used) startAnswerScan(); }, 1500);
    }
  }
  function inviteDone(name) {
    invite.done = true;
    const j = $('#ivJoined');
    if (j) j.textContent = '✓ ' + name + ' está en la mesa. Puedes invitar a otro o tocar «Listo».';
    if (navigator.vibrate) navigator.vibrate(80);
    nextInvite();
  }

  // ================= GUEST =================
  function startJoin(offerCode) {
    L.role = 'guest'; ls.set('cartas-live-role', 'guest');
    if (offerCode) {
      let offer;
      try { offer = N.decode(offerCode); } catch (e) { return pairStep('name', { error: e.message }); }
      if (getName()) return gotOffer(offer);
      return pairStep('name', { offer: offer });
    }
    pairStep('name');
  }
  async function guestScan() {
    pairStep('scan');
    let cam;
    try { cam = await N.openCamera(); }
    catch (e) { return pairStep('name', { error: 'No se pudo abrir la cámara (' + (e.message || e.name) + '). Escanea el código del anfitrión con la app Cámara del teléfono, o pega el código abajo.' }); }
    if (L.pair.step !== 'scan') { N.closeCamera(); return; }
    attachVideo($('#gCam'), cam);
    scanStop = N.scan($('#gCam'), (text) => {
      let offer;
      try { offer = N.extract(text); } catch (e) { say(e.message); return false; }
      if (offer.kind !== 'o') { say('Ese es el código de un jugador. Escanea el del anfitrión.'); return false; }
      gotOffer(offer); // camera still open here: helps reveal the real IP
      return true;
    });
  }
  async function gotOffer(offer) {
    stopScan();
    if (G) { G.lost = true; try { G.o.pc.close(); } catch (e) {} G = null; }
    pairStep('answer', { status: 'Preparando…' });
    try {
      const o = await N.acceptInvite(offer);
      N.closeCamera();
      wireGuest(o);
      pairStep('answer', { code: o.code, status: 'Muéstrale este código al anfitrión para que lo escanee.' });
    } catch (e) {
      N.closeCamera();
      pairStep('name', { error: e.message });
    }
  }
  function wireGuest(o) {
    const g = G = { o: o, pending: new Map(), next: 1, lost: false };
    o.dc.onopen = () => send(o.dc, { t: 'hello', pid: pid, name: getName() });
    o.dc.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } if (G === g) guestMsg(m); };
    o.dc.onclose = () => { if (G === g) guestLost(); };
    o.pc.onconnectionstatechange = () => {
      if (G !== g) return;
      const st = o.pc.connectionState;
      if (st === 'connecting' && L.screen === 'pair') setPairStatus('Conectando…');
      if (st === 'failed') guestLost();
      setDot(st === 'connected' && o.dc.readyState === 'open');
    };
  }
  function guestMsg(m) {
    if (m.t === 'welcome') { enterTable(); setDot(true); if (navigator.vibrate) navigator.vibrate(80); }
    else if (m.t === 'view') { S = m.v; if (L.screen === 'table') renderTable(); }
    else if (m.t === 'res') { const f = G.pending.get(m.id); if (f) { G.pending.delete(m.id); f(m); } }
    else if (m.t === 'kicked') { G.lost = true; exit(true); alert('El anfitrión te sacó de la mesa.'); }
  }
  function guestLost() {
    if (!G || G.lost) return;
    G.lost = true;
    G.pending.forEach((f) => f({ ok: false, error: 'Sin conexión con el anfitrión' }));
    G.pending.clear();
    setDot(false);
    if (L.screen === 'pair') return pairStep('name', { error: 'No se pudo conectar. Asegúrense de estar en el mismo Wi-Fi o hotspot. Algunos Wi-Fi de avión aíslan a los pasajeros: en ese caso usen el hotspot de un teléfono Android.' });
    renderTable();
  }
  function guestAct(type, data) {
    if (!G || G.lost || G.o.dc.readyState !== 'open') { say('Sin conexión con el anfitrión'); return Promise.resolve(false); }
    const id = G.next++;
    send(G.o.dc, { t: 'act', id: id, msg: Object.assign({ type: type }, data || {}) });
    return new Promise((res) => {
      const t = setTimeout(() => { if (G) G.pending.delete(id); say('El anfitrión no responde'); res(false); }, 8000);
      G.pending.set(id, (m) => { clearTimeout(t); if (!m.ok) say(m.error); res(m.ok); });
    });
  }

  function act(type, data) {
    if (L.role === 'host') {
      try { hostAct(H.seat, Object.assign({ type: type }, data || {})); return Promise.resolve(true); }
      catch (e) { say(e.message); return Promise.resolve(false); }
    }
    return guestAct(type, data);
  }

  // ================= RENDER =================
  function setDot(on) { const d = $('#lvDot'); if (d) d.className = 'dot' + (on ? ' on' : ''); }
  function setPairStatus(t) { const el = $('#pStatus'); if (el) el.textContent = t; }

  function renderPair() {
    $('#lvPair').hidden = L.screen !== 'pair';
    $('#lvGame').hidden = L.screen !== 'table';
    if (L.screen !== 'pair') return;
    const p = L.pair;
    let h = '<h1>🃏 Mesa en vivo</h1>';
    if (p.error) h += '<div class="box bad">' + esc(p.error) + '</div>';
    if (p.step === 'hostName') {
      h += '<div class="box"><h3>Tu nombre</h3><input id="pName" maxlength="16" placeholder="Tu nombre" value="' + esc(getName()) + '" autocomplete="off" style="width:100%">';
      h += '<div class="muted" style="font-size:13px;margin-top:10px">Tu teléfono será la mesa: guarda el mazo y las manos y los demás se conectan a él. Mantén la app abierta mientras juegan.</div>';
      h += '<div class="row" style="margin-top:14px"><button class="big" data-act="hostGo">Crear mesa</button><button class="sec" data-act="exit">Volver</button></div></div>';
    } else if (p.step === 'name') {
      h += '<div class="box"><h3>Tu nombre</h3><input id="pName" maxlength="16" placeholder="Tu nombre" value="' + esc(getName()) + '" autocomplete="off" style="width:100%">';
      if (p.offer) h += '<div class="row" style="margin-top:14px"><button class="big" data-act="useOffer">Unirme a la mesa</button></div>';
      else h += '<div class="row" style="margin-top:14px"><button class="big" data-act="gScan">📷 Escanear código del anfitrión</button></div>';
      h += '<div class="muted" style="font-size:13px;margin-top:12px">Todos conectados al mismo Wi-Fi o hotspot (no hace falta internet). El anfitrión toca «＋ Invitar» y te muestra un código.</div>';
      h += '<details style="margin-top:10px"><summary class="muted">Sin cámara: pegar código</summary><div class="row" style="margin-top:8px"><input id="pPaste" placeholder="Pega la invitación" style="flex:1;min-width:0"><button data-act="pasteOffer">Usar</button></div></details>';
      h += '<div class="row" style="margin-top:14px"><button class="sec" data-act="exit">Volver</button></div></div>';
    } else if (p.step === 'scan') {
      h += '<div class="box"><div class="muted" style="margin-bottom:8px">Apunta al código QR que muestra el anfitrión</div><video id="gCam" class="cam" playsinline muted autoplay></video>';
      h += '<div class="row" style="margin-top:14px"><button class="sec" data-act="toName">Cancelar</button></div></div>';
    } else if (p.step === 'answer') {
      h += '<div class="box">';
      if (p.code) h += '<div class="qr big">' + qrSvg(link('a', p.code)) + '</div>';
      h += '<div class="status" id="pStatus" style="text-align:center">' + esc(p.status || '') + '</div>';
      if (p.code) h += '<details style="margin-top:10px"><summary class="muted">Sin cámara: copiar código</summary><div class="row" style="margin-top:8px"><button class="sec" data-act="copyAnswer">Copiar respuesta</button></div></details>';
      h += '<div class="row" style="margin-top:14px"><button class="sec" data-act="toName">Cancelar</button></div></div>';
    }
    $('#lvPairWrap').innerHTML = h;
  }

  function meP() { return S && S.players.find((p) => p.id === S.me); }

  function renderTable() {
    if (L.screen !== 'table' || !S) return;
    const me = meP();
    if (!me) return;
    const hand = me.hand || [];
    const isHost = L.role === 'host';
    sel = sel.filter((id) => hand.some((c) => c.id === id));
    if (tsel) {
      const g = S.table.find((g) => g.id === tsel.g);
      if (!g) tsel = null; else if (tsel.c && !g.cards.some((c) => c.id === tsel.c)) tsel.c = null;
    }
    const lost = !isHost && (!G || G.lost);
    setDot(isHost || (!lost && G.o.dc.readyState === 'open'));
    $('#lvBanner').hidden = !lost;
    if (lost) $('#lvBanner').innerHTML = 'Se perdió la conexión con el anfitrión. <button data-act="reconnect">Reconectar</button>';

    $('#lvPlayers').innerHTML = S.players.map((p) =>
      '<div class="pl ' + (p.id === S.turn ? 'turn ' : '') + (p.online ? '' : 'off') + '">' +
      '<div class="n">' + (p.id === S.turn ? '▶ ' : '') + (p.id === S.host ? '★ ' : '') + esc(p.name) + (p.id === S.me ? ' (tú)' : '') + '</div>' +
      '<div>🂠 ' + p.count + (p.revealed ? ' · 👁' : '') + (p.online ? '' : ' · ⚠︎') + '</div>' +
      '<div class="sc"><button class="sec" data-score="' + p.id + '" data-d="-1">−</button><b>' + p.score + '</b><button class="sec" data-score="' + p.id + '" data-d="1">+</button></div></div>'
    ).join('') + (isHost ? '<button class="pl inv" data-act="invite">＋ Invitar</button>' : '');

    $('#lvLog').innerHTML = S.log.slice(-3).map((l) => '<div>' + esc(l) + '</div>').join('');

    const top = S.discard[S.discard.length - 1];
    $('#lvPiles').innerHTML =
      '<div class="pile" data-act="draw">' + (S.deckCount ? '<div class="card back"></div>' : '<div class="card empty"></div>') + '<div>Mazo (' + S.deckCount + ')</div><div>toca = robar</div></div>' +
      '<div class="pile" data-act="drawDiscard">' + (top ? cardHTML(top) : '<div class="card empty"></div>') + '<div>Descarte (' + S.discardCount + ')</div><div>toca = tomar</div></div>';

    let tableHtml = S.table.length ? S.table.map((g) =>
      '<div class="grp owned ' + (tsel && tsel.g === g.id ? 'gsel' : '') + '" data-g="' + g.id + '"><span class="who">' + esc(g.owner || '') + '</span>' +
      g.cards.map((c) => cardHTML(c, 'data-tc="' + c.id + '"', tsel && tsel.c === c.id ? 'tsel' : '')).join('') + '</div>'
    ).join('') : '<div class="empty-msg" style="text-align:center;width:100%;padding:16px 0">Mesa vacía · selecciona cartas de tu mano y toca «Bajar»</div>';
    if (isHost && S.players.length < 2) tableHtml = '<div class="box" style="width:100%;text-align:center">Estás solo en la mesa.<div class="row" style="justify-content:center;margin-top:10px"><button class="big" data-act="invite">＋ Invitar jugadores</button></div></div>' + tableHtml;
    $('#lvTable').innerHTML = tableHtml;

    $('#lvRevealed').innerHTML = S.players.filter((p) => p.id !== S.me && p.hand).map((p) =>
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
      if (S.turn === S.me) a.push('<button data-act="endTurn">Terminar turno ▶</button>');
      a.push('<button class="sec" data-act="sortSuit">Ordenar palo</button>');
      a.push('<button class="sec" data-act="sortRank">Ordenar número</button>');
    }
    a.push('<button class="sec" data-act="menu">☰ Menú</button>');
    $('#lvActs').innerHTML = a.join('');

    $('#lvHand').innerHTML = hand.length ? hand.map((c) => cardHTML(c, 'data-id="' + c.id + '"', sel.indexOf(c.id) >= 0 ? 'sel' : '')).join('')
      : '<div class="empty-msg" style="align-self:center">No tienes cartas. Abre ☰ Menú para empezar y repartir.</div>';

    if (sheet && sheet !== 'invite') renderSheet();
  }

  function renderSheet() {
    const me = meP();
    const isHost = L.role === 'host';
    let h = '';
    if (sheet === 'give') {
      h += '<h3>Pasar ' + sel.length + ' carta(s) a</h3><div class="row">';
      h += S.players.filter((p) => p.id !== S.me).map((p) => '<button data-give="' + p.id + '">' + esc(p.name) + '</button>').join('') || 'No hay más jugadores';
      h += '</div><div class="row" style="margin-top:14px"><button class="sec" data-act="close">Cancelar</button></div>';
    } else {
      const c = S.config;
      const deckVal = c.type === 'spanish' ? (c.spanish48 ? 'sp48' : 'sp40') : 'fr';
      if (isHost) h += '<div class="row"><button data-act="invite" style="flex:1">＋ Invitar / reconectar jugadores</button></div>';
      h += '<h3>Partida nueva</h3>';
      h += '<div class="row"><select id="cfgDeck">' +
        [['fr', 'Francesa (52) ♠♥♦♣'], ['sp40', 'Española (40) 🪙🏆⚔️🪵'], ['sp48', 'Española (48, con 8 y 9)']].map((o) => '<option value="' + o[0] + '"' + (o[0] === deckVal ? ' selected' : '') + '>' + o[1] + '</option>').join('') +
        '</select><select id="cfgCopies">' + [1, 2, 3].map((n) => '<option value="' + n + '"' + (n === c.copies ? ' selected' : '') + '>' + n + ' baraja' + (n > 1 ? 's' : '') + '</option>').join('') + '</select></div>';
      h += '<div class="row"><label><input type="checkbox" id="cfgJokers"' + (c.jokers ? ' checked' : '') + '> Con 2 jokers por baraja</label></div>';
      h += '<div class="row"><button data-act="newGame">Barajar y empezar</button></div>';
      h += '<h3>Repartir</h3><div class="row"><input id="dealN" type="number" min="1" max="40" value="' + (ls.get('dealN') || 7) + '" style="width:80px"> cartas a cada uno <button data-act="deal">Repartir</button></div>';
      h += '<h3>Mazo</h3><div class="row"><button class="sec" data-act="flip">Voltear al descarte</button><button class="sec" data-act="toTable">Voltear a la mesa</button></div>';
      h += '<div class="row"><button class="sec" data-act="recycle">Descarte → mazo</button><button class="sec" data-act="shuffleDeck">Barajar mazo</button></div>';
      h += '<h3>Mi mano</h3><div class="row"><button class="sec" data-act="reveal">' + (me && me.revealed ? 'Ocultar mi mano' : 'Mostrar mi mano a todos') + '</button></div>';
      h += '<h3>Jugadores</h3>' + S.players.map((p) => '<div class="row"><span style="flex:1">' + (p.id === S.host ? '★ ' : '') + esc(p.name) + (p.online ? '' : ' (desconectado)') + '</span><button class="sec" data-turn="' + p.id + '">Darle el turno</button>' + (p.id === S.host ? '' : '<button class="warn" data-kick="' + p.id + '">Sacar</button>') + '</div>').join('');
      h += '<h3>Mesa</h3>';
      if (isHost) h += '<div class="row"><button class="sec" data-act="leave">Volver al inicio (la mesa queda guardada)</button></div><div class="row"><button class="warn" data-act="endMesa">Terminar mesa</button></div>';
      else h += '<div class="row"><button class="warn" data-act="leave">Salir de la mesa</button></div>';
      h += '<div class="row" style="margin-top:16px"><button data-act="close" style="flex:1">Cerrar</button></div>';
    }
    $('#lsheet').innerHTML = h;
  }

  function openSheet(k) { sheet = k; renderSheet(); $('#lov').hidden = false; }
  function closeSheet() {
    if (sheet === 'invite') {
      stopScan(); N.closeCamera();
      if (invite && invite.o && !invite.used) try { invite.o.pc.close(); } catch (e) {}
      invite = null;
    }
    sheet = null; $('#lov').hidden = true;
  }

  function reorder(cards) { act('reorder', { cards: cards.map((c) => c.id) }); }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => say('Copiado'), () => prompt('Copia este código:', text));
    else prompt('Copia este código:', text);
  }
  function readName() {
    const n = ($('#pName') && $('#pName').value || '').trim().slice(0, 16);
    if (!n) { say('Escribe tu nombre'); return null; }
    setName(n); return n;
  }

  async function doAct(k) {
    const me = meP(), hand = (me && me.hand) || [];
    switch (k) {
      // pairing
      case 'exit': return exit(false);
      case 'hostGo': { const n = readName(); if (n) startHost(n); return; }
      case 'gScan': if (readName()) guestScan(); return;
      case 'useOffer': if (readName()) gotOffer(L.pair.offer); return;
      case 'pasteOffer': {
        if (!readName()) return;
        let o; try { o = N.extract($('#pPaste').value); } catch (e) { return say(e.message); }
        if (o.kind !== 'o') return say('Eso es una respuesta, no una invitación');
        return gotOffer(o);
      }
      case 'toName': stopScan(); N.closeCamera(); if (G) { G.lost = true; try { G.o.pc.close(); } catch (e) {} G = null; } return pairStep('name');
      case 'copyAnswer': return copy(link('a', L.pair.code));
      case 'reconnect': return pairStep('name');
      // host invitation
      case 'invite': return openInvite();
      case 'newInvite': return nextInvite();
      case 'copyOffer': if (invite && invite.o) copy(link('o', invite.o.code)); return;
      case 'pasteAnswer': return useAnswer($('#ivPaste').value);
      // table
      case 'draw': case 'drawDiscard': case 'endTurn': case 'flip': case 'toTable': case 'reveal': case 'shuffleDeck':
        act(k); break;
      case 'recycle': if (confirm('¿Rebarajar el descarte en el mazo (dejando la carta de arriba)?')) act(k); break;
      case 'play': act('play', { cards: sel }); sel = []; break;
      case 'add': act('play', { cards: sel, group: tsel.g }); sel = []; tsel = null; break;
      case 'discard': act('discard', { cards: sel }); sel = []; break;
      case 'giveMenu': return openSheet('give');
      case 'gather': reorder(sel.map((id) => hand.find((c) => c.id === id)).concat(hand.filter((c) => sel.indexOf(c.id) < 0))); sel = []; break;
      case 'clearSel': sel = []; tsel = null; renderTable(); break;
      case 'takeCard': act('take', { group: tsel.g, card: tsel.c }); tsel = null; break;
      case 'takeGroup': act('take', { group: tsel.g }); tsel = null; break;
      case 'sortSuit': reorder(hand.slice().sort((a, b) => SUIT_ORDER[a.s] - SUIT_ORDER[b.s] || rankVal(a.r) - rankVal(b.r))); break;
      case 'sortRank': reorder(hand.slice().sort((a, b) => rankVal(a.r) - rankVal(b.r) || SUIT_ORDER[a.s] - SUIT_ORDER[b.s])); break;
      case 'menu': return openSheet('menu');
      case 'close': return closeSheet();
      case 'newGame': {
        if (!confirm('¿Empezar partida nueva? Se recogen todas las cartas (los puntajes se mantienen).')) return;
        const d = $('#cfgDeck').value;
        if (await act('newGame', { config: { type: d === 'fr' ? 'french' : 'spanish', spanish48: d === 'sp48', jokers: $('#cfgJokers').checked, copies: +$('#cfgCopies').value } })) closeSheet();
        return;
      }
      case 'deal': {
        const n = +$('#dealN').value; ls.set('dealN', n);
        if (await act('deal', { n: n })) closeSheet();
        return;
      }
      case 'leave':
        if (L.role === 'guest' && !confirm('¿Salir de la mesa? Puedes volver a unirte y recuperas tus cartas.')) return;
        if (L.role === 'host' && conns.size && !confirm('Los demás quedarán desconectados hasta que vuelvas y los invites de nuevo. ¿Seguir?')) return;
        return exit(false);
      case 'endMesa':
        if (!confirm('¿Terminar la mesa? Se borra la partida de todos.')) return;
        return exit(true);
    }
    if (sheet && k !== 'reveal') closeSheet();
  }

  document.addEventListener('click', (e) => {
    if (!L.active) return;
    if (e.target.id === 'lov') return closeSheet();
    if (!e.target.closest('#live,#lov')) return;
    const t = e.target.closest('[data-id],[data-tc],[data-g],[data-act],[data-score],[data-give],[data-kick],[data-turn]');
    if (!t) return;
    const ds = t.dataset;
    if (ds.act) return doAct(ds.act);
    if (!S) return;
    if (ds.id) { sel = sel.indexOf(ds.id) >= 0 ? sel.filter((x) => x !== ds.id) : sel.concat(ds.id); return renderTable(); }
    if (ds.tc) {
      const g = t.closest('[data-g]').dataset.g;
      tsel = tsel && tsel.c === ds.tc ? null : { g: g, c: ds.tc };
      return renderTable();
    }
    if (ds.g) { tsel = tsel && tsel.g === ds.g && !tsel.c ? null : { g: ds.g, c: null }; return renderTable(); }
    if (ds.score) return act('score', { target: ds.score, d: +ds.d });
    if (ds.give) { act('give', { to: ds.give, cards: sel }); sel = []; return closeSheet(); }
    if (ds.turn) { act('setTurn', { target: ds.turn }); return closeSheet(); }
    if (ds.kick) {
      const p = S.players.find((x) => x.id === ds.kick);
      if (p && confirm('¿Sacar a ' + p.name + ' de la mesa? Sus cartas vuelven al mazo.')) act('kick', { target: ds.kick });
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !L.active || !e.target || e.target.id !== 'pName') return;
    const step = L.pair && L.pair.step;
    doAct(step === 'hostName' ? 'hostGo' : L.pair.offer ? 'useOffer' : 'gScan');
  });

  window.Live = {
    get active() { return L.active; },
    hostSaved: () => !!(ls.get('cartas-live-host') || {}).state,
    lastRole: () => ls.get('cartas-live-role'),
    host: () => {
      if ((ls.get('cartas-live-host') || {}).state && !confirm('Ya tienes una mesa guardada. Crear una nueva la reemplaza. ¿Seguir?')) return;
      L.role = 'host'; pairStep('hostName');
    },
    resumeHost: resumeHost,
    join: () => startJoin(),
    openOffer: (code) => startJoin(code),
  };
})();
