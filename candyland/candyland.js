/* Candy Land — setup, board drawing, and the auto-play loop. Rules live in candyland-engine.js. */
(function () {
  'use strict';

  const { SPACES, SHORTCUTS, PICTURES, END, createGame } = window.CandyLandEngine;
  const { layoutBoard } = window.CandyLandBoard;
  const { SPEEDS, store, speedOptions, speedSwitch, formatClock, prefersReducedMotion } = window.Lightning;

  const NS = 'http://www.w3.org/2000/svg';

  const TILE_COLORS = {
    red: '#f2545b', purple: '#a463f2', yellow: '#ffd23f', blue: '#4d9de0', orange: '#ff9f43', green: '#3fbf7f',
  };
  const PINK = '#ff8fc7';
  const RAINBOW = ['#f2545b', '#ff9f43', '#ffd23f', '#3fbf7f', '#4d9de0', '#a463f2'];

  const PAWN_COLORS = [
    { id: 'red', name: 'Red', hex: '#e63946' },
    { id: 'blue', name: 'Blue', hex: '#2f6fed' },
    { id: 'green', name: 'Green', hex: '#1f9d55' },
    { id: 'yellow', name: 'Yellow', hex: '#f5b800' },
    { id: 'purple', name: 'Purple', hex: '#8e44e8' },
    { id: 'orange', name: 'Orange', hex: '#ff7a1a' },
    { id: 'pink', name: 'Pink', hex: '#ff4fa3' },
    { id: 'brown', name: 'Gingerbread', hex: '#9a5b2e' },
  ];
  const DEFAULT_COLORS = ['red', 'blue', 'green', 'yellow'];
  const DEFAULT_NAMES = ['Player 1', 'Player 2', 'Player 3', 'Player 4'];

  // Median game length in turns, from simulating 5,000 games per player count.
  const MEDIAN_TURNS = { 2: 46, 3: 57, 4: 67 };
  const SPEED_BLURB = {
    normal: 'A card every 2 seconds',
    fast: 'A card every ¾ second',
    insane: 'Four cards a second',
  };

  // Pawns sharing a space spread out to these spots (in tile pitches from the center).
  const SLOTS = {
    1: [[0, 0]],
    2: [[-0.2, 0], [0.2, 0]],
    3: [[-0.22, 0.1], [0.22, 0.1], [0, -0.16]],
    4: [[-0.2, -0.15], [0.2, -0.15], [-0.2, 0.17], [0.2, 0.17]],
  };

  const $ = (id) => document.getElementById(id);
  const ui = {
    setup: $('setup'),
    form: $('setup-form'),
    title: $('setup-title'),
    countSwitch: $('count-switch'),
    rows: $('player-rows'),
    speedOptions: $('speed-options'),
    game: $('game'),
    roster: $('roster'),
    turns: $('stat-turns'),
    speedSwitch: $('speed-switch'),
    quit: $('quit'),
    wrap: $('board-wrap'),
    board: $('board'),
    hud: $('hud'),
    card: $('cl-card'),
    hudTurn: $('hud-turn'),
    hudNote: $('hud-note'),
    hudDeck: $('hud-deck'),
    gameOver: $('game-over'),
    winner: $('winner'),
    winnerPawn: $('winner-pawn'),
    summary: $('summary'),
    replayHint: $('replay-hint'),
    playAgain: $('play-again'),
    newGame: $('new-game'),
  };

  const colorById = (id) => PAWN_COLORS.find((c) => c.id === id);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const capital = (word) => word[0].toUpperCase() + word.slice(1);
  const pictureName = (id) => PICTURES.find((p) => p.id === id).name;
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  const f1 = (n) => n.toFixed(1);

  const state = {
    setup: loadSetup(),
    speed: 'normal',
    players: [],
    game: null,
    timer: null,
    next: null,
    startedAt: 0,
    layout: null,
    pawns: [],
    pawnAt: [], // each pawn's resting point, so a move starts from where it was drawn
    anim: null,
    lastTurn: null,
  };

  const interval = () => SPEEDS[state.speed].ms;
  const flipMs = () => (prefersReducedMotion() ? 0 : Math.min(260, interval() * 0.25));

  /* ---------- Setup ---------- */

  function loadSetup() {
    const saved = store.get('candyland.setup', null);
    const count = [2, 3, 4].includes(saved?.count) ? saved.count : 2;
    const players = DEFAULT_NAMES.map((_, i) => {
      const p = saved?.players?.[i] || {};
      return { name: typeof p.name === 'string' ? p.name : '', color: colorById(p.color) ? p.color : DEFAULT_COLORS[i] };
    });
    // Colors must stay unique across the four seats.
    if (new Set(players.map((p) => p.color)).size < players.length) {
      players.forEach((p, i) => { p.color = DEFAULT_COLORS[i]; });
    }
    return { count, players };
  }

  function buildSetup() {
    // Each letter of the title in a board color.
    const letters = [...'Candy Land'];
    const colors = Object.values(TILE_COLORS);
    ui.title.setAttribute('aria-label', 'Candy Land');
    ui.title.innerHTML = letters
      .map((ch, i) =>
        ch === ' '
          ? ' '
          : `<span aria-hidden="true" style="--letter:${colors[i % colors.length]};--tilt:${i % 2 ? 4 : -4}deg">${ch}</span>`
      )
      .join('');

    [2, 3, 4].forEach((n) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = n;
      button.dataset.count = n;
      button.addEventListener('click', () => setCount(n));
      ui.countSwitch.append(button);
    });

    state.setup.players.forEach((player, seat) => {
      const row = document.createElement('div');
      row.className = 'player-row';
      row.dataset.seat = seat;
      row.innerHTML =
        '<svg class="row-pawn" aria-hidden="true"><use href="#gingerbread"/></svg>' +
        `<label><span class="visually-hidden">Player ${seat + 1} name</span>` +
        `<input class="input" maxlength="16" placeholder="${DEFAULT_NAMES[seat]}" spellcheck="false"></label>` +
        `<div class="swatches" role="radiogroup" aria-label="Player ${seat + 1} color"></div>`;
      const input = row.querySelector('input');
      input.value = player.name;
      input.addEventListener('input', () => { player.name = input.value; });

      const swatches = row.querySelector('.swatches');
      PAWN_COLORS.forEach((color) => {
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = 'swatch';
        swatch.dataset.color = color.id;
        swatch.setAttribute('role', 'radio');
        swatch.setAttribute('aria-label', color.name);
        swatch.style.setProperty('--swatch', color.hex);
        swatch.addEventListener('click', () => pickColor(seat, color.id));
        swatches.append(swatch);
      });
      ui.rows.append(row);
    });

    refreshSpeeds = speedOptions(ui.speedOptions, (key) => ({ blurb: SPEED_BLURB[key], eta: etaText(key) }), start);
    ui.form.addEventListener('submit', (event) => {
      event.preventDefault();
      start(state.speed);
    });
    setCount(state.setup.count);
    renderColors();
  }

  let refreshSpeeds = () => {};

  function etaText(key) {
    const seconds = (MEDIAN_TURNS[state.setup.count] * SPEEDS[key].ms) / 1000;
    return seconds >= 90 ? `~${Math.round(seconds / 60)} min game` : `~${Math.max(5, Math.round(seconds / 5) * 5)} sec game`;
  }

  function setCount(n) {
    state.setup.count = n;
    ui.countSwitch.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.count === n)));
    ui.rows.querySelectorAll('.player-row').forEach((row) => { row.hidden = +row.dataset.seat >= n; });
    refreshSpeeds();
  }

  // Picking a color another seat has swaps the two, so colors stay unique.
  function pickColor(seat, colorId) {
    const players = state.setup.players;
    const other = players.find((p) => p.color === colorId);
    if (other) other.color = players[seat].color;
    players[seat].color = colorId;
    renderColors();
  }

  function renderColors() {
    ui.rows.querySelectorAll('.player-row').forEach((row) => {
      const player = state.setup.players[+row.dataset.seat];
      row.style.setProperty('--pawn', colorById(player.color).hex);
      row.querySelectorAll('.swatch').forEach((s) => s.setAttribute('aria-checked', String(s.dataset.color === player.color)));
    });
  }

  function showSetup() {
    stop();
    ui.game.hidden = true;
    ui.gameOver.hidden = true;
    ui.setup.hidden = false;
    ui.rows.querySelector('input').focus();
  }

  function start(speedKey) {
    const { count, players } = state.setup;
    players.forEach((p) => { p.name = p.name.trim(); });
    ui.rows.querySelectorAll('input').forEach((input, i) => { input.value = players[i].name; });
    store.set('candyland.setup', { count, players });

    state.players = players.slice(0, count).map((p, i) => {
      const color = colorById(p.color);
      return { name: p.name || DEFAULT_NAMES[i], hex: color.hex };
    });
    setSpeed(speedKey);
    ui.setup.hidden = true;
    ui.game.hidden = false;
    newGame();
  }

  /* ---------- Loop ---------- */

  function schedule(step, ms) {
    clearTimeout(state.timer);
    state.next = { step, at: performance.now() + ms };
    state.timer = setTimeout(() => {
      state.next = null;
      step();
    }, ms);
  }

  function stop() {
    clearTimeout(state.timer);
    state.timer = null;
    state.next = null;
    finishAnimation();
  }

  // The top-bar switch can change speed mid-game; a step already waiting is pulled in to match.
  function setSpeed(key) {
    state.speed = key;
    showSpeed(key);
    if (state.next) {
      const { step, at } = state.next;
      schedule(step, Math.min(Math.max(0, at - performance.now()), interval()));
    }
  }

  function newGame() {
    stop();
    state.game = createGame({ players: state.players.length });
    state.lastTurn = null;
    state.startedAt = performance.now();
    ui.gameOver.hidden = true;
    renderRoster();
    renderBoard();
    renderHud(null);
    renderStats();
    schedule(tick, Math.min(interval(), 700));
  }

  function tick() {
    finishAnimation();
    const turn = state.game.takeTurn();
    state.lastTurn = turn;
    renderHud(turn);
    renderStats();
    updateRoster(turn.player);

    const delay = flipMs() * 0.6;
    const duration = moveDuration(turn, interval() * 0.62 - delay);
    animateTurn(turn, delay, duration);

    if (turn.won) schedule(finish, delay + duration + 600);
    else schedule(tick, interval());
  }

  function moveDuration(turn, budget) {
    if (prefersReducedMotion() || turn.skipped) return 0;
    const tiles = Math.abs(turn.landed - turn.from);
    const wanted = 180 + 110 * Math.min(tiles, 12) + (tiles > 12 ? 400 : 0) + (turn.shortcut ? 500 : 0);
    return Math.max(0, Math.min(wanted, budget));
  }

  function finish() {
    const winner = state.game.winner;
    const player = state.players[winner];
    const rounds = Math.ceil(state.game.turns / state.players.length);
    ui.roster.children[winner].classList.add('winner');
    ui.winner.textContent = `${player.name} wins!`;
    ui.winnerPawn.style.setProperty('--pawn', player.hex);
    ui.summary.textContent =
      `Reached the Candy Castle after ${plural(rounds, 'round')} ` +
      `(${formatClock(performance.now() - state.startedAt)}).`;
    ui.replayHint.textContent =
      `Play again keeps these ${state.players.length} players on ${SPEEDS[state.speed].label}.`;
    ui.gameOver.hidden = false;
    ui.playAgain.focus();
  }

  /* ---------- Board ---------- */

  function renderBoard() {
    const w = ui.wrap.clientWidth;
    const h = ui.wrap.clientHeight;
    if (!w || !h) return;
    finishAnimation();
    const layout = layoutBoard(w, h, END + 1);
    state.layout = layout;
    const s = layout.pitch;
    const t = s * 0.84;

    const road = 'M' + layout.road.map(([x, y]) => `${f1(x)} ${f1(y)}`).join('L');
    ui.board.setAttribute('viewBox', `0 0 ${w} ${h}`);
    ui.board.innerHTML =
      `<path class="road-edge" d="${road}" stroke-width="${f1(s * 1.22)}"/>` +
      `<path class="road" d="${road}" stroke-width="${f1(s * 1.04)}"/>` +
      '<g class="tiles">' + SPACES.map((space, i) => tileMarkup(space, layout.tiles[i], t)).join('') + '</g>' +
      '<g class="marks">' + SPACES.map((space, i) => markMarkup(space, layout.tiles[i], t)).join('') + '</g>' +
      SHORTCUTS.map((shortcut) => bridgeMarkup(shortcut, layout)).join('') +
      '<g class="pawns"></g>';

    const layer = ui.board.querySelector('.pawns');
    state.pawns = state.players.map((player) => {
      const pawn = document.createElementNS(NS, 'g');
      pawn.setAttribute('class', 'pawn');
      pawn.innerHTML =
        `<g class="pawn-body"><use href="#gingerbread" x="-12" y="-13" width="24" height="24" style="color:${player.hex}"/></g>`;
      layer.append(pawn);
      return pawn;
    });
    state.pawnAt = [];
    state.game.positions.forEach((_, seat) => placePawn(seat, restPoint(seat)));
    positionHud();
  }

  function tileMarkup(space, p, t) {
    const at = `translate(${f1(p.x)} ${f1(p.y)}) rotate(${f1(p.angle)})`;
    const box = (size, attrs) =>
      `<rect x="${f1(-size / 2)}" y="${f1(-size / 2)}" width="${f1(size)}" height="${f1(size)}" rx="${f1(size * 0.24)}" ${attrs}/>`;
    if (space.kind === 'start') {
      return `<g transform="${at}">${box(t * 1.3, `fill="#fff" stroke="${PINK}" stroke-width="${f1(t * 0.1)}"`)}</g>`;
    }
    if (space.kind === 'rainbow') {
      return `<g transform="${at}">${box(t * 1.45, 'fill="url(#rainbow-fill)" stroke="#fff" stroke-width="2"')}</g>`;
    }
    const fill = space.kind === 'picture' ? PINK : TILE_COLORS[space.color];
    const gloss = `<rect x="${f1(-t * 0.36)}" y="${f1(-t * 0.38)}" width="${f1(t * 0.72)}" height="${f1(t * 0.24)}" rx="${f1(t * 0.12)}" fill="#fff" fill-opacity=".32"/>`;
    return `<g transform="${at}">${box(t, `fill="${fill}"`)}${gloss}</g>`;
  }

  // Icons and labels stay upright, so they're drawn apart from the rotated tiles.
  function markMarkup(space, p, t) {
    const icon = (href, size, dy = 0) =>
      `<use href="#${href}" x="${f1(p.x - size / 2)}" y="${f1(p.y - size / 2 + dy)}" width="${f1(size)}" height="${f1(size)}"/>`;
    if (space.kind === 'picture') return icon(`pic-${space.picture}`, t * 0.82);
    if (space.licorice) return icon('licorice', t * 0.9);
    if (space.kind === 'rainbow') return icon('castle', t * 1.55, -t * 0.2);
    if (space.kind === 'start') {
      return `<text class="start-label" x="${f1(p.x)}" y="${f1(p.y)}" text-anchor="middle" dominant-baseline="central" font-size="${f1(t * 0.3)}">START</text>`;
    }
    return '';
  }

  // Shortcuts arc from their entry tile to their exit tile, bulging toward the middle of the board.
  function bridgeCurve(shortcut, layout) {
    const a = layout.tiles[shortcut.from];
    const b = layout.tiles[shortcut.to];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let nx = -(b.y - a.y) / len;
    let ny = (b.x - a.x) / len;
    if (nx * (layout.width / 2 - mx) + ny * (layout.height / 2 - my) < 0) {
      nx = -nx;
      ny = -ny;
    }
    const bulge = Math.min(len * 0.3, layout.pitch * 3);
    return { a, b, c: { x: mx + nx * bulge, y: my + ny * bulge } };
  }

  function bezierAt({ a, b, c }, t) {
    const u = 1 - t;
    return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
  }

  // A slim arc drawn over the tiles, so it reads wherever the layout puts its two ends.
  function bridgeMarkup(shortcut, layout) {
    const s = layout.pitch;
    const width = Math.max(s * 0.4, 13);
    const q = bridgeCurve(shortcut, layout);
    const d = `M${f1(q.a.x)} ${f1(q.a.y)}Q${f1(q.c.x)} ${f1(q.c.y)} ${f1(q.b.x)} ${f1(q.b.y)}`;
    const stroke = (color, w, extra = '') =>
      `<path class="bridge" d="${d}" stroke="${color}" stroke-width="${f1(w)}" ${extra}/>`;
    let art = stroke('#fff', width * 1.3);
    if (shortcut.id === 'rainbow-trail') {
      art += RAINBOW.map((color, i) => stroke(color, width * (1 - i / 6))).join('');
    } else {
      const gap = width * 1.15;
      art +=
        stroke('#ffe3ef', width) +
        ['#3fbf7f', '#f2545b', '#ffd23f']
          .map((color, i) => stroke(color, width * 0.7, `stroke-dasharray="0 ${f1(gap * 3)}" stroke-dashoffset="${f1(-gap * i)}"`))
          .join('');
    }
    // Labelled near the entry, away from the card display in the middle.
    const at = bezierAt(q, 0.22);
    const label =
      `<text class="bridge-label" x="${f1(at.x)}" y="${f1(at.y - width * 1.1)}" text-anchor="middle" ` +
      `font-size="${f1(Math.max(11, s * 0.3))}">${shortcut.name}</text>`;
    return `<g>${art}${label}</g>`;
  }

  /* ---------- Pawns ---------- */

  function restPoint(seat, positions = state.game.positions) {
    const { tiles, pitch: s } = state.layout;
    const here = positions.map((p, i) => (p === positions[seat] ? i : -1)).filter((i) => i >= 0);
    const [ox, oy] = SLOTS[here.length][here.indexOf(seat)];
    const tile = tiles[positions[seat]];
    return { x: tile.x + ox * s, y: tile.y + oy * s - s * 0.1 };
  }

  function placePawn(seat, point, lift = 0) {
    const k = (state.layout.pitch * 0.92) / 24;
    state.pawns[seat].setAttribute('transform', `translate(${f1(point.x)} ${f1(point.y - lift)}) scale(${k.toFixed(3)})`);
    if (!lift) state.pawnAt[seat] = point;
  }

  function animateTurn(turn, delay, duration) {
    // No board yet (the page has no size): keep playing; it draws, pawns and all, once it has room.
    if (!state.layout) return;
    const seat = turn.player;
    state.pawns.forEach((pawn, i) => pawn.classList.toggle('active', i === seat));
    state.pawns[seat].parentNode.append(state.pawns[seat]); // the mover draws on top

    // Everyone else settles into their spots around the mover's old and new spaces.
    state.players.forEach((_, i) => { if (i !== seat) placePawn(i, restPoint(i)); });

    if (turn.skipped) {
      wiggle(state.pawns[seat]);
      return;
    }

    const layout = state.layout;
    const s = layout.pitch;
    const from = state.pawnAt[seat] || restPoint(seat);
    const to = restPoint(seat);
    if (!duration) {
      placePawn(seat, to);
      return;
    }

    // Offsets from the tile centers, blended so the pawn ends in its spot on a shared space.
    const fromTile = layout.tiles[turn.from];
    const toTile = layout.tiles[turn.to];
    const startOff = { x: from.x - fromTile.x, y: from.y - fromTile.y };
    const endOff = { x: to.x - toTile.x, y: to.y - toTile.y };

    const tiles = Math.abs(turn.landed - turn.from);
    const bridge = turn.shortcut ? bridgeCurve(turn.shortcut, layout) : null;
    const walkShare = bridge ? (tiles ? 0.55 : 0) : 1;

    function frame(t) {
      let point;
      let lift;
      if (t < walkShare) {
        const u = t / walkShare;
        const index = turn.from + (turn.landed - turn.from) * ease(u);
        point = layout.pointAt(index * s);
        // Short walks hop tile to tile; long picture jumps take one big leap.
        lift = tiles <= 12 ? Math.abs(Math.sin(Math.PI * (index - turn.from))) * s * 0.3 : Math.sin(Math.PI * u) * s * 1.6;
      } else if (bridge) {
        const u = (t - walkShare) / (1 - walkShare);
        point = bezierAt(bridge, ease(u));
        lift = Math.sin(Math.PI * u) * s * 0.7;
      } else {
        point = layout.tiles[turn.to];
        lift = 0;
      }
      placePawn(seat, {
        x: point.x + startOff.x + (endOff.x - startOff.x) * t,
        y: point.y + startOff.y + (endOff.y - startOff.y) * t,
      }, t < 1 ? lift : 0);
    }

    const begin = performance.now() + delay;
    let id = 0;
    const step = (now) => {
      const t = Math.min(1, Math.max(0, (now - begin) / duration));
      frame(t);
      if (t < 1) id = requestAnimationFrame(step);
      else state.anim = null;
    };
    id = requestAnimationFrame(step);
    state.anim = { finish: () => { cancelAnimationFrame(id); frame(1); } };
  }

  function finishAnimation() {
    if (state.anim) {
      state.anim.finish();
      state.anim = null;
    }
  }

  function wiggle(pawn) {
    if (prefersReducedMotion()) return;
    pawn.firstElementChild.animate(
      [{ transform: 'rotate(0)' }, { transform: 'rotate(-14deg)' }, { transform: 'rotate(12deg)' }, { transform: 'rotate(0)' }],
      { duration: Math.max(200, interval() * 0.4) }
    );
  }

  /* ---------- HUD and roster ---------- */

  function positionHud() {
    const c = state.layout.clearing;
    Object.assign(ui.hud.style, { left: `${c.x}px`, top: `${c.y}px`, width: `${c.w}px`, height: `${c.h}px` });
    const wide = c.w > c.h * 1.5;
    ui.hud.classList.toggle('wide', wide);
    const cardH = wide ? Math.min(c.h * 0.95, 230) : Math.min(c.h * 0.55, (c.w * 0.8) / 0.72, 220);
    ui.card.style.setProperty('--card-h', `${Math.max(60, cardH)}px`);
  }

  function renderHud(turn) {
    const seat = turn ? turn.player : 0;
    const player = state.players[seat];
    ui.hudTurn.style.setProperty('--pawn', player.hex);
    ui.hudTurn.innerHTML = '<svg aria-hidden="true"><use href="#gingerbread"/></svg><span></span>';
    ui.hudTurn.lastChild.textContent = turn ? player.name : `${player.name} goes first`;

    ui.card.className = 'cl-card';
    if (!turn) {
      ui.card.classList.add('empty');
      ui.card.innerHTML = '';
      ui.hudNote.textContent = 'Shuffling the deck…';
    } else {
      renderCard(turn);
      ui.hudNote.textContent = describe(turn, player);
      if (flipMs()) {
        ui.card.animate([{ transform: 'rotateY(90deg) scale(.9)' }, { transform: 'none' }], {
          duration: flipMs(),
          easing: 'cubic-bezier(.2, .8, .2, 1)',
        });
      }
    }
    const left = state.game.cardsLeft;
    ui.hudDeck.textContent = `${plural(left, 'card')} in the deck${turn?.reshuffled ? ' · reshuffled' : ''}`;
  }

  function renderCard(turn) {
    if (turn.skipped) {
      ui.card.classList.add('stuck');
      ui.card.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#licorice"/></svg><span class="card-caption">Stuck!</span>';
      return;
    }
    const { card } = turn;
    if (card.type === 'picture') {
      ui.card.classList.add('picture');
      ui.card.innerHTML =
        `<div class="block"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#pic-${card.picture}"/></svg></div>` +
        `<span class="card-caption">${pictureName(card.picture)}</span>`;
      return;
    }
    ui.card.classList.add(card.double ? 'double' : 'single');
    const block = `<div class="block" style="--block:${TILE_COLORS[card.color]}"></div>`;
    ui.card.innerHTML = card.double ? block + block : block;
  }

  function describe(turn) {
    if (turn.skipped) return 'Stuck in licorice: loses this turn';
    if (turn.won) return 'Reached the Candy Castle!';
    if (turn.shortcut) return `Took the ${turn.shortcut.name} shortcut!`;
    if (turn.licorice) return 'Stuck in licorice! Loses next turn';
    const { card } = turn;
    if (card.type === 'picture') {
      const name = pictureName(card.picture);
      if (turn.to === turn.from) return `${name}: already there`;
      return turn.to > turn.from ? `${name}: jump ahead!` : `${name}: back you go`;
    }
    return card.double ? `Double ${card.color}!` : `${capital(card.color)}`;
  }

  function renderRoster() {
    ui.roster.replaceChildren(
      ...state.players.map((player) => {
        const chip = document.createElement('li');
        chip.className = 'chip';
        chip.style.setProperty('--pawn', player.hex);
        chip.innerHTML =
          '<svg class="chip-pawn" aria-hidden="true"><use href="#gingerbread"/></svg>' +
          '<span class="chip-name"></span><span class="chip-stuck" hidden>· stuck</span>';
        chip.querySelector('.chip-name').textContent = player.name;
        return chip;
      })
    );
    updateRoster(-1);
  }

  function updateRoster(activeSeat) {
    const { positions, stuck } = state.game;
    [...ui.roster.children].forEach((chip, i) => {
      chip.classList.toggle('active', i === activeSeat);
      chip.style.setProperty('--progress', positions[i] / END);
      chip.querySelector('.chip-stuck').hidden = !stuck[i];
    });
  }

  function renderStats() {
    ui.turns.textContent = Math.ceil(state.game.turns / state.players.length);
  }

  /* ---------- Wiring ---------- */

  const showSpeed = speedSwitch(ui.speedSwitch, setSpeed);
  buildSetup();
  showSpeed(state.speed);
  ui.quit.addEventListener('click', showSetup);
  ui.newGame.addEventListener('click', showSetup);
  ui.playAgain.addEventListener('click', newGame);

  let resizeFrame = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (!ui.game.hidden && state.game) renderBoard();
    });
  }).observe(ui.wrap);

  showSetup();
})();
