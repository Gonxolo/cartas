// Net: phone-to-phone connections with no internet and no server.
//
// WebRTC data channels work between devices on the same local network (Android
// hotspot, plane Wi-Fi, travel router) with no STUN/TURN: each side just needs the
// other's "host" candidates. The only thing WebRTC can't do alone is the initial
// handshake (signaling), so we carry it in QR codes: host shows an offer, guest
// scans it and shows an answer, host scans that. After that it's a direct link.
//
// A full SDP is ~2 KB; everything that matters for a data channel is the ICE
// username/password, the DTLS fingerprint and the candidate addresses, so we pack
// just those into ~100 bytes and rebuild a standard SDP on the other side.
(function (root) {
  'use strict';
  const VERSION = 1;
  const SETUP = ['actpass', 'active', 'passive'];

  // ---------- base64url ----------
  function b64u(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64u(str) {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  // ---------- SDP <-> compact ----------
  function parseSdp(sdp) {
    const get = (re) => { const m = sdp.match(re); return m ? m[1].trim() : null; };
    const ufrag = get(/a=ice-ufrag:(\S+)/), pwd = get(/a=ice-pwd:(\S+)/);
    const fp = sdp.match(/a=fingerprint:(\S+) ([0-9A-Fa-f:]+)/);
    const setup = get(/a=setup:(\S+)/) || 'actpass';
    const mid = get(/a=mid:(\S+)/) || '0';
    if (!ufrag || !pwd || !fp) throw new Error('SDP incompleto');
    if (fp[1].toLowerCase() !== 'sha-256') throw new Error('Huella no soportada: ' + fp[1]);
    const cands = [], seen = new Set();
    const re = /a=candidate:\S+ (\d+) (\S+) \d+ (\S+) (\d+) typ (\S+)/g;
    let m;
    while ((m = re.exec(sdp))) {
      if (m[1] !== '1' || m[2].toLowerCase() !== 'udp' || m[5] !== 'host') continue;
      const key = m[3] + ' ' + m[4];
      if (seen.has(key)) continue;
      seen.add(key);
      cands.push({ addr: m[3], port: +m[4] });
    }
    return { ufrag: ufrag, pwd: pwd, fp: fp[2].split(':').map((h) => parseInt(h, 16)), setup: setup, mid: mid, cands: cands };
  }

  function ipv4Bytes(a) { const p = a.split('.'); return p.length === 4 && p.every((x) => /^\d+$/.test(x) && +x < 256) ? p.map(Number) : null; }
  function ipv6Bytes(a) {
    if (a.indexOf(':') < 0 || a.indexOf('%') >= 0) return null;
    let [head, tail] = a.split('::');
    const h = head ? head.split(':') : [], t = tail !== undefined ? (tail ? tail.split(':') : []) : null;
    let groups;
    if (t === null) groups = h; else groups = h.concat(Array(8 - h.length - t.length).fill('0'), t);
    if (groups.length !== 8 || !groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return null;
    const out = [];
    for (const g of groups) { const n = parseInt(g, 16); out.push(n >> 8, n & 255); }
    return out;
  }
  function uuidBytes(a) {
    const m = a.toLowerCase().match(/^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/);
    if (!m) return null;
    const hex = m.slice(1).join('');
    const out = [];
    for (let i = 0; i < 32; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
    return out;
  }
  const hex2 = (b) => b.toString(16).padStart(2, '0');

  // kind: 'o' offer or 'a' answer. slot: 0-255, lets the host match an answer to its invite.
  function encode(kind, slot, sdp) {
    const p = parseSdp(sdp);
    const b = [VERSION << 4 | (kind === 'a' ? 8 : 0) | Math.max(0, SETUP.indexOf(p.setup)), slot & 255];
    const str = (s) => { b.push(s.length); for (let i = 0; i < s.length; i++) b.push(s.charCodeAt(i)); };
    str(p.ufrag); str(p.pwd);
    if (p.fp.length !== 32) throw new Error('Huella inválida');
    b.push.apply(b, p.fp);
    const cands = [];
    for (const c of p.cands) {
      let t, bytes = ipv4Bytes(c.addr);
      if (bytes) t = 4; else if ((bytes = uuidBytes(c.addr))) t = 1; else if ((bytes = ipv6Bytes(c.addr))) t = 6;
      else { t = 0; bytes = Array.from(c.addr.slice(0, 63), (ch) => ch.charCodeAt(0)); bytes.unshift(bytes.length); }
      cands.push([t].concat(bytes, [c.port >> 8, c.port & 255]));
      if (cands.length >= 8) break;
    }
    b.push(cands.length);
    for (const c of cands) b.push.apply(b, c);
    return { code: b64u(Uint8Array.from(b)), cands: p.cands.length, mid: p.mid };
  }

  function decode(code) {
    const b = unb64u(code);
    let i = 0;
    const need = (n) => { if (i + n > b.length) throw new Error('Código cortado'); };
    need(2);
    const h = b[i++], slot = b[i++];
    if (h >> 4 !== VERSION) throw new Error('Código de otra versión de la app');
    const kind = h & 8 ? 'a' : 'o', setup = SETUP[h & 3] || 'actpass';
    const str = () => { need(1); const n = b[i++]; need(n); let s = ''; for (let k = 0; k < n; k++) s += String.fromCharCode(b[i++]); return s; };
    const ufrag = str(), pwd = str();
    need(32);
    const fp = Array.from(b.slice(i, i + 32)); i += 32;
    need(1);
    const n = b[i++], cands = [];
    for (let k = 0; k < n; k++) {
      need(1);
      const t = b[i++];
      let addr;
      if (t === 4) { need(4); addr = Array.from(b.slice(i, i + 4)).join('.'); i += 4; }
      else if (t === 1) {
        need(16); const x = Array.from(b.slice(i, i + 16), hex2).join(''); i += 16;
        addr = x.slice(0, 8) + '-' + x.slice(8, 12) + '-' + x.slice(12, 16) + '-' + x.slice(16, 20) + '-' + x.slice(20) + '.local';
      } else if (t === 6) {
        need(16); const g = []; for (let k2 = 0; k2 < 16; k2 += 2) g.push(((b[i + k2] << 8) | b[i + k2 + 1]).toString(16)); i += 16;
        addr = g.join(':');
      } else { addr = str(); }
      need(2);
      cands.push({ addr: addr, port: (b[i] << 8) | b[i + 1] }); i += 2;
    }
    return { kind: kind, slot: slot, setup: setup, ufrag: ufrag, pwd: pwd, fp: fp, cands: cands };
  }

  function buildSdp(c, type, mid) {
    mid = mid || '0';
    const sess = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
    const L = [
      'v=0', 'o=- ' + sess + ' 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
      'a=group:BUNDLE ' + mid, 'a=msid-semantic: WMS',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
    ];
    c.cands.forEach((x, k) => L.push('a=candidate:' + (k + 1) + ' 1 udp ' + (2122260223 - k) + ' ' + x.addr + ' ' + x.port + ' typ host generation 0'));
    L.push('a=end-of-candidates');
    L.push('a=ice-ufrag:' + c.ufrag, 'a=ice-pwd:' + c.pwd, 'a=ice-options:trickle');
    L.push('a=fingerprint:sha-256 ' + c.fp.map((x) => hex2(x).toUpperCase()).join(':'));
    L.push('a=setup:' + (type === 'offer' ? 'actpass' : (c.setup === 'actpass' ? 'active' : c.setup)));
    L.push('a=mid:' + mid, 'a=sctp-port:5000', 'a=max-message-size:262144');
    return L.join('\r\n') + '\r\n';
  }

  // ---------- peer connections ----------
  function newPc() {
    const pc = new RTCPeerConnection({ iceServers: [] });
    // negotiated channel: both sides create it with the same id, no in-band setup needed
    const dc = pc.createDataChannel('mesa', { negotiated: true, id: 0, ordered: true });
    return { pc: pc, dc: dc };
  }

  function gathered(pc, ms) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const done = () => { clearTimeout(t); pc.removeEventListener('icegatheringstatechange', chk); pc.removeEventListener('icecandidate', cand); resolve(); };
      const chk = () => { if (pc.iceGatheringState === 'complete') done(); };
      const cand = (e) => { if (!e.candidate) done(); };
      const t = setTimeout(done, ms || 3000);
      pc.addEventListener('icegatheringstatechange', chk);
      pc.addEventListener('icecandidate', cand);
    });
  }

  const NO_NET = 'Este teléfono no está conectado a ninguna red. Conéctense todos al mismo Wi-Fi o hotspot (no hace falta internet).';

  // Host side: returns { pc, dc, code, slot, accept(answerCode) }
  async function createInvite(slot) {
    const o = newPc();
    await o.pc.setLocalDescription(await o.pc.createOffer());
    await gathered(o.pc);
    const enc = encode('o', slot, o.pc.localDescription.sdp);
    if (!enc.cands) { o.pc.close(); throw new Error(NO_NET); }
    o.code = enc.code;
    o.slot = slot;
    o.accept = async function (answer) {
      if (answer.kind !== 'a') throw new Error('Ese es un código de invitación, no una respuesta');
      if (answer.slot !== slot) throw new Error('Esa respuesta es de otra invitación. Que vuelva a escanear tu código.');
      await o.pc.setRemoteDescription({ type: 'answer', sdp: buildSdp(answer, 'answer', enc.mid) });
    };
    return o;
  }

  // Guest side: takes the decoded offer, returns { pc, dc, code }
  async function acceptInvite(offer) {
    if (offer.kind !== 'o') throw new Error('Ese código es una respuesta; escanea el código de invitación del anfitrión');
    const o = newPc();
    await o.pc.setRemoteDescription({ type: 'offer', sdp: buildSdp(offer, 'offer') });
    await o.pc.setLocalDescription(await o.pc.createAnswer());
    await gathered(o.pc);
    const enc = encode('a', offer.slot, o.pc.localDescription.sdp);
    if (!enc.cands) { o.pc.close(); throw new Error(NO_NET); }
    o.code = enc.code;
    return o;
  }

  // Pull "o=..." or "a=..." out of a scanned URL or pasted text
  function extract(text) {
    const m = String(text || '').trim().match(/(?:^|[#&?])([oa])=([A-Za-z0-9_-]{40,})/);
    if (m) return decode(m[2]);
    const raw = String(text || '').trim();
    if (/^[A-Za-z0-9_-]{40,}$/.test(raw)) return decode(raw);
    throw new Error('No es un código de esta app');
  }

  // ---------- camera + QR scanning ----------
  // Holding the camera open while creating the offer/answer also makes browsers
  // reveal real local IPs instead of mDNS ".local" names, which connect more reliably.
  let camStream = null;
  async function openCamera() {
    if (camStream && camStream.active) return camStream;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Este navegador no permite usar la cámara aquí');
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    return camStream;
  }
  function closeCamera() {
    if (camStream) camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
  }

  // jsQR is only needed where the browser has no native BarcodeDetector (iOS Safari).
  let jsqrLoading = null;
  function loadJsQR() {
    if (root.jsQR) return Promise.resolve();
    if (!jsqrLoading) jsqrLoading = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'jsqr.js'; s.onload = res; s.onerror = () => { jsqrLoading = null; rej(new Error('No se pudo cargar el lector QR')); };
      document.head.appendChild(s);
    });
    return jsqrLoading;
  }

  // Scans frames from <video> until onText returns true or stop() is called.
  function scan(video, onText) {
    let stopped = false, detector = null, busy = false;
    try { if ('BarcodeDetector' in window) detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { detector = null; }
    if (detector && BarcodeDetector.getSupportedFormats)
      BarcodeDetector.getSupportedFormats().then((f) => { if (f.indexOf('qr_code') < 0) detector = null; }, () => { detector = null; });
    loadJsQR().catch(() => {});
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
    async function tick() {
      if (stopped) return;
      if (!busy && video.readyState >= 2 && video.videoWidth) {
        busy = true;
        try {
          let text = null;
          if (detector) {
            const r = await detector.detect(video);
            if (r && r.length) text = r[0].rawValue;
          } else if (root.jsQR) {
            const s = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
            canvas.width = Math.round(video.videoWidth * s); canvas.height = Math.round(video.videoHeight * s);
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const r = root.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
            if (r) text = r.data;
          }
          if (text && !stopped && onText(text)) stopped = true;
        } catch (e) {
          if (detector && root.jsQR) detector = null; // fall back to jsQR
        }
        busy = false;
      }
      if (!stopped) setTimeout(tick, 120);
    }
    tick();
    return function stop() { stopped = true; };
  }

  root.Net = {
    encode: encode, decode: decode, buildSdp: buildSdp, extract: extract,
    createInvite: createInvite, acceptInvite: acceptInvite,
    openCamera: openCamera, closeCamera: closeCamera, scan: scan,
  };
})(typeof self !== 'undefined' ? self : this);
