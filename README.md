# Lightning Games

Auto-play web games. Name the players, pick a speed, and watch it go.

**Play:** https://build-flutterauth.github.io/lightning-games/

- **War**: two players, one deck, high card wins, ties mean war.
- **Candy Land**: 2–4 players race along the color path to the Candy Castle.

Every game runs at Normal (2 s per turn), Fast (750 ms) or Insane (250 ms).

## Run locally

Plain HTML, CSS and JavaScript with no build step. Open `index.html`, or serve the folder:

```bash
npm start   # http://localhost:5173
npm test    # game rule tests (Node 18+)
```

Each game lives in its own folder with a DOM-free rules engine (`*-engine.js`) and tests in `tests/`. Shared styles and helpers are in `shared/`.
