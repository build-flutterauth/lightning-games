/*
 * Battleship — screens, the board, and the connection to the game server.
 * The server (server/src/index.js) runs the rules from battleship-engine.js and is the
 * only place that knows every fleet; this page shows what it's told and sends moves.
 */
(function () {
  'use strict';

  const E = window.BattleshipEngine;
  const { store } = window.Lightning;

  // Local pages talk to `wrangler dev`; the published site talks to the deployed Worker.
  const LOCAL = location.protocol === 'file:' || ['localhost', '127.0.0.1'].includes(location.hostname);
  const SERVER = LOCAL ? 'ws://127.0.0.1:8787' : 'wss://lightning-games.lightning-games-server.workers.dev';

  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const ANNOUNCE_MS = 12000;

  const coord = (x, y) => `${LETTERS[x]}${y + 1}`;
  // Twenty well-separated hues, one per seat.
  const colorOf = (index) => `hsl(${Math.round((index * 137.508 + 200) % 360)} 80% 62%)`;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const $ = (id) => document.getElementById(id);
  const ui = {
    roomLabel: $('room-label'),
    roomCode: $('room-code'),
    sound: $('sound'),
    connection: $('connection'),
    home: $('home'),
    homeForm: $('home-form'),
    homeName: $('home-name'),
    homeError: $('home-error'),
    lobby: $('lobby'),
    lobbyCode: $('lobby-code'),
    shareUrl: $('share-url'),
    share: $('share'),
    joinForm: $('join-form'),
    joinName: $('join-name'),
    lobbyError: $('lobby-error'),
    lobbyList: $('lobby-list'),
    fleetSummary: $('fleet-summary'),
    fleetList: $('fleet-list'),
    lobbySize: $('lobby-size'),
    leave: $('leave'),
    start: $('start'),
    lobbyWait: $('lobby-wait'),
    play: $('play'),
    sea: $('sea'),
    seaWrap: $('sea-wrap'),
    zoomBar: $('zoom-bar'),
    zoomIn: $('zoom-in'),
    zoomOut: $('zoom-out'),
    zoomFit: $('zoom-fit'),
    seaSetup: $('sea-setup'),
    status: $('status'),
    dock: $('dock'),
    dockShips: $('dock-ships'),
    randomize: $('randomize'),
    clear: $('clear'),
    done: $('done'),
    change: $('change'),
    votes: $('votes'),
    roster: $('roster'),
    log: $('log'),
    announce: $('announce'),
    announceKicker: $('announce-kicker'),
    announceTitle: $('announce-title'),
    announceList: $('announce-list'),
    announceOut: $('announce-out'),
    announceClose: $('announce-close'),
    gameOver: $('game-over'),
    winner: $('winner'),
    summary: $('summary'),
    again: $('again'),
    newRoom: $('new-room'),
    viewBoard: $('view-board'),
    againHint: $('again-hint'),
    toasts: $('toasts'),
  };

  const app = {
    code: null,
    ws: null,
    seat: null,
    state: null,
    offset: 0, // server clock minus ours
    joining: null, // name to join with once connected
    retries: 0,
    retryTimer: 0,
    pingTimer: 0, // waiting for the server to answer a connection check
    seaSize: 0,
    placing: { ships: {}, draft: null, selected: 'carrier', dir: 'h', hover: null },
    zoom: 1, // phones only, on seas of 16 or more
    log: [],
    latestShot: null,
    aim: null, // on touch screens: the square you've tapped once
    pointer: 'mouse',
    viewingBoard: false,
    announceTimer: 0,
    names: {}, // id → name, kept after players leave
    lobbySeen: new Set(), // players already shown in the waiting room
  };

  /* ---------- Connection ---------- */

  // Your seat is remembered by this browser, not just this tab: phones often throw away a
  // backgrounded tab, or reopen the game link in a new one, and you should land back in your
  // seat either way. (To play two players on one computer, use a private window for one.)
  const seatKey = () => `battleship.seat.${app.code}`;
  const seats = {
    get() {
      const saved = store.get(seatKey(), null);
      if (saved) return saved;
      // Seats saved by the earlier version of this page lived in the tab's session storage.
      try {
        return JSON.parse(sessionStorage.getItem(`lightning:${seatKey()}`));
      } catch {
        return null;
      }
    },
    set(seat) {
      store.set(seatKey(), seat);
    },
  };

  function openRoom(code) {
    app.code = code;
    app.seat = seats.get();
    ui.roomCode.textContent = code;
    ui.roomLabel.hidden = false;
    show(ui.lobby);
    ui.lobbyCode.textContent = code;
    ui.shareUrl.value = shareLink();
    connect();
  }

  function connect() {
    clearTimeout(app.retryTimer);
    const ws = new WebSocket(`${SERVER}/battleship/rooms/${app.code}`);
    app.ws = ws;
    ws.onopen = () => {
      app.retries = 0;
      ui.connection.hidden = true;
      if (app.seat) send({ type: 'hello', ...app.seat });
      else if (app.joining) send({ type: 'join', name: app.joining });
      app.joining = null;
    };
    ws.onmessage = (e) => {
      if (e.data === 'pong') {
        clearTimeout(app.pingTimer);
        return;
      }
      receive(JSON.parse(e.data));
    };
    ws.onclose = () => {
      if (app.ws !== ws) return;
      ui.connection.hidden = false;
      ui.connection.textContent = app.retries > 2 ? "Can't reach the game server. Still trying…" : 'Reconnecting…';
      app.retryTimer = setTimeout(connect, Math.min(8000, 500 * 2 ** app.retries++));
    };
  }

  // Coming back to the page (switching apps or tabs on a phone): the connection may have died
  // while the page was asleep without the browser noticing, so check it now rather than later.
  function checkConnection() {
    if (!app.code || document.visibilityState === 'hidden') return;
    const ws = app.ws;
    if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return reconnectNow();
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send('ping');
    clearTimeout(app.pingTimer);
    app.pingTimer = setTimeout(reconnectNow, 4000); // no pong: that socket is dead
  }

  function reconnectNow() {
    const old = app.ws;
    app.ws = null; // so the old socket's close doesn't schedule a second reconnect
    try { old?.close(); } catch { /* already gone */ }
    app.retries = 0;
    connect();
  }

  function send(msg) {
    if (app.ws && app.ws.readyState === WebSocket.OPEN) app.ws.send(JSON.stringify(msg));
  }

  function receive(msg) {
    if (msg.type === 'seat') {
      // A null seat means the server doesn't know the one we offered (e.g. removed by the host).
      app.seat = msg.playerId ? { playerId: msg.playerId, token: msg.token } : null;
      seats.set(app.seat);
    } else if (msg.type === 'error') {
      if (app.state?.phase === 'lobby') ui.lobbyError.textContent = msg.message;
      else toast(msg.message);
    } else if (msg.type === 'state') {
      const before = app.state;
      app.state = msg.state;
      app.offset = msg.state.now - Date.now();
      msg.state.players.forEach((p) => { app.names[p.id] = p.name; });
      if (msg.state.phase === 'placing' && before?.phase !== 'placing') resetPlacement();
      if (msg.state.turnNumber !== before?.turnNumber) app.aim = null;
      msg.events.forEach((event, i) => handleEvent(event, msg.events, i));
      noticeTurn(before, msg.state);
      render();
    }
  }

  /* ---------- Screens ---------- */

  function show(screen) {
    [ui.home, ui.lobby, ui.play].forEach((s) => { s.hidden = s !== screen; });
  }

  function render() {
    const s = app.state;
    if (!s) return;
    if (s.phase === 'lobby') {
      show(ui.lobby);
      renderLobby();
      ui.gameOver.hidden = true;
      app.viewingBoard = false;
      return;
    }
    show(ui.play);
    renderBoard();
    renderSide();
    ui.gameOver.hidden = s.phase !== 'over' || app.viewingBoard || !ui.announce.hidden;
    if (s.phase === 'over') renderResult();
  }

  const me = () => app.state.players.find((p) => p.id === app.state.you) || null;
  // The ships every player places this game, as the host set them.
  const fleet = () => E.fleetFromCounts(app.state?.fleet || E.DEFAULT_COUNTS);
  const player = (id) => app.state.players.find((p) => p.id === id);
  const nameOf = (id) => app.names[id] || 'Someone';
  const shareLink = () => `${location.origin}${location.pathname}?room=${app.code}`;

  function renderLobby() {
    const s = app.state;
    const host = player(s.host);
    const online = s.players.filter((p) => p.connected).length;
    const joined = !!s.you;

    ui.joinForm.hidden = joined;
    if (!joined && !ui.joinName.value) ui.joinName.value = store.get('battleship.name', '');

    ui.lobbyList.replaceChildren(
      ...s.players.map((p) => {
        const li = document.createElement('li');
        li.style.setProperty('--pc', colorOf(p.color));
        li.classList.toggle('offline', !p.connected);
        li.classList.toggle('new', !app.lobbySeen.has(p.id));
        app.lobbySeen.add(p.id);
        li.innerHTML = '<span class="name"></span>';
        li.firstChild.textContent = p.name;
        if (p.id === s.host) li.insertAdjacentHTML('beforeend', '<span class="tag host">Host</span>');
        if (p.id === s.you) li.insertAdjacentHTML('beforeend', '<span class="tag you">You</span>');
        if (!p.connected) li.insertAdjacentHTML('beforeend', '<span class="tag">Offline</span>');
        if (s.you === s.host && p.id !== s.you) {
          const remove = document.createElement('button');
          remove.className = 'remove';
          remove.type = 'button';
          remove.textContent = '×';
          remove.setAttribute('aria-label', `Remove ${p.name}`);
          remove.addEventListener('click', () => send({ type: 'remove', playerId: p.id }));
          li.append(remove);
        }
        return li;
      })
    );
    if (!s.players.length) ui.lobbyList.innerHTML = '<li class="offline"><span class="name">Nobody here yet</span></li>';

    ui.lobbySize.textContent = `${plural(s.players.length, 'player')} → ${s.size}×${s.size} sea`;
    renderSeaSetup();
    const fits = renderFleetSetup();
    ui.start.hidden = s.you !== s.host;
    ui.start.disabled = online < E.MIN_PLAYERS || !fits;
    ui.leave.hidden = !joined;
    ui.lobbyWait.textContent = !joined
      ? 'Enter your name to join.'
      : s.you === s.host
        ? online < E.MIN_PLAYERS ? 'Waiting for at least one more player.' : 'Start when everyone is in.'
        : `Waiting for ${host ? host.name : 'the host'} to start…`;
  }

  // The host picks the sea size (10-26), or leaves it to grow with the players.
  function renderSeaSetup() {
    const s = app.state;
    const label = document.createElement('output');
    label.textContent = `${s.size}\u00d7${s.size}`;
    const note = document.createElement('span');
    note.className = 'hint';
    note.textContent = s.seaAuto ? 'grows with the players' : 'set by the host';
    if (s.you !== s.host) {
      ui.seaSetup.replaceChildren(label, note);
      return;
    }
    const step = (text, aria, disabled, size) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.disabled = disabled;
      button.setAttribute('aria-label', aria);
      button.addEventListener('click', () => send({ type: 'sea', size }));
      return button;
    };
    const auto = document.createElement('button');
    auto.type = 'button';
    auto.className = 'auto';
    auto.textContent = 'Auto';
    auto.setAttribute('aria-pressed', String(!!s.seaAuto));
    auto.title = 'Grow the sea with the number of players';
    auto.addEventListener('click', () => send({ type: 'sea', size: null }));
    ui.seaSetup.replaceChildren(
      Object.assign(document.createElement('span'), { className: 'stepper' }),
      auto,
      note
    );
    ui.seaSetup.firstChild.append(
      step('\u2212', 'Smaller sea', s.size <= E.MIN_SIZE, s.size - 1),
      label,
      step('+', 'Bigger sea', s.size >= E.MAX_SIZE, s.size + 1)
    );
  }

  // The host sets how many of each ship type everyone gets; others see the choice live.
  function renderFleetSetup() {
    const s = app.state;
    const host = s.you === s.host;
    const counts = s.fleet || E.DEFAULT_COUNTS;
    const ships = fleet();
    const fits = E.fleetFits(ships, s.size);
    ui.fleetSummary.textContent = fits
      ? `${plural(ships.length, 'ship')}, ${E.fleetSquares(ships)} squares`
      : `${E.fleetSquares(ships)} squares is too many for a ${s.size}×${s.size} sea`;
    ui.fleetSummary.classList.toggle('warn', !fits);

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    ui.fleetList.replaceChildren(
      ...E.SHIP_TYPES.map(({ type, name, size }) => {
        const n = counts[type] || 0;
        const li = document.createElement('li');
        li.classList.toggle('none', n === 0);
        li.innerHTML =
          `<span class="name">${name}</span>` +
          `<span class="ship-size" aria-hidden="true">${'<i></i>'.repeat(size)}</span>` +
          '<span class="stepper"></span>';
        const stepper = li.querySelector('.stepper');
        const count = (text) => Object.assign(document.createElement('output'), { textContent: text });
        if (host) {
          const set = (value) => send({ type: 'fleet', counts: { ...counts, [type]: value } });
          const step = (label, aria, disabled, value) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = label;
            button.disabled = disabled;
            button.setAttribute('aria-label', aria);
            button.addEventListener('click', () => set(value));
            return button;
          };
          stepper.append(
            step('−', `One fewer ${name}`, n === 0 || total === 1, n - 1),
            count(n),
            step('+', `One more ${name}`, n === E.MAX_PER_TYPE, n + 1)
          );
        } else {
          stepper.append(count(`×${n}`));
        }
        return li;
      })
    );
    return fits;
  }

  /* ---------- The board ---------- */

  function buildSea(size) {
    app.seaSize = size;
    ui.sea.style.setProperty('--n', size);
    setZoom(1);
    const parts = ['<div class="water"></div>', '<span class="label corner" style="grid-area:1/1"></span>'];
    for (let x = 0; x < size; x++) parts.push(`<span class="label col" style="grid-area:1/${x + 2}">${LETTERS[x]}</span>`);
    for (let y = 0; y < size; y++) parts.push(`<span class="label row" style="grid-area:${y + 2}/1">${y + 1}</span>`);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        parts.push(`<button class="cell" type="button" data-x="${x}" data-y="${y}" style="grid-area:${y + 2}/${x + 2}" aria-label="${coord(x, y)}"></button>`);
      }
    }
    ui.sea.innerHTML = parts.join('');
  }

  function shipEl(ship, className, color) {
    const el = document.createElement('div');
    el.className = `ship ${className}`;
    el.style.gridColumn = ship.dir === 'h' ? `${ship.x + 2} / span ${ship.size}` : `${ship.x + 2}`;
    el.style.gridRow = ship.dir === 'v' ? `${ship.y + 2} / span ${ship.size}` : `${ship.y + 2}`;
    el.style.setProperty('--pc', color);
    return el;
  }

  function renderBoard() {
    const s = app.state;
    if (app.seaSize !== s.size) buildSea(s.size);
    ui.sea.querySelectorAll('.ship, .mark, .edit').forEach((n) => n.remove());
    ui.zoomBar.hidden = !zoomable();
    if (ui.zoomBar.hidden && app.zoom !== 1) setZoom(1);

    const mine = me();
    const myColor = mine ? colorOf(mine.color) : 'var(--muted)';
    const placing = s.phase === 'placing' && mine && !mine.ready;
    const targeting = s.phase === 'battle' && s.turn === s.you;
    ui.sea.classList.toggle('placing', !!placing);
    ui.sea.classList.toggle('targeting', targeting);

    const layer = document.createDocumentFragment();
    if (s.phase === 'placing') {
      const ships = placing ? placedShips() : s.myShips || [];
      ships.forEach((ship) => layer.append(shipEl(ship, 'mine', myColor)));
      if (placing) {
        const draft = draftShip();
        if (draft) layer.append(...editorEls(draft, myColor));
        else {
          const preview = previewShip();
          if (preview) layer.append(shipEl(preview.ship, `preview${preview.ok ? '' : ' bad'}`, myColor));
        }
      }
    } else {
      s.wrecks.forEach((ship) => {
        const owner = player(ship.owner);
        layer.append(shipEl(ship, `wreck${ship.owner === s.you ? ' mine' : ''}`, colorOf(owner ? owner.color : 0)));
      });
      (s.myShips || []).filter((ship) => !ship.sunk).forEach((ship) => layer.append(shipEl(ship, 'mine', myColor)));
      s.shots.forEach((shot) => {
        const mark = document.createElement('div');
        const latest = app.latestShot && app.latestShot.x === shot.x && app.latestShot.y === shot.y;
        mark.className = `mark ${shot.hit ? 'hit' : 'miss'}${latest ? ' latest' : ''}`;
        mark.style.gridArea = `${shot.y + 2}/${shot.x + 2}`;
        layer.append(mark);
      });
      if (app.aim && targeting) {
        const aim = document.createElement('div');
        aim.className = 'mark aim';
        aim.style.gridArea = `${app.aim.y + 2}/${app.aim.x + 2}`;
        layer.append(aim);
      }
    }
    ui.sea.append(layer);

    const view = { size: s.size, shots: s.shots, ships: s.wrecks };
    ui.sea.querySelectorAll('.cell').forEach((cell) => {
      const open = targeting && E.isTargetable(view, +cell.dataset.x, +cell.dataset.y);
      cell.classList.toggle('open', open);
      cell.tabIndex = open || placing ? 0 : -1;
    });
  }

  function onCellClick(x, y) {
    const s = app.state;
    if (!s) return;
    const mine = me();
    if (s.phase === 'placing' && mine && !mine.ready) return placeAt(x, y);
    if (s.phase === 'battle' && s.turn === s.you) {
      if (!E.isTargetable({ size: s.size, shots: s.shots, ships: s.wrecks }, x, y)) return;
      // Squares get small on phones, so a tap only aims; tapping the same square again fires.
      const aimed = app.aim && app.aim.x === x && app.aim.y === y;
      if (app.pointer === 'touch' && !aimed) {
        app.aim = { x, y };
        renderBoard();
        renderStatus();
        return;
      }
      fire(x, y);
    }
  }

  function fire(x, y) {
    app.aim = null;
    send({ type: 'shoot', x, y });
  }

  /* ---------- Placing ships ---------- */

  /*
   * A tap drops the outline of the next ship. While it's an outline, arrows swing it a
   * quarter turn about either end, the check keeps it, and the trash can removes it.
   * Tapping a kept ship turns it back into an outline to change it.
   */

  function resetPlacement() {
    const own = app.state.myShips;
    app.placing = { ships: {}, draft: null, selected: fleet()[0]?.id || null, dir: 'h', hover: null };
    if (own) own.forEach((ship) => { app.placing.ships[ship.id] = { x: ship.x, y: ship.y, dir: ship.dir }; });
    if (own) app.placing.selected = null;
  }

  const spec = (id) => fleet().find((s) => s.id === id);
  const sized = (id, pos) => ({ id, name: spec(id).name, size: spec(id).size, x: pos.x, y: pos.y, dir: pos.dir });
  const nextUnplaced = () => fleet().find((s) => !app.placing.ships[s.id] && app.placing.draft?.id !== s.id)?.id || null;

  // Kept ships (not the outline being edited).
  function placedShips() {
    return fleet().filter((s) => app.placing.ships[s.id]).map((s) => sized(s.id, app.placing.ships[s.id]));
  }

  const draftShip = () => (app.placing.draft ? sized(app.placing.draft.id, app.placing.draft) : null);

  // On the sea and clear of your other ships (other players' ships are invisible, so they can't count).
  function fitsOwn(ship) {
    const size = app.state.size;
    const cells = E.shipCells(ship);
    if (cells.some(([x, y]) => x < 0 || y < 0 || x >= size || y >= size)) return false;
    const others = placedShips().filter((s) => s.id !== ship.id);
    return !cells.some(([x, y]) => others.some((o) => E.covers(o, x, y)));
  }

  // The bow goes on the tapped square; a ship that would hang off the edge is pulled back on.
  function outlineAt(id, x, y, dir) {
    const size = app.state.size;
    const len = spec(id).size;
    return { id, dir, x: dir === 'h' ? Math.min(x, size - len) : x, y: dir === 'v' ? Math.min(y, size - len) : y };
  }

  function previewShip() {
    const { hover, selected, dir } = app.placing;
    if (!hover || !selected) return null;
    const ship = sized(selected, outlineAt(selected, hover.x, hover.y, dir));
    return { ship, ok: fitsOwn(ship) };
  }

  // Quarter turns about either end, keeping only the ones that stay on the sea and clear of
  // your other ships. Each arrow sits just past the end it pivots on, pointing the new way.
  function turns(ship) {
    const { x, y, size: n } = ship;
    const options = [];
    if (ship.dir === 'h') {
      for (const end of [x, x + n - 1]) {
        options.push({ arrow: 'up', at: [end, y - 1], to: { x: end, y: y - n + 1, dir: 'v' } });
        options.push({ arrow: 'down', at: [end, y + 1], to: { x: end, y, dir: 'v' } });
      }
    } else {
      for (const end of [y, y + n - 1]) {
        options.push({ arrow: 'left', at: [x - 1, end], to: { x: x - n + 1, y: end, dir: 'h' } });
        options.push({ arrow: 'right', at: [x + 1, end], to: { x, y: end, dir: 'h' } });
      }
    }
    return options.filter((t) => fitsOwn(sized(ship.id, t.to)));
  }

  // The check and trash can go below the outline, past any down arrows; near the bottom
  // of the sea, they go above it instead.
  function controlSquares(ship, options) {
    const size = app.state.size;
    const { x, y, size: n } = ship;
    if (ship.dir === 'h') {
      const below = y + (options.some((t) => t.arrow === 'down') ? 2 : 1);
      const above = y - (options.some((t) => t.arrow === 'up') ? 2 : 1);
      const row = below < size ? below : above >= 0 ? above : y + 1 < size ? y + 1 : y - 1;
      return { keep: [x, row], trash: [x + n - 1, row] };
    }
    const row = y + n < size ? y + n : y - 1;
    return { keep: [x, row], trash: [x + 1 < size ? x + 1 : x - 1, row] };
  }

  const ICONS = {
    arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1 1.5 11.5H8V23h8V11.5h6.5z"/></svg>',
    keep: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5"/></svg>',
  };

  function editButton(kind, [x, y], label, icon, data = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `edit ${kind}`;
    button.style.gridArea = `${y + 2}/${x + 2}`;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.innerHTML = icon;
    Object.assign(button.dataset, { edit: kind.split(' ')[0], ...data });
    return button;
  }

  function editorEls(ship, color) {
    const ok = fitsOwn(ship);
    const options = turns(ship);
    const { keep, trash } = controlSquares(ship, options);
    const keepButton = editButton('keep', keep, `Keep the ${ship.name} here`, ICONS.keep);
    keepButton.disabled = !ok;
    return [
      shipEl(ship, `draft${ok ? '' : ' bad'}`, color),
      ...options.map((t, i) => editButton(`turn ${t.arrow}`, t.at, `Turn the ${ship.name} ${t.arrow}`, ICONS.arrow, { turn: i })),
      keepButton,
      editButton('trash', trash, `Remove the ${ship.name}`, ICONS.trash),
    ];
  }

  function placeAt(x, y) {
    const placing = app.placing;
    const draft = draftShip();
    if (draft && E.covers(draft, x, y)) return; // tapping the outline itself changes nothing
    const kept = placedShips().find((s) => E.covers(s, x, y));
    if (kept) editShip(kept.id);
    else if (placing.draft) placing.draft = outlineAt(placing.draft.id, x, y, placing.draft.dir); // move it
    else if (placing.selected) placing.draft = outlineAt(placing.selected, x, y, placing.dir);
    else return;
    placing.hover = null;
    renderPlacement();
  }

  // Before starting on another ship, keep the current outline if it fits; otherwise it goes back to the dock.
  function settleDraft() {
    const draft = draftShip();
    if (draft && fitsOwn(draft)) app.placing.ships[draft.id] = { x: draft.x, y: draft.y, dir: draft.dir };
    app.placing.draft = null;
  }

  function editShip(id) {
    settleDraft();
    const pos = app.placing.ships[id];
    delete app.placing.ships[id];
    app.placing.draft = { id, ...pos };
    app.placing.selected = id;
  }

  function onEdit(button) {
    const placing = app.placing;
    const draft = draftShip();
    if (!draft) return;
    const action = button.dataset.edit;
    if (action === 'turn') {
      placing.draft = { id: draft.id, ...turns(draft)[+button.dataset.turn].to };
    } else if (action === 'keep') {
      if (!fitsOwn(draft)) return;
      placing.ships[draft.id] = { x: draft.x, y: draft.y, dir: draft.dir };
      placing.dir = draft.dir;
      placing.draft = null;
      placing.selected = nextUnplaced();
    } else if (action === 'trash') {
      placing.draft = null;
      placing.selected = draft.id;
    }
    renderPlacement();
  }

  // R or right-click: turn the outline in place (or, with no outline, the next one to drop).
  function rotate() {
    const placing = app.placing;
    if (placing.draft) {
      const { id, x, y, dir } = placing.draft;
      placing.draft = outlineAt(id, x, y, dir === 'h' ? 'v' : 'h');
    } else {
      placing.dir = placing.dir === 'h' ? 'v' : 'h';
    }
    renderBoard();
  }

  function randomize() {
    app.placing.ships = {};
    app.placing.draft = null;
    E.randomFleet(app.state.size, Math.random, fleet()).forEach((s) => { app.placing.ships[s.id] = { x: s.x, y: s.y, dir: s.dir }; });
    app.placing.selected = null;
    renderPlacement();
  }

  function clearShips() {
    app.placing.ships = {};
    app.placing.draft = null;
    app.placing.selected = fleet()[0]?.id || null;
    renderPlacement();
  }

  function renderPlacement() {
    renderBoard();
    renderDock();
    renderStatus();
  }

  function renderDock() {
    const s = app.state;
    const mine = me();
    ui.dock.hidden = !(s.phase === 'placing' && mine);
    if (ui.dock.hidden) return;
    const ready = mine.ready;
    const color = colorOf(mine.color);
    ui.dockShips.hidden = ready;
    ui.randomize.parentElement.hidden = ready;
    ui.done.hidden = ready;
    ui.change.hidden = !ready;
    if (ready) return;

    const placing = app.placing;
    ui.dockShips.replaceChildren(
      ...fleet().map((ship) => {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `ship-pick${placing.ships[ship.id] ? ' placed' : ''}${placing.draft?.id === ship.id ? ' editing' : ''}`;
        button.setAttribute('aria-pressed', String(placing.selected === ship.id));
        button.style.setProperty('--pc', color);
        button.innerHTML = `<span class="name">${ship.name}</span><span class="ship-size">${'<i></i>'.repeat(ship.size)}</span>`;
        button.addEventListener('click', () => {
          if (placing.ships[ship.id]) editShip(ship.id);
          else if (placing.draft?.id !== ship.id) {
            settleDraft();
            placing.selected = ship.id;
          }
          renderPlacement();
        });
        li.append(button);
        return li;
      })
    );
    ui.done.disabled = placedShips().length < fleet().length || !!placing.draft;
  }

  /* ---------- Zoom (phones, seas of 16 or more) ---------- */

  const narrow = window.matchMedia('(max-width: 860px)');
  const zoomable = () => narrow.matches && (app.state?.size || 0) >= 16;
  // The cell size the CSS picks at zoom 1 on a phone: the whole sea across the screen width.
  const fitCell = () => Math.min(40, Math.max(12, (window.innerWidth - 28) / ((app.state?.size || 10) + 0.8)));
  const maxZoom = () => Math.max(1, 44 / fitCell());

  // Zoom about a point (a pinch's midpoint, or the middle of the view), keeping it in place.
  function setZoom(zoom, anchor) {
    const wrap = ui.seaWrap;
    zoom = Math.min(maxZoom(), Math.max(1, zoom));
    const rect = wrap.getBoundingClientRect();
    const ax = anchor ? anchor.x - rect.left : wrap.clientWidth / 2;
    const ay = anchor ? anchor.y - rect.top : wrap.clientHeight / 2;
    const fx = (wrap.scrollLeft + ax) / (wrap.scrollWidth || 1);
    const fy = (wrap.scrollTop + ay) / (wrap.scrollHeight || 1);
    app.zoom = zoom;
    ui.sea.style.setProperty('--zoom', zoom);
    wrap.classList.toggle('zoomed', zoom > 1.01);
    wrap.scrollLeft = fx * wrap.scrollWidth - ax;
    wrap.scrollTop = fy * wrap.scrollHeight - ay;
    ui.zoomOut.disabled = zoom <= 1.01;
    ui.zoomFit.disabled = zoom <= 1.01;
    ui.zoomIn.disabled = zoom >= maxZoom() - 0.01;
  }

  /* ---------- Side panel ---------- */

  function renderSide() {
    renderStatus();
    renderDock();
    renderVotes();
    renderRoster();
    renderLog();
  }

  const coarse = window.matchMedia('(pointer: coarse)');
  const turnAge = () => Date.now() + app.offset - (app.state.turnStartedAt || 0);
  const clock = (ms) => {
    const sec = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  };

  function renderStatus() {
    const s = app.state;
    const mine = me();
    const box = ui.status;
    box.className = 'status';
    box.style.removeProperty('--pc');
    let title;
    let note;

    if (s.phase === 'placing') {
      const waiting = s.players.filter((p) => !p.ready);
      if (!mine) {
        title = 'Fleets are being placed';
        note = "This game started before you joined, so you're watching.";
      } else if (!mine.ready) {
        title = 'Place your fleet';
        note = app.placing.draft
          ? 'Turn it with the arrows, then tap the check to keep it or the trash can to remove it. Tap another square to move it.'
          : 'Tap a square to drop the outline of the highlighted ship. Tap a kept ship to change it. Nobody can see your ships.';
      } else {
        title = 'Fleet ready';
        note = `Waiting for ${waiting.map((p) => p.name).join(', ')}…`;
      }
      if (mine && s.you === s.host) {
        const gone = waiting.filter((p) => !p.connected);
        if (gone.length) note += ` ${gone.map((p) => p.name).join(', ')} went offline; you can remove them from the list below.`;
      }
    } else if (s.phase === 'battle') {
      const up = player(s.turn);
      box.style.setProperty('--pc', colorOf(up.color));
      if (s.turn === s.you) {
        box.classList.add('mine');
        title = 'Your turn!';
        note = app.aim
          ? `<button class="btn btn-primary btn-sm" type="button" data-fire>Fire at ${coord(app.aim.x, app.aim.y)}</button>`
          : coarse.matches
            ? 'Tap a square to aim, then tap it again to fire. Any ship there is hit, even your own.'
            : 'Pick a square to fire on. Any ship there is hit, even your own.';
      } else {
        title = `${up.name} is aiming`;
        note = mine && mine.out ? "You're out, but you can keep watching." : 'Waiting for their shot.';
      }
      note += ` <span class="clock" data-clock>${clock(turnAge())}</span>`;
    } else {
      const winner = player(s.winner);
      title = winner ? `${winner.name} wins!` : 'No fleets survived';
      note = '<button class="btn btn-sm" type="button" data-results>Show results</button>';
    }
    box.innerHTML = `<h2></h2><p>${note}</p>`;
    box.firstChild.textContent = title;
    box.querySelector('[data-fire]')?.addEventListener('click', () => fire(app.aim.x, app.aim.y));
    box.querySelector('[data-results]')?.addEventListener('click', () => {
      app.viewingBoard = false;
      render();
    });
  }

  let votesKey = '';
  function renderVotes() {
    const s = app.state;
    const mine = me();
    if (s.phase !== 'battle' || !s.votes) {
      ui.votes.hidden = true;
      votesKey = '';
      return;
    }
    const open = turnAge() >= E.VOTE_DELAY_MS;
    const canVote = mine && !mine.out && s.turn !== s.you;
    const { skip, banish, needed, mine: myVote } = s.votes;
    const key = [s.turnNumber, open, canVote, skip, banish, needed, myVote].join('|');
    if (key === votesKey) return;
    votesKey = key;

    const up = player(s.turn);
    ui.votes.hidden = !canVote && !skip && !banish && s.turn !== s.you;
    if (s.turn === s.you) {
      ui.votes.innerHTML =
        `<p>After ${E.VOTE_DELAY_MS / 1000} seconds, the others can vote to skip your turn or banish you. ` +
        `Skip ${skip}/${needed} · Banish ${banish}/${needed}</p>`;
      return;
    }
    const tally = `<p>Stuck waiting? ${open ? 'A majority decides.' : `Voting opens in ${Math.ceil((E.VOTE_DELAY_MS - turnAge()) / 1000)}s.`}</p>`;
    if (!canVote) {
      ui.votes.innerHTML = `${tally}<p>Skip ${skip}/${needed} · Banish ${banish}/${needed}</p>`;
      return;
    }
    ui.votes.innerHTML =
      tally +
      '<div class="vote-buttons">' +
      `<button class="btn btn-sm" type="button" data-vote="skip" aria-pressed="${myVote === 'skip'}" ${open ? '' : 'disabled'}>Skip turn ${skip}/${needed}</button>` +
      `<button class="btn btn-sm" type="button" data-vote="banish" aria-pressed="${myVote === 'banish'}" ${open ? '' : 'disabled'}>Banish ${banish}/${needed}</button>` +
      '</div>';
    ui.votes.querySelectorAll('[data-vote]').forEach((b) => {
      b.title = `${b.dataset.vote === 'skip' ? 'Skip' : 'Banish'} ${up.name}`;
      b.addEventListener('click', () => send({ type: 'vote', kind: b.dataset.vote }));
    });
  }

  function renderRoster() {
    const s = app.state;
    const total = fleet().length;
    ui.roster.replaceChildren(
      ...s.players.map((p) => {
        const li = document.createElement('li');
        li.style.setProperty('--pc', colorOf(p.color));
        li.classList.toggle('turn', p.id === s.turn);
        li.classList.toggle('out', p.out);
        const afloat = p.afloat ?? total;
        const tag = p.banished ? 'Banished' : p.out ? 'Out' : !p.connected ? 'Offline'
          : s.phase === 'placing' ? (p.ready ? 'Ready' : 'Placing') : '';
        // One pip per ship for small fleets; a count once there are too many to read as pips.
        const pips = total <= 8
          ? '<i></i>'.repeat(afloat) + '<i class="gone"></i>'.repeat(total - afloat)
          : `<span class="pip-count">${afloat}/${total}</span>`;
        li.innerHTML =
          '<span class="dot"></span><span class="name"></span>' +
          (tag ? `<span class="tag">${tag}</span>` : '<span></span>') +
          `<span class="pips" title="${plural(afloat, 'ship')} afloat">${pips}</span>`;
        li.querySelector('.name').textContent = p.id === s.you ? `${p.name} (you)` : p.name;
        if (s.phase === 'placing' && s.you === s.host && !p.connected && !p.ready) {
          const remove = document.createElement('button');
          remove.className = 'remove';
          remove.type = 'button';
          remove.textContent = '×';
          remove.setAttribute('aria-label', `Remove ${p.name}`);
          remove.addEventListener('click', () => send({ type: 'remove', playerId: p.id }));
          li.querySelector('.tag')?.after(remove);
        }
        return li;
      })
    );
  }

  function renderLog() {
    ui.log.replaceChildren(
      ...app.log.slice(0, 40).map((entry) => {
        const li = document.createElement('li');
        li.className = entry.big ? 'big' : '';
        li.textContent = entry.text;
        return li;
      })
    );
  }

  function renderResult() {
    const s = app.state;
    const winner = player(s.winner);
    ui.winner.textContent = winner ? `${winner.name} wins!` : 'No fleets survived';
    ui.winner.style.setProperty('--pc', winner ? colorOf(winner.color) : 'var(--text)');
    ui.summary.textContent = winner
      ? `Last fleet afloat after ${plural(s.shots.length, 'shot')}.`
      : 'Every fleet sank before anyone fired.';
    const host = player(s.host);
    ui.again.hidden = s.you !== s.host;
    ui.againHint.textContent = s.you === s.host
      ? 'Play again takes everyone here back to the waiting room.'
      : `Waiting for ${host ? host.name : 'the host'} to play again, or start your own game.`;
  }

  /* ---------- Events ---------- */

  function log(text, big = false) {
    app.log.unshift({ text, big });
  }

  function handleEvent(event, events) {
    switch (event.kind) {
      case 'started':
        app.log = [];
        log(`Game on: ${event.size}×${event.size} sea. Place your fleets.`);
        sound.ping();
        break;
      case 'collisions': {
        const out = events.find((e) => e.kind === 'out' && e.cause === 'collision');
        announceCollisions(event.sunk, out ? out.players : []);
        event.sunk.forEach((s) => log(`${nameOf(s.owner)}'s ${s.name} sank in a collision`, true));
        if (!event.sunk.length) log('No collisions. Every fleet survived the start.');
        break;
      }
      case 'shot': {
        app.latestShot = { x: event.x, y: event.y };
        const where = coord(event.x, event.y);
        log(`${nameOf(event.by)} fired at ${where}: ${event.hit ? 'HIT' : 'miss'}`);
        if (event.sunk) {
          const text = `${nameOf(event.by)} sank ${event.sunk.owner === event.by ? 'their own' : `${nameOf(event.sunk.owner)}'s`} ${event.sunk.name}!`;
          log(text, true);
          toast(text, true);
          sound.sunk();
        } else if (event.hit) sound.hit();
        else sound.miss();
        break;
      }
      case 'out':
        if (event.cause !== 'collision') {
          const text = `${event.players.map(nameOf).join(', ')} ${event.players.length === 1 ? 'is' : 'are'} out!`;
          log(text, true);
          toast(text, true);
        }
        break;
      case 'skipped':
        log(`${nameOf(event.player)}'s turn was skipped by vote`);
        toast(`${nameOf(event.player)}'s turn was skipped`);
        break;
      case 'banished':
        log(`${nameOf(event.player)} was banished by vote`, true);
        toast(`${nameOf(event.player)} was banished!`, true);
        break;
      case 'over':
        log(event.winner ? `${nameOf(event.winner)} wins!` : 'No fleets survived.', true);
        if (event.winner) sound.fanfare();
        break;
      case 'restarted':
        app.log = [];
        app.latestShot = null;
        toast('Back to the waiting room for another round');
        break;
      case 'removed':
        toast(`${event.name} was removed from the game`);
        break;
      default:
    }
  }

  function noticeTurn(before, after) {
    const mine = after.phase === 'battle' && after.turn === after.you;
    document.title = mine ? 'Your turn! · Battleship' : 'Battleship · Lightning Games';
    if (mine && (before?.turn !== after.you || before?.turnNumber !== after.turnNumber)) {
      sound.ping();
      if (ui.announce.hidden) toast('Your turn! Pick a square.', false, 'turn');
    }
    if (!mine) ui.toasts.querySelector('[data-key="turn"]')?.remove();
  }

  // The loud one: every ship lost where fleets overlapped, for everyone at once.
  function announceCollisions(sunk, outIds) {
    const owners = [...new Set(sunk.map((s) => s.owner))];
    ui.announce.classList.toggle('clear', !sunk.length);
    ui.announceKicker.textContent = sunk.length
      ? `${plural(sunk.length, 'ship')} sank where fleets overlapped`
      : 'No fleets overlapped';
    ui.announceTitle.textContent = sunk.length ? 'Collision!' : 'All clear';
    // One card per player, so even 70-odd sunk ships fit under the headline.
    ui.announceList.replaceChildren(
      ...owners.map((owner) => {
        const li = document.createElement('li');
        const p = player(owner);
        li.style.setProperty('--pc', colorOf(p ? p.color : 0));
        li.innerHTML = '<b></b><span></span>';
        li.firstChild.textContent = outIds.includes(owner) ? `${nameOf(owner)} · OUT` : nameOf(owner);
        li.lastChild.textContent = sunk.filter((s) => s.owner === owner).map((s) => s.name).join(', ');
        return li;
      })
    );
    ui.announceOut.textContent = outIds.length ? `Out before the first shot: ${outIds.map(nameOf).join(', ')}` : '';
    ui.announce.hidden = false;
    ui.gameOver.hidden = true;
    ui.announce.querySelector('.announce-body').scrollTop = 0;
    ui.announceClose.focus({ preventScroll: true });
    if (sunk.length) {
      sound.collision(sunk.length);
      navigator.vibrate?.([300, 100, 300]);
    }
    clearTimeout(app.announceTimer);
    app.announceTimer = setTimeout(closeAnnouncement, ANNOUNCE_MS);
  }

  function closeAnnouncement() {
    clearTimeout(app.announceTimer);
    ui.announce.hidden = true;
    render();
  }

  // A `key` replaces any toast already showing with the same key.
  function toast(text, big = false, key = '') {
    if (key) ui.toasts.querySelector(`[data-key="${key}"]`)?.remove();
    const el = document.createElement('div');
    el.className = `toast${big ? ' big' : ''}`;
    el.dataset.key = key;
    el.textContent = text;
    ui.toasts.prepend(el);
    while (ui.toasts.children.length > 3) ui.toasts.lastChild.remove();
    setTimeout(() => el.remove(), big ? 4500 : 3000);
  }

  /* ---------- Sound (the effects themselves are in sounds.js) ---------- */

  const sound = (function () {
    const fx = window.BattleshipSounds;
    let ctx = null;
    let on = store.get('battleship.sound', true);
    const play = (effect, ...args) => {
      if (!on) return;
      try {
        ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') ctx.resume();
        effect(ctx, ctx.destination, ctx.currentTime, ...args);
      } catch {
        /* no audio here; the game works without it */
      }
    };
    return {
      get on() { return on; },
      toggle() {
        on = !on;
        store.set('battleship.sound', on);
      },
      hit: () => play(fx.fart),
      sunk: () => play(fx.scream, { pitch: 0.9 + Math.random() * 0.35 }),
      collision: (sunk) => play(fx.collision, sunk),
      miss: () => play(fx.splash),
      ping: () => play(fx.ping),
      fanfare: () => play(fx.fanfare),
    };
  })();

  function renderSoundButton() {
    ui.sound.textContent = sound.on ? 'Sound on' : 'Sound off';
    ui.sound.setAttribute('aria-pressed', String(sound.on));
  }

  /* ---------- Wiring ---------- */

  function newCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  }

  ui.homeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = ui.homeName.value.trim();
    if (!name) return;
    store.set('battleship.name', name);
    const code = newCode();
    history.pushState(null, '', `?room=${code}`);
    app.joining = name;
    openRoom(code);
  });

  ui.joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = ui.joinName.value.trim();
    if (!name) return;
    store.set('battleship.name', name);
    ui.lobbyError.textContent = '';
    send({ type: 'join', name });
  });

  ui.share.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareLink());
      toast('Link copied. Send it to everyone playing.');
    } catch {
      ui.shareUrl.select();
      toast('Copy the link from the box');
    }
  });

  ui.start.addEventListener('click', () => { ui.lobbyError.textContent = ''; send({ type: 'start' }); });
  ui.leave.addEventListener('click', () => {
    send({ type: 'leave' });
    app.seat = null;
    seats.set(null);
  });

  ui.sea.addEventListener('pointerdown', (event) => { app.pointer = event.pointerType; });
  ui.sea.addEventListener('click', (event) => {
    const control = event.target.closest('[data-edit]');
    if (control) return onEdit(control);
    const cell = event.target.closest('.cell');
    if (cell) onCellClick(+cell.dataset.x, +cell.dataset.y);
  });
  ui.sea.addEventListener('pointerover', (event) => {
    const cell = event.target.closest('.cell');
    if (!cell || app.state?.phase !== 'placing' || event.pointerType === 'touch' || app.placing.draft) return;
    app.placing.hover = { x: +cell.dataset.x, y: +cell.dataset.y };
    renderBoard();
  });
  ui.sea.addEventListener('pointerleave', () => {
    if (!app.placing.hover) return;
    app.placing.hover = null;
    if (app.state?.phase === 'placing') renderBoard();
  });
  ui.sea.addEventListener('contextmenu', (event) => {
    if (app.state?.phase !== 'placing') return;
    event.preventDefault();
    rotate();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() === 'r' && app.state?.phase === 'placing' && !event.target.closest('input')) rotate();
    if (event.key === 'Escape' && !ui.announce.hidden) closeAnnouncement();
  });

  ui.randomize.addEventListener('click', randomize);

  ui.zoomIn.addEventListener('click', () => setZoom(app.zoom * 1.5));
  ui.zoomOut.addEventListener('click', () => setZoom(app.zoom / 1.5));
  ui.zoomFit.addEventListener('click', () => setZoom(1));
  // Pinch to zoom the sea itself; the page doesn't zoom, and one finger still scrolls.
  let pinch = null;
  const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const middle = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
  ui.seaWrap.addEventListener('touchstart', (event) => {
    if (event.touches.length === 2 && zoomable()) pinch = { spread: spread(event.touches), zoom: app.zoom };
  }, { passive: true });
  ui.seaWrap.addEventListener('touchmove', (event) => {
    if (!pinch || event.touches.length !== 2) return;
    event.preventDefault();
    setZoom((pinch.zoom * spread(event.touches)) / pinch.spread, middle(event.touches));
  }, { passive: false });
  ui.seaWrap.addEventListener('touchend', (event) => { if (event.touches.length < 2) pinch = null; });
  narrow.addEventListener('change', () => app.state && app.state.phase !== 'lobby' && renderBoard());
  ui.clear.addEventListener('click', clearShips);
  ui.done.addEventListener('click', () => send({ type: 'place', ships: placedShips() }));
  ui.change.addEventListener('click', () => {
    resetPlacement();
    send({ type: 'unready' });
  });

  ui.announceClose.addEventListener('click', closeAnnouncement);
  ui.again.addEventListener('click', () => send({ type: 'restart' }));
  ui.newRoom.addEventListener('click', () => { location.href = location.pathname; });
  ui.viewBoard.addEventListener('click', () => {
    app.viewingBoard = true;
    render();
  });
  ui.sound.addEventListener('click', () => {
    sound.toggle();
    renderSoundButton();
  });

  // Keep the turn clock and vote countdown moving between server updates.
  setInterval(() => {
    if (app.state?.phase !== 'battle') return;
    const clockEl = ui.status.querySelector('[data-clock]');
    if (clockEl) clockEl.textContent = clock(turnAge());
    renderVotes();
  }, 250);

  renderSoundButton();
  const room = new URLSearchParams(location.search).get('room');
  if (room && /^[A-Za-z0-9]{6}$/.test(room)) {
    openRoom(room.toUpperCase());
  } else {
    show(ui.home);
    ui.homeName.value = store.get('battleship.name', '');
    ui.homeName.focus();
  }
  window.addEventListener('popstate', () => location.reload());
  document.addEventListener('visibilitychange', checkConnection);
  window.addEventListener('pageshow', (event) => { if (event.persisted) checkConnection(); });
  window.addEventListener('online', checkConnection);
})();
