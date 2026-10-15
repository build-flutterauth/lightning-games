const test = require('node:test');
const assert = require('node:assert/strict');
const {
  COLORS, PICTURES, SHORTCUTS, LICORICE, SPACES, END, createDeck, destination, createGame,
} = require('../candyland/candyland-engine.js');

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const single = (color) => ({ type: 'color', color, double: false });
const double = (color) => ({ type: 'color', color, double: true });
const picture = (id) => ({ type: 'picture', picture: id });
const pictureAt = (id) => PICTURES.find((p) => p.id === id).at;

test('the deck has 64 cards: 46 singles, 12 doubles, 6 pictures', () => {
  const deck = createDeck();
  assert.equal(deck.length, 64);
  assert.equal(deck.filter((c) => c.type === 'color' && !c.double).length, 46);
  assert.equal(deck.filter((c) => c.double).length, 12);
  assert.equal(deck.filter((c) => c.type === 'picture').length, 6);
  for (const color of COLORS) assert.equal(deck.filter((c) => c.double && c.color === color).length, 2);
});

test('the board runs Start, colored and pink spaces, then the rainbow', () => {
  assert.equal(SPACES[0].kind, 'start');
  assert.equal(SPACES[END].kind, 'rainbow');
  assert.equal(SPACES.length, END + 1);
  assert.equal(SPACES.filter((s) => s.kind === 'picture').length, 6);
  const colors = SPACES.filter((s) => s.kind === 'color').map((s) => s.color);
  colors.forEach((color, i) => assert.equal(color, COLORS[i % 6]));
});

test('shortcuts start orange/yellow and end purple/green; licorice sits on colored spaces', () => {
  const [rainbow, gumdrop] = SHORTCUTS;
  assert.equal(SPACES[rainbow.from].color, 'orange');
  assert.equal(SPACES[rainbow.to].color, 'purple');
  assert.equal(SPACES[gumdrop.from].color, 'yellow');
  assert.equal(SPACES[gumdrop.to].color, 'green');
  for (const i of LICORICE) assert.equal(SPACES[i].kind, 'color');
});

test('one block moves to the first matching color, two blocks to the second', () => {
  assert.equal(destination(0, single('red')), 1);
  assert.equal(destination(0, double('red')), 7);
  assert.equal(destination(1, single('red')), 7);
  assert.equal(destination(8, single('yellow')), 10, 'skips over the pink space');
});

test('with no matching space left, a color card reaches the rainbow', () => {
  const lastRed = SPACES.filter((s) => s.color === 'red').at(-1).index;
  assert.equal(destination(lastRed, single('red')), END);
  assert.equal(destination(lastRed - 1, double('red')), END);
});

test('picture cards move forward or backward to their space', () => {
  const game = createGame({ deck: [picture('lollipop'), single('red'), picture('candy-cane')] });
  assert.equal(game.takeTurn().to, pictureAt('lollipop'));
  game.takeTurn();
  const back = game.takeTurn();
  assert.equal(back.from, pictureAt('lollipop'));
  assert.equal(back.to, pictureAt('candy-cane'));
});

test('landing exactly on a shortcut takes it', () => {
  const game = createGame({ deck: [single('orange'), single('purple')] });
  const turn = game.takeTurn();
  assert.equal(turn.landed, 5);
  assert.equal(turn.shortcut.id, 'rainbow-trail');
  assert.equal(turn.to, 59);
  assert.equal(game.takeTurn().shortcut, null, 'passing a shortcut without landing on it does nothing');
});

test('licorice costs the next turn, then play continues', () => {
  // Player 1: red, red, red ... until they land on the licorice space.
  const stopBefore = LICORICE[0] - 1;
  const color = SPACES[LICORICE[0]].color;
  const game = createGame({ deck: [picture('gumdrop'), single('red'), single(color), single('red'), single('blue')] });
  game.takeTurn(); // p1 to the gumdrop (42)
  game.takeTurn(); // p2
  assert.ok(game.positions[0] < LICORICE[0] && game.positions[0] <= stopBefore);
  const stuck = game.takeTurn(); // p1 lands on licorice
  assert.equal(stuck.to, LICORICE[0]);
  assert.equal(stuck.licorice, true);
  game.takeTurn(); // p2
  const skipped = game.takeTurn(); // p1 loses this turn
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.to, LICORICE[0]);
  game.takeTurn(); // p2
  assert.equal(game.takeTurn().skipped, false);
});

test('turns rotate through 2 to 4 players', () => {
  assert.throws(() => createGame({ players: 1 }));
  assert.throws(() => createGame({ players: 5 }));
  const game = createGame({ players: 3, rng: mulberry32(2) });
  assert.deepEqual([0, 1, 2, 3].map(() => game.takeTurn().player), [0, 1, 2, 0]);
});

test('an empty deck is reshuffled from the discards', () => {
  const game = createGame({ deck: [single('red'), single('blue')], rng: mulberry32(5) });
  game.takeTurn();
  game.takeTurn();
  assert.equal(game.cardsLeft, 0);
  const turn = game.takeTurn();
  assert.equal(turn.reshuffled, true);
  assert.equal(game.cardsLeft, 1);
});

test('random games always end with one player on the rainbow', () => {
  for (let seed = 1; seed <= 3000; seed++) {
    const players = 2 + (seed % 3);
    const game = createGame({ players, rng: mulberry32(seed) });
    let turns = 0;
    while (game.winner === null) {
      const turn = game.takeTurn();
      assert.ok(turn.to >= 0 && turn.to <= END);
      assert.ok(++turns < 5000, `seed ${seed}: game did not finish`);
    }
    assert.equal(game.positions[game.winner], END);
    assert.equal(game.positions.filter((p) => p === END).length, 1);
    assert.throws(() => game.takeTurn());
  }
});
