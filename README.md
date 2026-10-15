# Lightning Games

Auto-play web games. Name the players, pick a speed, and watch it go.

**Play:** https://build-flutterauth.github.io/lightning-games/

- **War**: two players, one deck, high card wins, ties mean war.
- **Candy Land**: 2–4 players race along the color path to the Candy Castle.
- **Battleship**: live multiplayer for 2–20 players on one shared sea. Start a game, send the link, place your fleet blind; overlapping ships sink, then everyone takes turns firing.

The auto-play games run at Normal (2 s per turn), Fast (750 ms) or Insane (250 ms; War's Insane is 100 ms).

## Run locally

Plain HTML, CSS and JavaScript with no build step. Open `index.html`, or serve the folder:

```bash
npm start   # http://localhost:5173
npm test    # game rule tests (Node 18+)
```

Each game lives in its own folder with a DOM-free rules engine (`*-engine.js`) and tests in `tests/`. Shared styles and helpers are in `shared/`.

## Battleship server

Battleship rooms run on a Cloudflare Worker with one Durable Object per room (`server/`). The room is the only place that knows where every ship is; it runs the same rules engine as the page.

```bash
cd server
npm install
npm run dev                      # local server on ws://127.0.0.1:8787 (used by pages on localhost)
node scripts/bot-game.mjs        # plays scripted games against it
npm run deploy                   # needs `npx wrangler login` once
```
