/* Lightning Games — helpers shared by every game. */
window.Lightning = (function () {
  'use strict';

  const PREFIX = 'lightning:';

  // Every game auto-plays at one of these paces; `ms` is the time between turns.
  const SPEEDS = {
    normal: { label: 'Normal', ms: 2000, bolts: 1 },
    fast: { label: 'Fast', ms: 750, bolts: 2 },
    insane: { label: 'Insane', ms: 250, bolts: 3 },
  };

  const BOLT_SVG =
    '<svg class="bolt" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>';

  // localStorage can be missing or throw (private mode, blocked storage); the games still work without it.
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(PREFIX + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(PREFIX + key, JSON.stringify(value));
      } catch {
        /* not saved; nothing else to do */
      }
    },
  };

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /*
   * The big speed buttons. `describe(key)` gives the game's own wording: { blurb, eta }.
   * Returns refresh(), which rewrites the wording (e.g. when the player count changes).
   */
  function speedOptions(container, describe, onPick) {
    const buttons = Object.entries(SPEEDS).map(([key, speed]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'speed-option';
      button.dataset.speed = key;
      button.addEventListener('click', () => onPick(key));
      container.append(button);
      return { key, speed, button };
    });
    function refresh() {
      buttons.forEach(({ key, speed, button }) => {
        const { blurb, eta } = describe(key);
        button.innerHTML =
          `<span class="bolts">${BOLT_SVG.repeat(speed.bolts)}</span>` +
          `<span><span class="label">${speed.label}</span><span class="sub">${blurb}</span></span>` +
          `<span class="eta">${eta}</span>`;
      });
    }
    refresh();
    return refresh;
  }

  // The compact switch for changing speed mid-game. Returns set(key) to show the current speed.
  function speedSwitch(container, onChange) {
    Object.entries(SPEEDS).forEach(([key, speed]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.speed = key;
      button.textContent = speed.label;
      button.addEventListener('click', () => onChange(key));
      container.append(button);
    });
    return function set(key) {
      container.querySelectorAll('button').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.speed === key));
      });
    };
  }

  function formatClock(ms) {
    const seconds = Math.round(ms / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  return {
    SPEEDS,
    BOLT_SVG,
    store,
    speedOptions,
    speedSwitch,
    formatClock,
    prefersReducedMotion: () => reducedMotion.matches,
  };
})();
