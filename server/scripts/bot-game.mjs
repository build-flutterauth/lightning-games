// Plays Battleship games against a running server with scripted players and checks the rules,
// the waiting room, voting, reconnecting, and that nobody is sent another player's hidden ships.
// Usage: node scripts/bot-game.mjs [ws://127.0.0.1:8787]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const engine = require('../../battleship/battleship-engine.js');

const BASE = process.argv[2] || 'ws://127.0.0.1:8787';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Bot {
  constructor(code, name) {
    this.code = code;
    this.name = name;
    this.state = null;
    this.events = [];
    this.errors = [];
    this.seat = null;
    this.waiters = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${BASE}/battleship/rooms/${this.code}`);
      this.ws.onerror = reject;
      this.ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'state') {
          this.state = msg.state;
          this.events.push(...msg.events);
          if (!this.opened) {
            this.opened = true;
            resolve();
          }
        } else if (msg.type === 'seat') this.seat = { playerId: msg.playerId, token: msg.token };
        else if (msg.type === 'error') this.errors.push(msg.message);
        this.waiters = this.waiters.filter((w) => !w());
      };
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  waitFor(pred, label, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!pred(this)) return false;
        clearTimeout(timer);
        resolve();
        return true;
      };
      const timer = setTimeout(() => reject(new Error(`${this.name}: timed out waiting for ${label}`)), timeout);
      if (!check()) this.waiters.push(check);
    });
  }

  async expectError(msg, pattern) {
    const before = this.errors.length;
    this.send(msg);
    await this.waitFor((b) => b.errors.length > before, `error ${pattern}`);
    assert.match(this.errors.at(-1), pattern);
  }

  get me() {
    return this.state.players.find((p) => p.id === this.state.you);
  }

  targetable() {
    const s = this.state;
    const view = { size: s.size, shots: s.shots, ships: s.wrecks };
    const open = [];
    for (let y = 0; y < s.size; y++) for (let x = 0; x < s.size; x++) if (engine.isTargetable(view, x, y)) open.push([x, y]);
    return open;
  }
}

const all = (bots, pred, label, timeout) => Promise.all(bots.map((b) => b.waitFor(pred, label, timeout)));

async function lobbyAndPlacement(bots, watcher) {
  const [host, ...guests] = bots;
  for (const bot of bots) {
    await bot.connect();
    bot.send({ type: 'join', name: bot.name });
    await bot.waitFor((b) => b.seat && b.state.you === b.seat.playerId, 'a seat');
  }
  await watcher.connect();
  await watcher.waitFor((w) => w.state.players.length === bots.length, 'names in the waiting room');
  assert.deepEqual(watcher.state.players.map((p) => p.name), bots.map((b) => b.name), 'watchers see the waiting room fill up');
  assert.equal(watcher.state.you, null);
  assert.equal(host.state.host, host.seat.playerId);

  await guests[0].expectError({ type: 'start' }, /Only the host/);
  host.send({ type: 'start' });
  await all(bots, (b) => b.state.phase === 'placing', 'placing');
  const size = engine.boardSize(bots.length);
  assert.equal(host.state.size, size);
  const late = new Bot(host.code, 'Late');
  await late.connect();
  await late.expectError({ type: 'join', name: 'Late' }, /already started/);
  late.ws.close();

  await host.expectError({ type: 'place', ships: [] }, /Place all 5 ships/);
  const fleets = {};
  for (const bot of bots) {
    const ships = engine.randomFleet(size);
    fleets[bot.seat.playerId] = ships;
    bot.send({ type: 'place', ships });
  }
  return fleets;
}

async function gameWithVotes() {
  const code = newCode();
  const bots = ['Ava', 'Ben', 'Cy', 'Dee', 'Eli'].map((n) => new Bot(code, n));
  const watcher = new Bot(code, 'Watcher');
  const fleets = await lobbyAndPlacement(bots, watcher);

  await all(bots, (b) => b.state.phase === 'battle' || b.state.phase === 'over', 'the battle');
  const order = bots.map((b) => b.seat.playerId);
  const expected = engine.createMatch({ size: bots[0].state.size, fleets, order }).events[0].sunk;
  const announced = bots[0].events.find((e) => e.kind === 'collisions');
  assert.deepEqual(
    announced.sunk.map((s) => `${s.owner}:${s.ship}`).sort(),
    expected.map((s) => `${s.owner}:${s.ship}`).sort(),
    'the collision list matches the rules engine'
  );
  console.log(`  5 players: ${announced.sunk.length} ships sank in collisions; ${bots[0].state.players.filter((p) => p.out).length} out at the start`);

  // Nobody may see another player's ships unless they've sunk.
  for (const bot of bots) {
    assert.ok(bot.state.myShips.every((s) => s.owner === bot.seat.playerId));
    assert.ok(bot.state.wrecks.every((s) => s.sunk));
  }
  assert.equal(watcher.state.myShips, null);

  if (bots[0].state.phase === 'over') return console.log('  (game ended in the opening collisions)');

  const byId = (id) => bots.find((b) => b.seat.playerId === id);
  const current = () => byId(bots[0].state.turn);
  const voters = () => bots.filter((b) => b !== current() && !b.me.out);

  // Wrong player, then a real shot.
  const notMe = voters()[0];
  if (notMe) await notMe.expectError({ type: 'shoot', x: 0, y: 0 }, /not your turn/);
  const shooter = current();
  const [x, y] = shooter.targetable()[0];
  shooter.send({ type: 'shoot', x, y });
  await all(bots, (b) => b.state.shots.length === 1, 'the first shot');

  // Votes need 5 seconds; then a majority skips the player who's up.
  if (voters().length >= 1) {
    const stalled = current();
    await voters()[0].expectError({ type: 'vote', kind: 'skip' }, /seconds before a vote/);
    await sleep(engine.VOTE_DELAY_MS + 200);
    const needed = bots[0].state.votes.needed;
    voters().slice(0, needed).forEach((b) => b.send({ type: 'vote', kind: 'skip' }));
    await all(bots, (b) => b.events.some((e) => e.kind === 'skipped' && e.player === stalled.seat.playerId), 'the skip');
    assert.notEqual(bots[0].state.turn, stalled.seat.playerId);
    console.log(`  skip vote passed with ${needed} votes`);
  }

  // A refresh keeps your seat.
  const leaver = bots[1];
  leaver.ws.close();
  await bots[0].waitFor((b) => b.state.players.find((p) => p.id === leaver.seat.playerId)?.connected === false, 'offline status');
  const { seat } = leaver;
  Object.assign(leaver, { opened: false, state: null });
  await leaver.connect();
  leaver.send({ type: 'hello', ...seat });
  await leaver.waitFor((b) => b.state.you === seat.playerId, 'the same seat after reconnecting');
  await bots[0].waitFor((b) => b.state.players.find((p) => p.id === seat.playerId).connected, 'back online');
  console.log('  reconnecting kept the seat');

  // A page offering a seat the room doesn't know is told so (and stays a watcher).
  const stranger = new Bot(bots[0].code, 'Stranger');
  await stranger.connect();
  stranger.seat = { playerId: 'x' };
  stranger.send({ type: 'hello', playerId: seat.playerId, token: 'not-the-token' });
  await stranger.waitFor((b) => b.seat?.playerId === null, 'an unknown-seat answer');
  assert.equal(stranger.state.you, null);
  stranger.ws.close();
  console.log('  a wrong seat token is refused');

  // Banish whoever is up, if anyone else is still afloat to vote.
  if (bots[0].state.phase === 'battle' && voters().length >= 1) {
    const target = current();
    await sleep(engine.VOTE_DELAY_MS + 200);
    const needed = bots[0].state.votes.needed;
    voters().slice(0, needed).forEach((b) => b.send({ type: 'vote', kind: 'banish' }));
    await all(bots, (b) => b.events.some((e) => e.kind === 'banished' && e.player === target.seat.playerId), 'the banishment');
    assert.equal(bots[0].state.players.find((p) => p.id === target.seat.playerId).afloat, 0);
    console.log(`  banish vote passed with ${needed} votes`);
  }

  await playOut(bots);
  await finishAndRestart(bots);
}

async function playOut(bots) {
  let guard = 0;
  while (bots[0].state.phase === 'battle') {
    const shooter = bots.find((b) => b.seat.playerId === bots[0].state.turn);
    const shots = bots[0].state.shots.length;
    // Over a real network each socket hears about the last shot at its own pace; aim from an up-to-date view.
    await shooter.waitFor((b) => b.state.shots.length === shots && b.state.turn === b.seat.playerId, 'its own turn');
    const open = shooter.targetable();
    const [x, y] = open[Math.floor(Math.random() * open.length)];
    const errors = shooter.errors.length;
    shooter.send({ type: 'shoot', x, y });
    await bots[0].waitFor((b) => b.state.shots.length > shots, 'a shot', 15000);
    assert.equal(shooter.errors.length, errors, `shot refused: ${shooter.errors.at(-1)}`);
    assert.ok(++guard < 2000, 'game never ended');
  }
  await all(bots, (b) => b.state.phase === 'over', 'game over');
}

async function finishAndRestart(bots) {
  const { winner, players } = bots[0].state;
  bots.forEach((b) => assert.equal(b.state.winner, winner, 'everyone sees the same winner'));
  if (winner) {
    assert.ok(players.find((p) => p.id === winner).afloat > 0);
    assert.ok(players.filter((p) => p.id !== winner).every((p) => p.afloat === 0));
  }
  console.log(`  winner: ${winner ? players.find((p) => p.id === winner).name : 'nobody'} after ${bots[0].state.shots.length} shots`);

  await bots[1].expectError({ type: 'restart' }, /Only the host/);
  bots[0].send({ type: 'restart' });
  await all(bots, (b) => b.state.phase === 'lobby', 'back to the waiting room');
  assert.equal(bots[0].state.players.length, bots.length);
  bots.forEach((b) => b.ws.close());
}

async function bigGame(players) {
  const code = newCode();
  const bots = Array.from({ length: players }, (_, i) => new Bot(code, `P${i + 1}`));
  const watcher = new Bot(code, 'Watcher');
  await lobbyAndPlacement(bots, watcher);
  await all(bots, (b) => b.state.phase === 'battle' || b.state.phase === 'over', 'the battle', 10000);
  const sunk = bots[0].events.find((e) => e.kind === 'collisions').sunk.length;
  console.log(`  ${players} players on ${bots[0].state.size}×${bots[0].state.size}: ${sunk} of ${players * 5} ships sank in collisions`);
  await playOut(bots);
  await finishAndRestart(bots);
  watcher.ws.close();
}

async function fullRoom() {
  const code = newCode();
  const bots = Array.from({ length: 21 }, (_, i) => new Bot(code, `Q${i + 1}`));
  for (const bot of bots.slice(0, 20)) {
    await bot.connect();
    bot.send({ type: 'join', name: bot.name });
    await bot.waitFor((b) => b.seat, 'a seat');
  }
  await bots[20].connect();
  await bots[20].expectError({ type: 'join', name: 'Q21' }, /full/);
  bots.forEach((b) => b.ws.close());
  console.log('  the 21st player is turned away');
}

console.log('5-player game with votes and a reconnect');
await gameWithVotes();
console.log('20-player game');
await bigGame(20);
// The host picks the fleet in the waiting room; everyone then places exactly that fleet.
async function customFleetGame() {
  const code = newCode();
  const bots = ['Hana', 'Ivo', 'Jun'].map((n) => new Bot(code, n));
  for (const bot of bots) {
    await bot.connect();
    bot.send({ type: 'join', name: bot.name });
    await bot.waitFor((b) => b.seat, 'a seat');
  }
  const [host, guest] = bots;
  const counts = { carrier: 0, battleship: 0, cruiser: 1, submarine: 0, destroyer: 3 };
  await guest.expectError({ type: 'fleet', counts }, /Only the host/);
  await host.expectError({ type: 'fleet', counts: { destroyer: 9 } }, /0 to 4/);

  const huge = { carrier: 4, battleship: 4, cruiser: 4, submarine: 4, destroyer: 4 };
  host.send({ type: 'fleet', counts: huge });
  await all(bots, (b) => b.state.fleet.carrier === 4, 'the huge fleet');
  await host.expectError({ type: 'start' }, /too many for a 10×10 sea/);

  host.send({ type: 'fleet', counts });
  await all(bots, (b) => b.state.fleet.destroyer === 3 && b.state.fleet.carrier === 0, 'the custom fleet');
  host.send({ type: 'start' });
  await all(bots, (b) => b.state.phase === 'placing', 'placing');

  const fleet = engine.fleetFromCounts(counts);
  await guest.expectError({ type: 'place', ships: engine.randomFleet(10) }, /Place all 4 ships/);
  bots.forEach((b) => b.send({ type: 'place', ships: engine.randomFleet(10, Math.random, fleet) }));
  await all(bots, (b) => b.state.phase === 'battle' || b.state.phase === 'over', 'the battle');
  assert.ok(bots.every((b) => !b.state.myShips || b.state.myShips.length === 4));
  const sunk = bots[0].events.find((e) => e.kind === 'collisions').sunk;
  console.log(`  cruiser + 3 destroyers each: ${sunk.length} sank in collisions (${sunk.map((s) => s.name).join(', ') || 'none'})`);
  await playOut(bots);
  await finishAndRestart(bots);
  assert.equal(bots[0].state.fleet.destroyer, 3, 'the fleet choice survives play again');
}

console.log('Custom fleet');
await customFleetGame();
console.log('Room limit');
await fullRoom();
console.log('All server checks passed');
process.exit(0);
