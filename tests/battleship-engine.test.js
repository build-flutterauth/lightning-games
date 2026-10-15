const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FLEET, boardSize, shipCells, validateFleet, randomFleet,
  createMatch, alivePlayers, isTargetable, shoot, skip, banish, votesNeeded,
} = require('../battleship/battleship-engine.js');

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Five ships stacked in rows, starting at row `top`, all against the left edge.
const rows = (top, x = 0) => FLEET.map((s, i) => ({ id: s.id, x, y: top + i, dir: 'h', size: s.size }));

test('each player gets 20 seconds before others can vote', () => {
  assert.equal(require('../battleship/battleship-engine.js').VOTE_DELAY_MS, 20000);
});

test('board size follows the player count', () => {
  const expected = { 2: 10, 3: 10, 4: 10, 5: 11, 6: 12, 10: 16, 15: 21, 20: 26 };
  for (const [n, size] of Object.entries(expected)) assert.equal(boardSize(+n), size);
});

test('a fleet must be all five ships, on the board, without overlapping itself', () => {
  assert.equal(validateFleet(rows(0), 10).length, 5);
  assert.throws(() => validateFleet(rows(0).slice(1), 10), /five ships/);
  assert.throws(() => validateFleet(rows(6), 10), /off the board/);
  const overlapping = rows(0);
  overlapping[1] = { ...overlapping[1], y: 0 };
  assert.throws(() => validateFleet(overlapping, 10), /cannot overlap/);
  const sideways = rows(0);
  sideways[0] = { ...sideways[0], x: 7 };
  assert.throws(() => validateFleet(sideways, 10), /off the board/);
});

test('random fleets are always valid, even on the smallest board', () => {
  for (let seed = 1; seed < 300; seed++) validateFleet(randomFleet(10, mulberry32(seed)), 10);
});

test('ships of different players sharing a square all sink at the start', () => {
  const c = rows(5, 5);
  c[0] = { id: 'carrier', x: 4, y: 0, dir: 'v', size: 5 };      // crosses a's carrier at (4,0)
  c[1] = { id: 'battleship', x: 3, y: 6, dir: 'h', size: 4 };   // crosses b's battleship at (3,6)
  const fleets = { a: rows(0), b: rows(5), c };
  const { match, events } = createMatch({ size: 10, fleets, order: ['a', 'b', 'c'] });
  const sunk = events[0].sunk.map((s) => `${s.owner}:${s.ship}`).sort();
  assert.deepEqual(sunk, ['a:carrier', 'b:battleship', 'c:battleship', 'c:carrier']);
  assert.equal(match.ships.filter((s) => s.sunk).length, 4);
  assert.equal(match.turn, 'a', 'everyone still has ships, so play starts');
});

test('a player whose whole fleet collides is out immediately', () => {
  const { match, events } = createMatch({ size: 10, fleets: { a: rows(0), b: rows(0) }, order: ['a', 'b'] });
  assert.deepEqual(events.map((e) => e.kind), ['collisions', 'out', 'over']);
  assert.equal(match.over, true);
  assert.equal(match.winner, null, 'nobody is left');
});

test('turns rotate through live players; hits, sinks, and own-ship shots count', () => {
  const { match } = createMatch({ size: 10, fleets: { a: rows(0), b: rows(5) }, order: ['a', 'b'] });
  assert.equal(match.turn, 'a');
  assert.throws(() => shoot(match, 'b', 9, 9), /not your turn/);

  // a shoots b's destroyer at (0,9) and (1,9); b shoots its own ship once.
  let [e] = shoot(match, 'a', 0, 9);
  assert.equal(e.hit, true);
  assert.equal(match.turn, 'b');
  [e] = shoot(match, 'b', 0, 5);
  assert.equal(e.hit, true, 'players can hit their own ships');
  [e] = shoot(match, 'a', 1, 9);
  assert.deepEqual(e.sunk, { owner: 'b', ship: 'destroyer', name: 'Destroyer' });
  assert.throws(() => shoot(match, 'b', 0, 9), /nobody has shot/);
  assert.equal(isTargetable(match, 2, 9), true);
});

test('wreck squares cannot be targeted', () => {
  const fleets = { a: rows(0), b: [{ id: 'carrier', x: 0, y: 0, dir: 'v', size: 5 }, ...rows(6, 0).slice(1)] };
  const { match } = createMatch({ size: 10, fleets, order: ['a', 'b'] });
  const carrier = match.ships.find((s) => s.owner === 'b' && s.id === 'carrier');
  assert.ok(carrier.sunk);
  assert.equal(isTargetable(match, 0, 3), false);
});

test('sinking the last ship knocks a player out and the last fleet afloat wins', () => {
  const fleets = { a: rows(0), b: rows(5) };
  const { match } = createMatch({ size: 10, fleets, order: ['a', 'b'] });
  const bSquares = match.ships.filter((s) => s.owner === 'b').flatMap(shipCells);
  const aMisses = [];
  for (let x = 6; x < 10; x++) for (let y = 0; y < 5; y++) aMisses.push([x, y]);
  let last;
  bSquares.forEach(([x, y], i) => {
    last = shoot(match, 'a', x, y);
    if (!match.over) shoot(match, 'b', ...aMisses[i]);
  });
  assert.deepEqual(last.map((e) => e.kind), ['shot', 'out', 'over']);
  assert.equal(match.winner, 'a');
  assert.throws(() => shoot(match, 'a', 9, 9), /over/);
});

test('skip passes the turn; banish sinks the fleet and can end the game', () => {
  const fleets = { a: rows(0), b: rows(5), c: rows(0, 5) };
  const { match } = createMatch({ size: 10, fleets, order: ['a', 'b', 'c'], now: 0 });
  assert.equal(votesNeeded(match), 2, 'majority of the 2 other live players');
  skip(match, 1000);
  assert.equal(match.turn, 'b');
  assert.equal(match.turnStartedAt, 1000);
  banish(match, 'b', 2000);
  assert.equal(match.turn, 'c');
  assert.deepEqual(alivePlayers(match), ['a', 'c']);
  assert.ok(match.ships.filter((s) => s.owner === 'b').every((s) => s.sunk?.cause === 'banished'));
  assert.equal(votesNeeded(match), 1);
  const events = banish(match, 'c', 3000);
  assert.equal(match.winner, 'a');
  assert.equal(events.at(-1).kind, 'over');
});

test('random 2–20 player games always finish with at most one fleet afloat', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rng = mulberry32(seed);
    const n = 2 + (seed % 19);
    const size = boardSize(n);
    const order = Array.from({ length: n }, (_, i) => `p${i}`);
    const fleets = Object.fromEntries(order.map((id) => [id, randomFleet(size, rng)]));
    const { match } = createMatch({ size, fleets, order });
    let guard = 0;
    while (!match.over) {
      const open = [];
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (isTargetable(match, x, y)) open.push([x, y]);
      const [x, y] = open[Math.floor(rng() * open.length)];
      shoot(match, match.turn, x, y);
      assert.ok(++guard <= size * size, `seed ${seed}: too many shots`);
    }
    const afloat = new Set(match.ships.filter((s) => !s.sunk).map((s) => s.owner));
    assert.ok(afloat.size <= 1);
    if (match.winner) assert.ok(afloat.has(match.winner));
  }
});
