/*
 * Lightning Games realtime server: a Cloudflare Worker that routes each Battleship room
 * to its own Durable Object. The room is the authority: it alone sees every fleet,
 * checks every move with the shared rules engine, and sends each player only what
 * they're allowed to see.
 *
 *   wss://<worker>/battleship/rooms/<CODE>   one WebSocket per browser tab
 */
import { DurableObject } from 'cloudflare:workers';
import engine from '../../battleship/battleship-engine.js';

const {
  MIN_PLAYERS, MAX_PLAYERS, VOTE_DELAY_MS,
  boardSize, validateFleet, createMatch, alivePlayers, shoot, skip, banish, votesNeeded,
} = engine;

const ROOM_PATH = /^\/battleship\/rooms\/([A-Za-z0-9]{6})$/;
const IDLE_MS = 24 * 60 * 60 * 1000; // rooms forget everything after a quiet day

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(ROOM_PATH);
    if (!match) return new Response('Lightning Games server', { status: 200 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    if (!originAllowed(request.headers.get('Origin'), env)) return new Response('Forbidden', { status: 403 });
    const room = env.BATTLESHIP.get(env.BATTLESHIP.idFromName(match[1].toUpperCase()));
    return room.fetch(request);
  },
};

function originAllowed(origin, env) {
  if (!origin) return true; // non-browser clients (tests, tools)
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return (env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).includes(origin);
}

class PlayerError extends Error {}
const fail = (message) => { throw new PlayerError(message); };

function cleanName(raw) {
  const name = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return name || fail('Enter a name');
}

const randomId = (length) => {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
};

export class BattleshipRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get('room')) || {
        phase: 'lobby',     // lobby → placing → battle → over → (play again) lobby
        players: [],        // { id, token, name, color, ready, ships }
        creator: null,
        size: 10,
        match: null,
        votes: {},          // voter id → 'skip' | 'banish', for the current turn
        lastActive: Date.now(),
      };
    });
  }

  async fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ playerId: null });
    server.send(JSON.stringify({ type: 'state', state: this.view(null), events: [] }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 10000) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const { playerId } = ws.deserializeAttachment() || {};
    const me = this.room.players.find((p) => p.id === playerId) || null;
    let events;
    try {
      events = this.handle(ws, me, msg) || [];
    } catch (err) {
      // Rule violations (ours, or plain Errors from the engine) go back to the player; bugs get logged.
      const forPlayer = err instanceof PlayerError || err.constructor === Error;
      if (!forPlayer) console.error(err);
      ws.send(JSON.stringify({ type: 'error', message: forPlayer ? err.message : 'Something went wrong' }));
      return;
    }
    this.room.lastActive = Date.now();
    await this.ctx.storage.put('room', this.room);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
    this.broadcast(events);
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, 'Closing'); } catch { /* already closed */ }
    this.broadcast([], ws);
  }

  async webSocketError(ws) {
    this.broadcast([], ws);
  }

  async alarm() {
    if (Date.now() - this.room.lastActive < IDLE_MS) {
      await this.ctx.storage.setAlarm(this.room.lastActive + IDLE_MS);
      return;
    }
    this.ctx.getWebSockets().forEach((ws) => ws.close(1000, 'Room closed'));
    await this.ctx.storage.deleteAll();
  }

  /* ---------- Moves ---------- */

  handle(ws, me, msg) {
    const room = this.room;
    const now = Date.now();
    const need = (cond, message) => { if (!cond) fail(message); };

    switch (msg.type) {
      case 'hello': {
        // Re-attach a returning player (refresh, dropped connection) by their secret token.
        const player = room.players.find((p) => p.id === msg.playerId && p.token === msg.token);
        ws.serializeAttachment({ playerId: player ? player.id : null });
        if (player) ws.send(JSON.stringify({ type: 'seat', playerId: player.id, token: player.token }));
        return [];
      }

      case 'join': {
        need(!me, "You're already in this game");
        need(room.phase === 'lobby', 'This game has already started');
        need(room.players.length < MAX_PLAYERS, `This game is full (${MAX_PLAYERS} players)`);
        let name = cleanName(msg.name);
        const taken = (n) => room.players.some((p) => p.name.toLowerCase() === n.toLowerCase());
        for (let i = 2; taken(name); i++) name = `${cleanName(msg.name).slice(0, 16)} (${i})`;
        const used = new Set(room.players.map((p) => p.color));
        const player = {
          id: randomId(8),
          token: crypto.randomUUID(),
          name,
          color: [...Array(MAX_PLAYERS).keys()].find((c) => !used.has(c)),
          ready: false,
          ships: null,
        };
        room.players.push(player);
        if (!room.creator) room.creator = player.id;
        ws.serializeAttachment({ playerId: player.id });
        ws.send(JSON.stringify({ type: 'seat', playerId: player.id, token: player.token }));
        return [];
      }

      case 'leave': {
        need(me && room.phase === 'lobby', 'You can only leave from the waiting room');
        room.players = room.players.filter((p) => p !== me);
        if (room.creator === me.id) room.creator = room.players[0]?.id || null;
        ws.serializeAttachment({ playerId: null });
        return [];
      }

      case 'start': {
        need(room.phase === 'lobby', 'The game has already started');
        need(me && me.id === this.hostId(), 'Only the host can start the game');
        const online = this.connectedIds();
        room.players = room.players.filter((p) => online.has(p.id));
        need(room.players.length >= MIN_PLAYERS, `You need at least ${MIN_PLAYERS} players`);
        room.phase = 'placing';
        room.size = boardSize(room.players.length);
        room.players.forEach((p) => { p.ready = false; p.ships = null; });
        return [{ kind: 'started', size: room.size }];
      }

      case 'place': {
        need(me && room.phase === 'placing', 'Ships can only be placed before the battle');
        me.ships = validateFleet(msg.ships, room.size);
        me.ready = true;
        return this.beginBattleIfReady();
      }

      case 'unready': {
        need(me && room.phase === 'placing', 'The battle has already begun');
        me.ready = false;
        return [];
      }

      case 'remove': {
        // The host can drop someone who vanished, so the rest aren't stuck waiting.
        need(me && me.id === this.hostId(), 'Only the host can remove players');
        need(room.phase === 'lobby' || room.phase === 'placing', 'Use a vote to remove players during the battle');
        const target = room.players.find((p) => p.id === msg.playerId);
        need(target && target !== me, 'That player is not here');
        need(room.phase === 'lobby' || !this.connectedIds().has(target.id), 'You can only remove players who are offline');
        room.players = room.players.filter((p) => p !== target);
        if (room.phase === 'placing' && room.players.length < MIN_PLAYERS) room.phase = 'lobby';
        return [{ kind: 'removed', name: target.name }, ...(room.phase === 'placing' ? this.beginBattleIfReady() : [])];
      }

      case 'shoot': {
        need(me && room.phase === 'battle', 'There is no battle right now');
        const events = shoot(room.match, me.id, msg.x, msg.y, now);
        room.votes = {};
        if (room.match.over) room.phase = 'over';
        return events;
      }

      case 'vote': {
        const match = room.match;
        need(me && room.phase === 'battle', 'There is no battle right now');
        need(msg.kind === 'skip' || msg.kind === 'banish', 'Vote to skip or to banish');
        need(alivePlayers(match).includes(me.id), 'Only players still afloat can vote');
        need(match.turn !== me.id, "You can't vote on your own turn");
        need(now - match.turnStartedAt >= VOTE_DELAY_MS, `Each player gets ${VOTE_DELAY_MS / 1000} seconds before a vote`);
        if (room.votes[me.id] === msg.kind) delete room.votes[me.id];
        else room.votes[me.id] = msg.kind;

        const tally = this.tally();
        let events = [];
        if (tally.banish >= tally.needed) events = banish(match, match.turn, now);
        else if (tally.skip >= tally.needed) events = skip(match, now);
        if (events.length) room.votes = {};
        if (match.over) room.phase = 'over';
        return events;
      }

      case 'restart': {
        need(room.phase === 'over', 'The game is still going');
        need(me && me.id === this.hostId(), 'Only the host can start another game');
        const online = this.connectedIds();
        room.players = room.players.filter((p) => online.has(p.id));
        room.players.forEach((p) => { p.ready = false; p.ships = null; });
        room.phase = 'lobby';
        room.match = null;
        room.votes = {};
        return [{ kind: 'restarted' }];
      }

      default:
        return [];
    }
  }

  beginBattleIfReady() {
    const room = this.room;
    if (room.players.length < MIN_PLAYERS || !room.players.every((p) => p.ready)) return [];
    const order = room.players.map((p) => p.id);
    const fleets = Object.fromEntries(room.players.map((p) => [p.id, p.ships]));
    const { match, events } = createMatch({ size: room.size, fleets, order, now: Date.now() });
    room.match = match;
    room.votes = {};
    room.phase = match.over ? 'over' : 'battle';
    return events;
  }

  // Votes from players who can still vote this turn.
  tally() {
    const match = this.room.match;
    const voters = alivePlayers(match).filter((id) => id !== match.turn);
    const counts = { skip: 0, banish: 0, needed: votesNeeded(match) };
    voters.forEach((id) => {
      const vote = this.room.votes[id];
      if (vote) counts[vote]++;
    });
    return counts;
  }

  /* ---------- Who's here, and what each of them may see ---------- */

  sockets(exclude) {
    return this.ctx.getWebSockets().filter((ws) => ws !== exclude && ws.readyState === WebSocket.OPEN);
  }

  connectedIds(exclude) {
    return new Set(this.sockets(exclude).map((ws) => ws.deserializeAttachment()?.playerId).filter(Boolean));
  }

  // The creator hosts while they're connected; otherwise the earliest-joined player who is.
  hostId(exclude) {
    const online = this.connectedIds(exclude);
    if (online.has(this.room.creator)) return this.room.creator;
    return this.room.players.find((p) => online.has(p.id))?.id || this.room.creator;
  }

  view(playerId, exclude) {
    const room = this.room;
    const m = room.match;
    const online = this.connectedIds(exclude);
    const me = room.players.find((p) => p.id === playerId) || null;
    const tally = room.phase === 'battle' ? this.tally() : null;
    return {
      phase: room.phase,
      you: me ? me.id : null,
      host: this.hostId(exclude),
      size: room.phase === 'lobby' ? boardSize(Math.max(MIN_PLAYERS, room.players.length)) : room.size,
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        connected: online.has(p.id),
        ready: p.ready,
        out: m ? m.out.includes(p.id) : false,
        banished: m ? m.banished.includes(p.id) : false,
        afloat: m ? m.ships.filter((s) => s.owner === p.id && !s.sunk).length : null,
      })),
      myShips: m && me ? m.ships.filter((s) => s.owner === me.id) : me?.ships || null,
      wrecks: m ? m.ships.filter((s) => s.sunk) : [],
      shots: m ? m.shots : [],
      turn: m?.turn ?? null,
      turnStartedAt: m?.turnStartedAt ?? null,
      turnNumber: m?.turnNumber ?? 0,
      votes: tally && { skip: tally.skip, banish: tally.banish, needed: tally.needed, mine: room.votes[playerId] || null },
      winner: m?.winner ?? null,
      now: Date.now(),
    };
  }

  broadcast(events, exclude) {
    for (const ws of this.sockets(exclude)) {
      const { playerId } = ws.deserializeAttachment() || {};
      try {
        ws.send(JSON.stringify({ type: 'state', state: this.view(playerId, exclude), events }));
      } catch {
        /* socket went away mid-broadcast */
      }
    }
  }
}
