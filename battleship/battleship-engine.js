/*
 * Battleship for up to 20 players on one shared sea — rules only, no DOM or network.
 * Loads as a classic script in the browser (window.BattleshipEngine) and as a CommonJS
 * module in Node and in the Cloudflare Worker, which runs the authoritative copy.
 *
 * A match is plain JSON-safe data, so the server can store it between messages.
 */
(function (root) {
  'use strict';

  const SHIP_TYPES = [
    { type: 'carrier', name: 'Carrier', size: 5 },
    { type: 'battleship', name: 'Battleship', size: 4 },
    { type: 'cruiser', name: 'Cruiser', size: 3 },
    { type: 'submarine', name: 'Submarine', size: 3 },
    { type: 'destroyer', name: 'Destroyer', size: 2 },
  ];
  // The host picks how many of each type every player gets; this is the classic fleet.
  const DEFAULT_COUNTS = { carrier: 1, battleship: 1, cruiser: 1, submarine: 1, destroyer: 1 };
  const MAX_PER_TYPE = 4;
  const MIN_PLAYERS = 2;
  const MAX_PLAYERS = 20;
  const VOTE_DELAY_MS = 20000; // each player gets this long before others may vote to skip or banish them

  // 2–4 players share a 10×10 sea; from 5 players on, each extra player adds a row and a column.
  function boardSize(players) {
    return players <= 4 ? 10 : players + 6;
  }

  function shipCells({ x, y, dir, size }) {
    const cells = [];
    for (let i = 0; i < size; i++) cells.push(dir === 'h' ? [x + i, y] : [x, y + i]);
    return cells;
  }

  const covers = (ship, x, y) =>
    ship.dir === 'h' ? y === ship.y && x >= ship.x && x < ship.x + ship.size : x === ship.x && y >= ship.y && y < ship.y + ship.size;

  // Check a host's fleet choice; returns clean counts or throws a message for the host.
  function validateCounts(counts) {
    const clean = {};
    SHIP_TYPES.forEach(({ type }) => {
      const n = counts == null ? 0 : counts[type] ?? 0;
      if (!Number.isInteger(n) || n < 0 || n > MAX_PER_TYPE) throw new Error(`Pick 0 to ${MAX_PER_TYPE} of each ship`);
      clean[type] = n;
    });
    if (!Object.values(clean).some((n) => n > 0)) throw new Error('Every fleet needs at least one ship');
    return clean;
  }

  // Counts → the ships each player places, e.g. two destroyers become "Destroyer 1" and "Destroyer 2".
  function fleetFromCounts(counts = DEFAULT_COUNTS) {
    return SHIP_TYPES.flatMap(({ type, name, size }) => {
      const n = counts[type] || 0;
      return Array.from({ length: n }, (_, i) =>
        n === 1 ? { id: type, type, name, size } : { id: `${type}-${i + 1}`, type, name: `${name} ${i + 1}`, size }
      );
    });
  }

  const FLEET = fleetFromCounts(DEFAULT_COUNTS);
  const fleetSquares = (fleet) => fleet.reduce((sum, ship) => sum + ship.size, 0);
  // A fleet may cover at most half the sea, so there's always room to place it.
  const fleetFits = (fleet, size) => fleetSquares(fleet) <= Math.floor((size * size) / 2);

  // A player's placement: exactly the fleet, on the board, not overlapping itself.
  // Returns clean ship objects, or throws with a message suitable for the player.
  function validateFleet(ships, size, fleet = FLEET) {
    if (!Array.isArray(ships) || ships.length !== fleet.length) throw new Error(`Place all ${fleet.length} ships`);
    const taken = new Set();
    return fleet.map((spec) => {
      const ship = ships.find((s) => s && s.id === spec.id);
      if (!ship) throw new Error(`Place your ${spec.name}`);
      const { x, y, dir } = ship;
      if (!Number.isInteger(x) || !Number.isInteger(y) || (dir !== 'h' && dir !== 'v')) {
        throw new Error(`Your ${spec.name} is not on the board`);
      }
      const clean = { id: spec.id, name: spec.name, x, y, dir, size: spec.size };
      for (const [cx, cy] of shipCells(clean)) {
        if (cx < 0 || cy < 0 || cx >= size || cy >= size) throw new Error(`Your ${spec.name} hangs off the board`);
        const key = cy * size + cx;
        if (taken.has(key)) throw new Error('Your own ships cannot overlap');
        taken.add(key);
      }
      return clean;
    });
  }

  function randomFleet(size, rng = Math.random, fleet = FLEET) {
    for (;;) {
      const ships = [];
      const taken = new Set();
      let ok = true;
      for (const spec of fleet) {
        let placed = false;
        for (let attempt = 0; attempt < 200 && !placed; attempt++) {
          const dir = rng() < 0.5 ? 'h' : 'v';
          const x = Math.floor(rng() * (dir === 'h' ? size - spec.size + 1 : size));
          const y = Math.floor(rng() * (dir === 'v' ? size - spec.size + 1 : size));
          const ship = { id: spec.id, name: spec.name, x, y, dir, size: spec.size };
          const keys = shipCells(ship).map(([cx, cy]) => cy * size + cx);
          if (keys.some((k) => taken.has(k))) continue;
          keys.forEach((k) => taken.add(k));
          ships.push(ship);
          placed = true;
        }
        if (!placed) ok = false;
      }
      if (ok) return ships;
    }
  }

  // Rooms saved before custom fleets stored no names; their ids are the plain type names.
  const shipName = (ship) => ship.name || SHIP_TYPES.find((t) => t.type === ship.id)?.name || 'Ship';
  const sunkRecord = (ship) => ({ owner: ship.owner, ship: ship.id, name: shipName(ship) });

  /*
   * Start the battle once every fleet is placed. Ships of different players that share
   * a square all sink on the spot. `order` is the turn order (player ids).
   * Returns the match and the opening events (collisions, players knocked out, a winner).
   */
  function createMatch({ size, fleets, order, now = 0 }) {
    const ships = [];
    for (const owner of order) {
      for (const ship of fleets[owner]) {
        ships.push({
          owner, id: ship.id, name: shipName(ship), x: ship.x, y: ship.y, dir: ship.dir, size: ship.size, hits: 0, sunk: null,
        });
      }
    }

    const owners = new Map(); // square → set of owners with a ship there
    ships.forEach((ship) => {
      for (const [x, y] of shipCells(ship)) {
        const key = y * size + x;
        if (!owners.has(key)) owners.set(key, new Set());
        owners.get(key).add(ship.owner);
      }
    });
    const collided = ships.filter((ship) =>
      shipCells(ship).some(([x, y]) => owners.get(y * size + x).size > 1)
    );
    collided.forEach((ship) => { ship.sunk = { by: null, cause: 'collision' }; });

    const match = {
      size,
      order: order.slice(),
      ships,
      shots: [],
      out: [],
      banished: [],
      turn: null,
      turnStartedAt: now,
      turnNumber: 0,
      over: false,
      winner: null,
    };
    const events = [{ kind: 'collisions', sunk: collided.map(sunkRecord) }];
    const knockedOut = updateOuts(match);
    if (knockedOut.length) events.push({ kind: 'out', players: knockedOut, cause: 'collision' });
    if (!finishIfDecided(match, events)) {
      match.turn = alivePlayers(match)[0];
      match.turnNumber = 1;
    }
    return { match, events };
  }

  function alivePlayers(match) {
    return match.order.filter((id) => !match.out.includes(id));
  }

  // Mark anyone whose ships are all gone as out; returns the newly out players.
  function updateOuts(match) {
    const newlyOut = match.order.filter(
      (id) => !match.out.includes(id) && match.ships.every((s) => s.owner !== id || s.sunk)
    );
    match.out.push(...newlyOut);
    return newlyOut;
  }

  function finishIfDecided(match, events) {
    const alive = alivePlayers(match);
    if (alive.length > 1) return false;
    match.over = true;
    match.winner = alive[0] || null;
    match.turn = null;
    events.push({ kind: 'over', winner: match.winner });
    return true;
  }

  function nextTurn(match, now) {
    const alive = alivePlayers(match);
    const from = match.order.indexOf(match.turn);
    for (let step = 1; step <= match.order.length; step++) {
      const id = match.order[(from + step) % match.order.length];
      if (alive.includes(id)) {
        match.turn = id;
        break;
      }
    }
    match.turnStartedAt = now;
    match.turnNumber++;
  }

  // Squares nobody may shoot: already shot, or part of a revealed wreck.
  function isTargetable(match, x, y) {
    if (x < 0 || y < 0 || x >= match.size || y >= match.size) return false;
    if (match.shots.some((s) => s.x === x && s.y === y)) return false;
    return !match.ships.some((s) => s.sunk && covers(s, x, y));
  }

  function shoot(match, by, x, y, now = 0) {
    if (match.over) throw new Error('The game is over');
    if (match.turn !== by) throw new Error("It's not your turn");
    if (!Number.isInteger(x) || !Number.isInteger(y) || !isTargetable(match, x, y)) {
      throw new Error('Pick a square nobody has shot yet');
    }
    // Overlaps sank at the start, so at most one live ship can be here.
    const ship = match.ships.find((s) => !s.sunk && covers(s, x, y)) || null;
    const shot = { x, y, by, hit: !!ship };
    match.shots.push(shot);
    const event = { kind: 'shot', x, y, by, hit: !!ship, sunk: null };
    if (ship) {
      ship.hits++;
      if (ship.hits === ship.size) {
        ship.sunk = { by, cause: 'shot' };
        event.sunk = sunkRecord(ship);
      }
    }
    const events = [event];
    const knockedOut = updateOuts(match);
    if (knockedOut.length) events.push({ kind: 'out', players: knockedOut, cause: 'shot', by });
    if (!finishIfDecided(match, events)) nextTurn(match, now);
    return events;
  }

  function skip(match, now = 0) {
    const events = [{ kind: 'skipped', player: match.turn }];
    nextTurn(match, now);
    return events;
  }

  // Banished players' fleets sink and they're out; play moves on if it was their turn.
  function banish(match, id, now = 0) {
    if (match.out.includes(id)) return [];
    match.ships.forEach((s) => {
      if (s.owner === id && !s.sunk) s.sunk = { by: null, cause: 'banished' };
    });
    match.banished.push(id);
    const events = [{ kind: 'banished', player: id }];
    const wasTurn = match.turn === id;
    updateOuts(match);
    if (!finishIfDecided(match, events) && wasTurn) nextTurn(match, now);
    return events;
  }

  // Votes needed to skip or banish whoever's turn it is: a majority of the other live players.
  function votesNeeded(match) {
    const voters = alivePlayers(match).filter((id) => id !== match.turn).length;
    return Math.floor(voters / 2) + 1;
  }

  const api = {
    SHIP_TYPES, DEFAULT_COUNTS, MAX_PER_TYPE, FLEET, MIN_PLAYERS, MAX_PLAYERS, VOTE_DELAY_MS,
    boardSize, shipCells, covers, validateCounts, fleetFromCounts, fleetSquares, fleetFits, validateFleet, randomFleet,
    createMatch, alivePlayers, isTargetable, shoot, skip, banish, votesNeeded,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BattleshipEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
