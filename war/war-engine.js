/*
 * War — game rules only, no DOM. Loads as a classic script in the browser
 * (window.WarEngine) and as a CommonJS module in Node for tests.
 */
(function (root) {
  'use strict';

  const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
  const WAR_FACE_DOWN = 3;

  function createDeck() {
    const deck = [];
    SUITS.forEach((suit, s) => {
      RANKS.forEach((_, rank) => deck.push({ id: s * 13 + rank, rank, suit }));
    });
    return deck;
  }

  function shuffle(cards, rng) {
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    return cards;
  }

  /*
   * A game advances in two calls, so the UI can show each step:
   *   flip()    both players put cards down; returns what was placed and who won (or 'tie')
   *   collect() the winner takes the table; call after any flip that wasn't a tie
   *
   * `piles` (two arrays of cards, index 0 = top) replaces the shuffle and deal; tests use it.
   */
  function createGame({ rng = Math.random, piles: dealt } = {}) {
    let piles;
    if (dealt) {
      piles = [dealt[0].slice(), dealt[1].slice()];
    } else {
      const deck = shuffle(createDeck(), rng);
      piles = [deck.slice(0, 26), deck.slice(26)];
    }
    let table = [[], []];
    let warDepth = 0;     // ties so far in the current battle
    let pending = null;   // who takes the table: 0, 1, or 'split'
    let winner = null;
    let battles = 0;
    let wars = 0;

    function flip() {
      if (winner !== null) throw new Error('The game is over');
      if (pending !== null) throw new Error('Collect the table before flipping again');

      const isWar = warDepth > 0;
      if (!isWar) battles++;
      const placed = [{ down: [], up: null }, { down: [], up: null }];

      // Only reachable mid-war: a player used their last card on the tie and can't answer it.
      const outOfCards = [piles[0].length === 0, piles[1].length === 0];
      if (outOfCards[0] || outOfCards[1]) {
        pending = outOfCards[0] && outOfCards[1] ? 'split' : outOfCards[0] ? 1 : 0;
        return { isWar, placed, result: pending, warDepth, outOfCards };
      }

      for (let p = 0; p < 2; p++) {
        if (isWar) {
          // Short on cards: keep one back for the face-up card.
          const down = Math.min(WAR_FACE_DOWN, piles[p].length - 1);
          placed[p].down = piles[p].splice(0, down);
        }
        placed[p].up = piles[p].shift();
        table[p].push(...placed[p].down, placed[p].up);
      }

      const a = placed[0].up.rank;
      const b = placed[1].up.rank;
      let result;
      if (a === b) {
        warDepth++;
        wars++;
        result = 'tie';
      } else {
        result = a > b ? 0 : 1;
        pending = result;
      }
      return { isWar, placed, result, warDepth, outOfCards };
    }

    function collect() {
      if (pending === null) throw new Error('Nothing to collect');
      const taker = pending;
      const count = table[0].length + table[1].length;
      if (taker === 'split') {
        // Both ran dry on the same tie: everyone takes back their own cards.
        piles[0].push(...shuffle(table[0], rng));
        piles[1].push(...shuffle(table[1], rng));
      } else {
        // Shuffle the winnings so the card order can't settle into an endless loop.
        piles[taker].push(...shuffle(table[0].concat(table[1]), rng));
      }
      table = [[], []];
      warDepth = 0;
      pending = null;
      if (piles[0].length === 0) winner = 1;
      else if (piles[1].length === 0) winner = 0;
      return { taker, count, gameOver: winner !== null };
    }

    return {
      flip,
      collect,
      get counts() { return [piles[0].length, piles[1].length]; },
      get tableCounts() { return [table[0].length, table[1].length]; },
      get needsCollect() { return pending !== null; },
      get winner() { return winner; },
      get battles() { return battles; },
      get wars() { return wars; },
    };
  }

  const api = { RANKS, SUITS, WAR_FACE_DOWN, createDeck, shuffle, createGame };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WarEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
