const test = require('node:test');
const assert = require('node:assert/strict');
const { RANKS, createDeck, createGame } = require('../war/war-engine.js');

// Deterministic RNG so failures can be replayed.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let nextId = 100;
const card = (label) => ({ id: nextId++, rank: RANKS.indexOf(label), suit: 'spades' });
const pile = (labels) => labels.split(' ').map(card);

test('deals 26 unique cards to each player', () => {
  const game = createGame({ rng: mulberry32(1) });
  assert.deepEqual(game.counts, [26, 26]);
  assert.equal(createDeck().length, 52);
  assert.equal(new Set(createDeck().map((c) => c.id)).size, 52);
});

test('higher card takes both cards; suits do not matter', () => {
  const game = createGame({ piles: [pile('K 5'), pile('3 9')] });
  const flip = game.flip();
  assert.equal(flip.result, 0);
  assert.equal(flip.isWar, false);
  const res = game.collect();
  assert.deepEqual(res, { taker: 0, count: 2, gameOver: false });
  assert.deepEqual(game.counts, [3, 1]);
});

test('ace is high, two is low', () => {
  const game = createGame({ piles: [pile('2 4'), pile('A 4')] });
  assert.equal(game.flip().result, 1);
});

test('a tie starts a war: three down, one up, winner takes all 10', () => {
  const game = createGame({ piles: [pile('7 2 2 2 A 3'), pile('7 3 3 3 2 4')] });
  const tie = game.flip();
  assert.equal(tie.result, 'tie');
  assert.equal(tie.warDepth, 1);

  const war = game.flip();
  assert.equal(war.isWar, true);
  assert.equal(war.placed[0].down.length, 3);
  assert.equal(war.placed[1].down.length, 3);
  assert.equal(war.result, 0);
  assert.deepEqual(game.collect(), { taker: 0, count: 10, gameOver: false });
  assert.deepEqual(game.counts, [11, 1]);
});

test('a tied war starts another war on top of it', () => {
  const game = createGame({
    piles: [pile('7 2 2 2 9 2 2 2 K 5'), pile('7 3 3 3 9 3 3 3 Q 5')],
  });
  assert.equal(game.flip().result, 'tie');
  const second = game.flip();
  assert.equal(second.result, 'tie');
  assert.equal(second.warDepth, 2);
  assert.equal(game.flip().result, 0);
  assert.equal(game.collect().count, 18);
  assert.equal(game.wars, 2);
  assert.equal(game.battles, 1);
});

test('a player short on cards for a war keeps one back to flip face-up', () => {
  const game = createGame({ piles: [pile('7 2 2 2 A'), pile('7 3 K')] });
  game.flip();
  const war = game.flip();
  assert.equal(war.placed[1].down.length, 1);
  assert.equal(war.placed[1].up.rank, RANKS.indexOf('K'));
  assert.equal(war.result, 0);
  assert.deepEqual(game.collect(), { taker: 0, count: 8, gameOver: true });
  assert.equal(game.winner, 0);
  assert.deepEqual(game.counts, [8, 0]);
});

test('a player who ties with their last card loses the war', () => {
  const game = createGame({ piles: [pile('5'), pile('5 9 J')] });
  assert.equal(game.flip().result, 'tie');
  const war = game.flip();
  assert.deepEqual(war.outOfCards, [true, false]);
  assert.equal(war.result, 1);
  assert.deepEqual(game.collect(), { taker: 1, count: 2, gameOver: true });
  assert.equal(game.winner, 1);
  assert.deepEqual(game.counts, [0, 4]);
});

test('if both run out on the same tie, each takes back their own cards', () => {
  const game = createGame({ piles: [pile('5'), pile('5')], rng: mulberry32(3) });
  game.flip();
  assert.equal(game.flip().result, 'split');
  assert.equal(game.collect().gameOver, false);
  assert.deepEqual(game.counts, [1, 1]);
});

test('flip and collect must alternate after a decided battle', () => {
  const game = createGame({ piles: [pile('K 5'), pile('3 9')] });
  assert.throws(() => game.collect());
  game.flip();
  assert.throws(() => game.flip());
});

test('random games always finish, never lose a card, and end 52–0', () => {
  for (let seed = 1; seed <= 2000; seed++) {
    const game = createGame({ rng: mulberry32(seed) });
    let flips = 0;
    while (game.winner === null) {
      const { result } = game.flip();
      const total = game.counts[0] + game.counts[1] + game.tableCounts[0] + game.tableCounts[1];
      assert.equal(total, 52, `seed ${seed}: card count drifted`);
      if (result !== 'tie') game.collect();
      assert.ok(++flips < 100000, `seed ${seed}: game did not finish`);
    }
    assert.equal(game.counts[game.winner], 52);
    assert.throws(() => game.flip());
  }
});
