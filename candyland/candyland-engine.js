/*
 * Candy Land — board, deck, and rules only, no DOM. Loads as a classic script in the
 * browser (window.CandyLandEngine) and as a CommonJS module in Node for tests.
 *
 * Rules follow Hasbro's 2004 sheet (04700): draw a card, move to the first (or second)
 * matching color space, picture cards jump forward or back, two shortcuts on exact
 * landings, licorice spaces cost a turn, first to the rainbow space wins.
 */
(function (root) {
  'use strict';

  const COLORS = ['red', 'purple', 'yellow', 'blue', 'orange', 'green'];

  // Pink picture spaces, at roughly the classic board's positions.
  const PICTURES = [
    { id: 'plum', name: 'Plum Tree', at: 9 },
    { id: 'candy-cane', name: 'Candy Cane', at: 20 },
    { id: 'gumdrop', name: 'Gumdrop', at: 42 },
    { id: 'peanut', name: 'Peanut', at: 69 },
    { id: 'lollipop', name: 'Lollipop', at: 92 },
    { id: 'ice-cream', name: 'Ice Cream', at: 102 },
  ];

  const PATH_SPACES = 134; // spaces between Start (0) and the rainbow space
  const END = PATH_SPACES + 1;

  // Land on `from` by exact count and you jump to `to` (orange → purple, yellow → green).
  const SHORTCUTS = [
    { id: 'rainbow-trail', name: 'Rainbow Trail', from: 5, to: 59 },
    { id: 'gumdrop-pass', name: 'Gumdrop Pass', from: 35, to: 45 },
  ];

  const LICORICE = [48, 86, 121];

  // Colors run red, purple, yellow, blue, orange, green; picture spaces sit between them.
  const SPACES = (function buildSpaces() {
    const spaces = [{ index: 0, kind: 'start' }];
    let c = 0;
    for (let i = 1; i <= PATH_SPACES; i++) {
      const picture = PICTURES.find((p) => p.at === i);
      if (picture) spaces.push({ index: i, kind: 'picture', picture: picture.id });
      else spaces.push({ index: i, kind: 'color', color: COLORS[c++ % COLORS.length] });
    }
    spaces.push({ index: END, kind: 'rainbow' });
    SHORTCUTS.forEach((s) => { spaces[s.from].shortcut = s.id; });
    LICORICE.forEach((i) => { spaces[i].licorice = true; });
    return spaces;
  })();

  // 64 cards: singles (8 each, 7 for green and orange), 2 doubles per color, 6 pictures.
  function createDeck() {
    const deck = [];
    const singles = { red: 8, purple: 8, yellow: 8, blue: 8, orange: 7, green: 7 };
    COLORS.forEach((color) => {
      for (let i = 0; i < singles[color]; i++) deck.push({ type: 'color', color, double: false });
      for (let i = 0; i < 2; i++) deck.push({ type: 'color', color, double: true });
    });
    PICTURES.forEach((p) => deck.push({ type: 'picture', picture: p.id }));
    return deck;
  }

  function shuffle(cards, rng) {
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    return cards;
  }

  // Where a card sends a pawn standing on `from`, before shortcuts.
  function destination(from, card) {
    if (card.type === 'picture') return PICTURES.find((p) => p.id === card.picture).at;
    let matches = card.double ? 2 : 1;
    for (let i = from + 1; i < END; i++) {
      if (SPACES[i].color === card.color && --matches === 0) return i;
    }
    return END; // no more spaces of that color: straight to the rainbow
  }

  /*
   * `deck` (cards, index 0 = top) replaces the shuffle; tests use it to stack the deck.
   * Each takeTurn() plays one player's whole turn and returns what happened.
   */
  function createGame({ players = 2, rng = Math.random, deck } = {}) {
    if (players < 2 || players > 4) throw new Error('Candy Land is for 2 to 4 players');
    let draw = deck ? deck.slice() : shuffle(createDeck(), rng);
    let discard = [];
    const positions = new Array(players).fill(0);
    const stuck = new Array(players).fill(false);
    let current = 0;
    let winner = null;
    let turns = 0;

    function takeTurn() {
      if (winner !== null) throw new Error('The game is over');
      const player = current;
      current = (current + 1) % players;
      turns++;
      const from = positions[player];

      if (stuck[player]) {
        stuck[player] = false;
        return { player, skipped: true, from, to: from };
      }

      let reshuffled = false;
      if (!draw.length) {
        draw = shuffle(discard, rng);
        discard = [];
        reshuffled = true;
      }
      const card = draw.shift();
      discard.push(card);

      const landed = destination(from, card);
      const shortcut = SHORTCUTS.find((s) => s.from === landed) || null;
      const to = shortcut ? shortcut.to : landed;
      positions[player] = to;
      const licorice = !!SPACES[to].licorice;
      if (licorice) stuck[player] = true;
      if (to === END) winner = player;

      return { player, skipped: false, card, from, landed, to, shortcut, licorice, won: to === END, reshuffled };
    }

    return {
      takeTurn,
      get players() { return players; },
      get positions() { return positions.slice(); },
      get stuck() { return stuck.slice(); },
      get current() { return current; },
      get winner() { return winner; },
      get turns() { return turns; },
      get cardsLeft() { return draw.length; },
    };
  }

  const api = { COLORS, PICTURES, SHORTCUTS, LICORICE, SPACES, END, createDeck, shuffle, destination, createGame };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CandyLandEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
