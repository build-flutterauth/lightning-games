/* War — screens, table rendering, and the auto-play loop. The rules live in war-engine.js. */
(function () {
  'use strict';

  const { RANKS, createGame } = window.WarEngine;
  const { SPEEDS, store, speedOptions, speedSwitch, formatClock, prefersReducedMotion } = window.Lightning;

  // War's Insane is faster than the shared 250 ms: a game is ~210 flips, so 100 ms keeps it near 20 seconds.
  const SPEED_MS = { normal: SPEEDS.normal.ms, fast: SPEEDS.fast.ms, insane: 100 };

  // How each speed reads for War. `eta` is the median game length from simulating 5,000 games (~210 flips).
  const SPEED_COPY = {
    normal: { blurb: 'A card every 2 seconds', eta: '~7 min game' },
    fast: { blurb: 'A card every ¾ second', eta: '~3 min game' },
    insane: { blurb: 'Ten cards a second', eta: '~20 sec game' },
  };

  const DEFAULT_NAMES = ['Player 1', 'Player 2'];
  const SUIT_GLYPH = { spades: '♠︎', hearts: '♥︎', diamonds: '♦︎', clubs: '♣︎' };
  const WAR_CALLS = ['War!', 'Double war!', 'Triple war!', 'Quadruple war!'];

  // Each flip interval: the cards land, the winner shows, and at COLLECT_AT the winner takes them.
  const COLLECT_AT = 0.55;
  const MAX_ANIM_MS = 380;
  const EASE_OUT = 'cubic-bezier(.2, .8, .2, 1)';
  const EASE_IN = 'cubic-bezier(.55, 0, .8, .2)';

  const $ = (id) => document.getElementById(id);
  const ui = {
    setup: $('setup'),
    form: $('setup-form'),
    art: $('setup-art'),
    nameInputs: [$('name-0'), $('name-1')],
    game: $('game'),
    battles: $('stat-battles'),
    wars: $('stat-wars'),
    warsLabel: $('stat-wars-label'),
    speedSwitch: $('speed-switch'),
    quit: $('quit'),
    share: $('share-fill'),
    callout: $('callout'),
    speedPicker: $('speed-picker'),
    matchup: $('matchup'),
    speedOptions: $('speed-options'),
    gameOver: $('game-over'),
    winner: $('winner'),
    summary: $('summary'),
    replayHint: $('replay-hint'),
    playAgain: $('play-again'),
    newGame: $('new-game'),
  };
  const seats = [...document.querySelectorAll('.side')].map((side) => ({
    side,
    name: side.querySelector('[data-name]'),
    stack: side.querySelector('.stack'),
    deck: side.querySelector('[data-deck]'),
    count: side.querySelector('[data-count]'),
    countLabel: side.querySelector('[data-count-label]'),
    play: side.querySelector('[data-play]'),
  }));

  const state = {
    names: DEFAULT_NAMES.slice(),
    speed: 'normal',
    game: null,
    timer: null,
    next: null, // the step the timer will run, and when
    flippedAt: 0,
    startedAt: 0,
  };

  const interval = () => SPEED_MS[state.speed];
  const animMs = () => (prefersReducedMotion() ? 0 : Math.min(MAX_ANIM_MS, interval() * 0.3));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

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
  }

  // Time the next flip from when this one started, so timer delays don't add up (they matter at 100 ms).
  const untilNextFlip = () => Math.max(0, state.flippedAt + interval() - performance.now());

  function tick() {
    state.flippedAt = performance.now();
    const flip = state.game.flip();
    flip.placed.forEach((placed, p) => placeCards(p, placed));
    renderCounts();
    renderStats();

    if (flip.result === 'tie') {
      showCallout(WAR_CALLS[flip.warDepth - 1] || `War ×${flip.warDepth}!`);
      schedule(tick, untilNextFlip());
      return;
    }

    const [out0, out1] = flip.outOfCards;
    if (out0 || out1) {
      const who = out0 && out1 ? 'Both players are' : `${state.names[out0 ? 0 : 1]} is`;
      showCallout(`${who} out of cards!`, true);
    }
    if (flip.result !== 'split') markWinner(flip.result);
    schedule(collect, interval() * COLLECT_AT);
  }

  function collect() {
    const result = state.game.collect();
    const ms = animMs();
    const leaving = seats.flatMap((seat, p) =>
      [...seat.play.children].map((node) => ({ node, to: result.taker === 'split' ? p : result.taker }))
    );
    leaving.forEach(({ node, to }) => flyTo(node, seats[to].deck, ms));

    schedule(() => {
      leaving.forEach(({ node }) => node.remove());
      hideCallout();
      renderCounts();
      renderShare();
      if (result.taker !== 'split' && result.count > 2) popGain(result.taker, result.count);
      if (result.gameOver) schedule(finish, 500);
      else schedule(tick, untilNextFlip());
    }, ms);
  }

  /* ---------- Screens ---------- */

  function showSetup() {
    stop();
    ui.game.hidden = true;
    ui.speedPicker.hidden = true;
    ui.gameOver.hidden = true;
    ui.setup.hidden = false;
    const saved = store.get('war.names', ['', '']);
    ui.nameInputs.forEach((input, i) => {
      input.value = typeof saved[i] === 'string' ? saved[i] : '';
    });
    ui.nameInputs[0].focus();
  }

  function onSetupSubmit(event) {
    event.preventDefault();
    const typed = ui.nameInputs.map((input) => input.value.trim());
    store.set('war.names', typed);
    state.names = typed.map((name, i) => name || DEFAULT_NAMES[i]);
    seats.forEach((seat, i) => {
      seat.name.textContent = state.names[i];
      seat.side.setAttribute('aria-label', state.names[i]);
    });

    ui.setup.hidden = true;
    ui.game.hidden = false;
    deal();

    ui.matchup.textContent = `${state.names[0]} vs ${state.names[1]}`;
    ui.speedPicker.hidden = false;
    ui.speedOptions.querySelector(`[data-speed="${state.speed}"]`).focus();
  }

  function chooseSpeed(key) {
    setSpeed(key);
    ui.speedPicker.hidden = true;
    play();
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

  function deal() {
    stop();
    state.game = createGame();
    seats.forEach((seat) => {
      seat.play.replaceChildren();
      seat.side.classList.remove('champion', 'defeated');
    });
    hideCallout();
    ui.gameOver.hidden = true;
    renderCounts();
    renderStats();
    renderShare();
  }

  function play() {
    state.startedAt = performance.now();
    schedule(tick, Math.min(interval(), 600));
  }

  function finish() {
    const { winner, battles, wars } = state.game;
    seats[winner].side.classList.add('champion');
    seats[1 - winner].side.classList.add('defeated');

    ui.winner.textContent = `${state.names[winner]} wins!`;
    ui.winner.style.setProperty('--seat', `var(--p${winner + 1})`);
    ui.summary.textContent =
      `All 52 cards after ${plural(battles, 'battle')} and ${plural(wars, 'war')} ` +
      `(${formatClock(performance.now() - state.startedAt)}).`;
    ui.replayHint.textContent =
      `Play again keeps ${state.names[0]} vs ${state.names[1]} on ${SPEEDS[state.speed].label}.`;
    ui.gameOver.hidden = false;
    ui.playAgain.focus();
  }

  /* ---------- Table rendering ---------- */

  function cardNode(card, faceDown) {
    const rank = RANKS[card.rank];
    const suit = SUIT_GLYPH[card.suit];
    const node = document.createElement('div');
    node.className = faceDown ? 'card down' : 'card';
    node.dataset.suit = card.suit;
    node.innerHTML =
      '<div class="card-inner">' +
      '<div class="card-face card-front">' +
      `<span class="corner tl">${rank}<i>${suit}</i></span>` +
      `<span class="center"><span class="rank">${rank}</span><span class="suit">${suit}</span></span>` +
      `<span class="corner br">${rank}<i>${suit}</i></span>` +
      '</div>' +
      '<div class="card-face card-back back-art"></div>' +
      '</div>';
    return node;
  }

  // Deal one player's cards from their deck onto the table, sliding earlier cards aside to make room.
  function placeCards(p, { down, up }) {
    const { play, deck } = seats[p];
    const earlier = [...play.children];
    const before = earlier.map((node) => node.getBoundingClientRect().left);

    const nodes = down.map((card) => cardNode(card, true));
    if (up) nodes.push(cardNode(up, false));
    if (!nodes.length) return;
    play.append(...nodes);
    fitPlay(play);
    if (!animMs()) return;

    // Cards go down one after another; the last must land before the winner collects.
    const spread = 1 + 0.25 * (nodes.length - 1);
    const duration = Math.min(animMs() * spread, interval() * COLLECT_AT * 0.8) / spread;
    const stagger = duration * 0.25;

    earlier.forEach((node, i) => {
      const dx = before[i] - node.getBoundingClientRect().left;
      if (dx) node.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration, easing: EASE_OUT });
    });

    const from = deck.getBoundingClientRect();
    nodes.forEach((node, i) => {
      const to = node.getBoundingClientRect();
      const timing = { duration, delay: i * stagger, easing: EASE_OUT, fill: 'backwards' };
      node.animate(
        [{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` }, { transform: 'none' }],
        timing
      );
      if (!node.classList.contains('down')) {
        node.firstElementChild.animate([{ transform: 'rotateY(180deg)' }, { transform: 'none' }], timing);
      }
    });
  }

  // Tighten the fan when a long war would run out of room.
  function fitPlay(play) {
    const cards = play.children;
    if (cards.length < 2) return;
    const cardW = cards[0].offsetWidth;
    const step = Math.min(cardW * 0.3, (play.clientWidth - cardW) / (cards.length - 1));
    play.style.setProperty('--step', `${Math.max(step, 4)}px`);
  }

  function flyTo(node, target, ms) {
    if (!ms) return;
    const from = node.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    node.style.zIndex = 10; // stay above the other half while crossing the seam
    node.animate(
      [
        { transform: 'none', opacity: 1 },
        { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(0.92)`, opacity: 0.2 },
      ],
      { duration: ms, easing: EASE_IN, fill: 'forwards' }
    );
  }

  function markWinner(winner) {
    seats[winner].play.lastElementChild?.classList.add('win');
    seats[1 - winner].play.lastElementChild?.classList.add('lose');
  }

  function renderCounts() {
    state.game.counts.forEach((n, i) => {
      const seat = seats[i];
      seat.count.textContent = n;
      seat.countLabel.textContent = n === 1 ? 'card' : 'cards';
      seat.deck.classList.toggle('empty', n === 0);

      // Draw the stack's thickness as 1px card edges under the top card.
      const depth = Math.ceil((n / 52) * 14);
      const edges = [];
      for (let d = 1; d <= depth; d++) edges.push(`0 ${d}px 0 ${d % 2 ? '#e9e3d3' : '#8d8778'}`);
      seat.deck.style.setProperty('--depth', depth);
      seat.deck.style.setProperty('--stack', edges.join(', ') || '0 0 transparent');
    });
  }

  function renderStats() {
    ui.battles.textContent = state.game.battles;
    ui.wars.textContent = state.game.wars;
    ui.warsLabel.textContent = state.game.wars === 1 ? 'war' : 'wars';
  }

  function renderShare() {
    const [a, b] = state.game.counts;
    ui.share.style.width = `${(a / (a + b)) * 100}%`;
  }

  function showCallout(text, note = false) {
    ui.callout.textContent = text;
    ui.callout.classList.toggle('note', note);
    ui.callout.hidden = false;
    const ms = animMs();
    if (ms) {
      ui.callout.animate([{ scale: 1.8, opacity: 0 }, { scale: 1, opacity: 1 }], {
        duration: Math.max(ms, 160),
        easing: 'cubic-bezier(.2, .9, .3, 1.25)',
      });
    }
  }

  function hideCallout() {
    ui.callout.hidden = true;
  }

  function popGain(p, count) {
    if (prefersReducedMotion()) return;
    const tag = document.createElement('span');
    tag.className = 'gain';
    tag.textContent = `+${count}`;
    seats[p].stack.append(tag);
    const fade = tag.animate(
      [
        { transform: 'translateY(8px)', opacity: 0 },
        { opacity: 1, offset: 0.2 },
        { transform: 'translateY(-28px)', opacity: 0 },
      ],
      { duration: Math.max(700, interval()), easing: 'ease-out', fill: 'forwards' }
    );
    fade.onfinish = () => tag.remove();
  }

  /* ---------- Setup ---------- */

  function renderSetupArt() {
    const ace = cardNode({ rank: RANKS.indexOf('A'), suit: 'spades' }, false);
    const king = cardNode({ rank: RANKS.indexOf('K'), suit: 'hearts' }, false);
    ace.classList.add('win');
    king.classList.add('win');
    ui.art.append(ace, king);
  }

  const showSpeed = speedSwitch(ui.speedSwitch, setSpeed);
  speedOptions(ui.speedOptions, (key) => SPEED_COPY[key], chooseSpeed);
  setSpeed(state.speed);
  renderSetupArt();
  ui.form.addEventListener('submit', onSetupSubmit);
  ui.quit.addEventListener('click', showSetup);
  ui.newGame.addEventListener('click', showSetup);
  ui.playAgain.addEventListener('click', () => {
    deal();
    play();
  });
  window.addEventListener('resize', () => seats.forEach((seat) => fitPlay(seat.play)));
  showSetup();
})();
