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
    status: $('status'),
    dock: $('dock'),
    dockShips: $('dock-ships'),
    rotate: $('rotate'),
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
    placing: { ships: {}, selected: 'carrier', dir: 'h', hover: null },
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
    const parts = ['<div class="water"></div>'];
    for (let x = 0; x < size; x++) parts.push(`<span class="label" style="grid-area:1/${x + 2}">${LETTERS[x]}</span>`);
    for (let y = 0; y < size; y++) parts.push(`<span class="label" style="grid-area:${y + 2}/1">${y + 1}</span>`);
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
    ui.sea.querySelectorAll('.ship, .mark').forEach((n) => n.remove());

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
        const preview = previewShip();
        if (preview) layer.append(shipEl(preview.ship, `preview${preview.ok ? '' : ' bad'}`, myColor));
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

  function resetPlacement() {
    const own = app.state.myShips;
    app.placing = { ships: {}, selected: fleet()[0]?.id || null, dir: 'h', hover: null };
    if (own) own.forEach((ship) => { app.placing.ships[ship.id] = { x: ship.x, y: ship.y, dir: ship.dir }; });
    if (own) app.placing.selected = null;
  }

  const spec = (id) => fleet().find((s) => s.id === id);

  function placedShips() {
    return fleet()
      .filter((s) => app.placing.ships[s.id])
      .map((s) => ({ id: s.id, name: s.name, size: s.size, ...app.placing.ships[s.id] }));
  }

  // Where the selected ship would go if dropped at (x, y): pulled back onto the board, and
  // checked against your own ships (other players' ships are invisible, so they can't be).
  function candidate(x, y) {
    const { selected, dir } = app.placing;
    if (!selected) return null;
    const size = app.state.size;
    const len = spec(selected).size;
    const ship = {
      id: selected,
      size: len,
      dir,
      x: dir === 'h' ? Math.min(x, size - len) : x,
      y: dir === 'v' ? Math.min(y, size - len) : y,
    };
    const others = placedShips().filter((s) => s.id !== selected);
    const ok = !E.shipCells(ship).some(([cx, cy]) => others.some((o) => E.covers(o, cx, cy)));
    return { ship, ok };
  }

  function previewShip() {
    const { hover } = app.placing;
    return hover ? candidate(hover.x, hover.y) : null;
  }

  function placeAt(x, y) {
    const placing = app.placing;
    const there = placedShips().find((s) => E.covers(s, x, y));
    if (there && there.id !== placing.selected) {
      // Pick an already placed ship back up.
      delete placing.ships[there.id];
      placing.selected = there.id;
      placing.dir = there.dir;
    } else {
      const c = candidate(x, y);
      if (!c) return;
      if (!c.ok) return toast("Your ships can't overlap each other");
      placing.ships[c.ship.id] = { x: c.ship.x, y: c.ship.y, dir: c.ship.dir };
      placing.selected = fleet().find((s) => !placing.ships[s.id])?.id || null;
    }
    renderBoard();
    renderDock();
  }

  function rotate() {
    app.placing.dir = app.placing.dir === 'h' ? 'v' : 'h';
    renderBoard();
  }

  function randomize() {
    app.placing.ships = {};
    E.randomFleet(app.state.size, Math.random, fleet()).forEach((s) => { app.placing.ships[s.id] = { x: s.x, y: s.y, dir: s.dir }; });
    app.placing.selected = null;
    renderBoard();
    renderDock();
  }

  function clearShips() {
    app.placing.ships = {};
    app.placing.selected = fleet()[0]?.id || null;
    renderBoard();
    renderDock();
  }

  function renderDock() {
    const s = app.state;
    const mine = me();
    ui.dock.hidden = !(s.phase === 'placing' && mine);
    if (ui.dock.hidden) return;
    const ready = mine.ready;
    const color = colorOf(mine.color);
    ui.dockShips.hidden = ready;
    ui.rotate.parentElement.hidden = ready;
    ui.done.hidden = ready;
    ui.change.hidden = !ready;
    if (ready) return;

    ui.dockShips.replaceChildren(
      ...fleet().map((ship) => {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `ship-pick${app.placing.ships[ship.id] ? ' placed' : ''}`;
        button.setAttribute('aria-pressed', String(app.placing.selected === ship.id));
        button.style.setProperty('--pc', color);
        button.innerHTML = `<span class="name">${ship.name}</span><span class="ship-size">${'<i></i>'.repeat(ship.size)}</span>`;
        button.addEventListener('click', () => {
          delete app.placing.ships[ship.id];
          app.placing.selected = ship.id;
          renderBoard();
          renderDock();
        });
        li.append(button);
        return li;
      })
    );
    ui.done.disabled = placedShips().length < fleet().length;
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
        note = 'Pick a ship, then a square. Rotate with R, right-click, or the button. Nobody can see your ships.';
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
          sound.boom();
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
      sound.boom(true);
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

  /* ---------- Sound: synthesized, so there are no files to load ---------- */

  const sound = (function () {
    let ctx = null;
    let on = store.get('battleship.sound', true);
    const audio = () => {
      if (!on) return null;
      try {
        ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
      } catch {
        return null;
      }
    };
    function noise(duration, from, to, gain) {
      const c = audio();
      if (!c) return;
      const buffer = c.createBuffer(1, Math.floor(c.sampleRate * duration), c.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const src = c.createBufferSource();
      src.buffer = buffer;
      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(from, c.currentTime);
      filter.frequency.exponentialRampToValueAtTime(to, c.currentTime + duration);
      const g = c.createGain();
      g.gain.setValueAtTime(gain, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);
      src.connect(filter).connect(g).connect(c.destination);
      src.start();
    }
    function tone(freq, duration, gain, delay = 0) {
      const c = audio();
      if (!c) return;
      const t = c.currentTime + delay;
      const osc = c.createOscillator();
      osc.frequency.setValueAtTime(freq, t);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      osc.connect(g).connect(c.destination);
      osc.start(t);
      osc.stop(t + duration + 0.05);
    }
    return {
      get on() { return on; },
      toggle() {
        on = !on;
        store.set('battleship.sound', on);
      },
      boom(huge) {
        noise(huge ? 2.2 : 1.3, 1400, 50, huge ? 1 : 0.7);
        tone(48, huge ? 1.2 : 0.7, 0.5);
      },
      hit: () => noise(0.45, 1000, 120, 0.5),
      miss: () => noise(0.3, 3500, 700, 0.2),
      ping: () => { tone(880, 0.18, 0.15); tone(1320, 0.25, 0.12, 0.12); },
      fanfare: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, 0.14, i * 0.13)),
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
    const cell = event.target.closest('.cell');
    if (cell) onCellClick(+cell.dataset.x, +cell.dataset.y);
  });
  ui.sea.addEventListener('pointerover', (event) => {
    const cell = event.target.closest('.cell');
    if (!cell || app.state?.phase !== 'placing' || event.pointerType === 'touch') return;
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

  ui.rotate.addEventListener('click', rotate);
  ui.randomize.addEventListener('click', randomize);
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
