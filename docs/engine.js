// Mesa engine: the authoritative card-table rules. Runs only on the host's phone.
// Ported from mesa.js. Players are keyed by a public seat id; the secret that proves
// who you are never leaves the host (see join()).
(function (root) {
  'use strict';
  const FR_SUITS = ['S', 'H', 'D', 'C'];
  const FR_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const SP_SUITS = ['oros', 'copas', 'espadas', 'bastos'];

  function randInt(n) {
    const a = new Uint32Array(1), lim = Math.floor(0x100000000 / n) * n;
    do crypto.getRandomValues(a); while (a[0] >= lim);
    return a[0] % n;
  }
  function rid() { return Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(16).padStart(2, '0')).join(''); }
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  function buildDeck(cfg) {
    const cards = [];
    for (let c = 0; c < cfg.copies; c++) {
      if (cfg.type === 'spanish') {
        const ranks = cfg.spanish48 ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [1, 2, 3, 4, 5, 6, 7, 10, 11, 12];
        for (const s of SP_SUITS) for (const r of ranks) cards.push({ id: c + s + r, s: s, r: String(r) });
      } else {
        for (const s of FR_SUITS) for (const r of FR_RANKS) cards.push({ id: c + s + r, s: s, r: r });
      }
      if (cfg.jokers) for (let j = 0; j < 2; j++) cards.push({ id: c + 'X' + j, s: 'X', r: 'JOKER' });
    }
    return shuffle(cards);
  }

  function deckLabel(cfg) {
    const base = cfg.type === 'spanish' ? 'española ' + (cfg.spanish48 ? 48 : 40) : 'francesa 52';
    return (cfg.copies > 1 ? cfg.copies + ' barajas' : 'baraja') + ' ' + base + (cfg.jokers ? ' + jokers' : '');
  }

  function cardName(c) {
    if (c.s === 'X') return 'Joker';
    const sym = { S: '♠', H: '♥', D: '♦', C: '♣', oros: ' de oros', copas: ' de copas', espadas: ' de espadas', bastos: ' de bastos' };
    return c.r + sym[c.s];
  }

  function fresh() {
    const config = { type: 'french', spanish48: false, jokers: false, copies: 1 };
    return { v: 1, config: config, deck: buildDeck(config), discard: [], table: [], players: {}, order: [], turn: 0, log: [], secrets: {} };
  }

  function log(state, msg) {
    state.log.push(msg);
    if (state.log.length > 50) state.log.splice(0, state.log.length - 50);
  }

  // pid: a secret the player's phone keeps in localStorage. Rejoining with the same
  // pid gives you back your seat and your hand.
  function join(state, pid, name) {
    name = String(name || '').trim().slice(0, 16) || 'Jugador';
    let seat = state.secrets[pid];
    if (seat && state.players[seat]) {
      state.players[seat].name = name;
      return seat;
    }
    seat = 'p' + rid();
    state.secrets[pid] = seat;
    state.players[seat] = { name: name, hand: [], score: 0, revealed: false };
    state.order.push(seat);
    log(state, name + ' se sentó a la mesa');
    return seat;
  }

  function handle(state, seat, msg) {
    const p = state.players[seat];
    if (!p) throw new Error('Ya no estás en la mesa');
    const me = p.name, type = msg && msg.type;

    function takeFromHand(ids) {
      if (!Array.isArray(ids) || !ids.length) throw new Error('Selecciona cartas primero');
      const cards = ids.map((id) => {
        const c = p.hand.find((h) => h.id === id);
        if (!c) throw new Error('Esa carta ya no está en tu mano');
        return c;
      });
      p.hand = p.hand.filter((h) => ids.indexOf(h.id) < 0);
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
    function names(cards) { return cards.map(cardName).join(', '); }

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
        log(state, me + ' empezó partida nueva: ' + deckLabel(cfg));
        break;
      }
      case 'deal': {
        const n = Math.min(Math.max(parseInt(msg.n) || 0, 1), 40);
        let dealt = 0;
        for (let i = 0; i < n; i++)
          for (const id of state.order) {
            const c = state.deck.pop();
            if (c) { state.players[id].hand.push(c); dealt++; }
          }
        log(state, me + ' repartió ' + n + ' carta' + (n > 1 ? 's' : '') + ' a cada uno' + (dealt < n * state.order.length ? ' (se acabó el mazo)' : ''));
        break;
      }
      case 'draw':
        p.hand.push(drawFromDeck());
        log(state, me + ' robó del mazo');
        break;
      case 'drawDiscard': {
        const c = state.discard.pop();
        if (!c) throw new Error('El descarte está vacío');
        p.hand.push(c);
        log(state, me + ' tomó ' + cardName(c) + ' del descarte');
        break;
      }
      case 'discard': {
        const cards = takeFromHand(msg.cards);
        state.discard.push.apply(state.discard, cards);
        log(state, me + ' descartó ' + names(cards));
        break;
      }
      case 'play': {
        if (msg.group) {
          const g = findGroup(msg.group);
          const cards = takeFromHand(msg.cards);
          g.cards.push.apply(g.cards, cards);
          log(state, me + ' agregó ' + names(cards) + ' a la mesa');
        } else {
          const cards = takeFromHand(msg.cards);
          state.table.push({ id: rid(), owner: me, cards: cards });
          log(state, me + ' bajó ' + names(cards));
        }
        break;
      }
      case 'take': {
        const g = findGroup(msg.group);
        if (msg.card) {
          const i = g.cards.findIndex((c) => c.id === msg.card);
          if (i < 0) throw new Error('Esa carta ya no está en la mesa');
          const c = g.cards.splice(i, 1)[0];
          p.hand.push(c);
          log(state, me + ' tomó ' + cardName(c) + ' de la mesa');
        } else {
          p.hand.push.apply(p.hand, g.cards);
          log(state, me + ' tomó ' + g.cards.length + ' carta' + (g.cards.length > 1 ? 's' : '') + ' de la mesa');
          g.cards = [];
        }
        state.table = state.table.filter((t) => t.cards.length);
        break;
      }
      case 'give': {
        const to = state.players[msg.to];
        if (!to) throw new Error('Ese jugador ya no está');
        const cards = takeFromHand(msg.cards);
        to.hand.push.apply(to.hand, cards);
        log(state, me + ' le pasó ' + cards.length + ' carta' + (cards.length > 1 ? 's' : '') + ' a ' + to.name);
        break;
      }
      case 'reorder': {
        const ids = msg.cards;
        if (!Array.isArray(ids) || ids.length !== p.hand.length) throw new Error('Tu mano cambió, intenta de nuevo');
        const byId = new Map(p.hand.map((c) => [c.id, c]));
        const next = ids.map((id) => byId.get(id));
        if (next.some((c) => !c) || new Set(ids).size !== ids.length) throw new Error('Tu mano cambió, intenta de nuevo');
        p.hand = next;
        return false; // cosmetic: no log
      }
      case 'reveal':
        p.revealed = !p.revealed;
        log(state, me + ' ' + (p.revealed ? 'mostró' : 'ocultó') + ' su mano');
        break;
      case 'flip': {
        const c = drawFromDeck();
        state.discard.push(c);
        log(state, me + ' dio vuelta ' + cardName(c) + ' al descarte');
        break;
      }
      case 'toTable': {
        const c = drawFromDeck();
        state.table.push({ id: rid(), owner: 'Mazo', cards: [c] });
        log(state, me + ' puso ' + cardName(c) + ' en la mesa');
        break;
      }
      case 'recycle': {
        const top = state.discard.pop();
        state.deck = shuffle(state.deck.concat(state.discard));
        state.discard = top ? [top] : [];
        log(state, me + ' rebarajó el descarte en el mazo');
        break;
      }
      case 'shuffleDeck':
        shuffle(state.deck);
        log(state, me + ' barajó el mazo');
        break;
      case 'score': {
        const t = state.players[msg.target];
        if (!t) throw new Error('Ese jugador ya no está');
        const d = Math.max(-100, Math.min(100, parseInt(msg.d) || 0));
        t.score += d;
        log(state, me + ': puntaje de ' + t.name + ' ' + (d > 0 ? '+' : '') + d + ' → ' + t.score);
        break;
      }
      case 'endTurn': {
        if (!state.order.length) break;
        state.turn = (state.turn + 1) % state.order.length;
        log(state, 'Turno de ' + state.players[state.order[state.turn]].name);
        break;
      }
      case 'setTurn': {
        const i = state.order.indexOf(msg.target);
        if (i < 0) throw new Error('Ese jugador ya no está');
        state.turn = i;
        log(state, 'Turno de ' + state.players[msg.target].name);
        break;
      }
      case 'kick': {
        const id = msg.target;
        const t = state.players[id];
        if (!t) throw new Error('Ese jugador ya no está');
        state.deck.unshift.apply(state.deck, t.hand);
        delete state.players[id];
        const cur = state.order[state.turn];
        state.order = state.order.filter((o) => o !== id);
        for (const k in state.secrets) if (state.secrets[k] === id) delete state.secrets[k];
        const ni = state.order.indexOf(cur);
        state.turn = ni >= 0 ? ni : state.order.length ? state.turn % state.order.length : 0;
        log(state, t.name + ' salió de la mesa (sus cartas volvieron al fondo del mazo)');
        break;
      }
      default:
        throw new Error('Acción desconocida');
    }
    return true;
  }

  // What one seat is allowed to see: everyone's counts, only your own hand (or revealed ones).
  function view(state, seat, online, hostSeat) {
    return {
      me: state.players[seat] ? seat : null,
      host: hostSeat,
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
          id: id,
          name: p.name,
          count: p.hand.length,
          score: p.score,
          revealed: p.revealed,
          online: !!online[id],
          hand: id === seat || p.revealed ? p.hand : null,
        };
      }),
    };
  }

  root.MesaEngine = { fresh: fresh, join: join, handle: handle, view: view, cardName: cardName };
})(typeof self !== 'undefined' ? self : this);
