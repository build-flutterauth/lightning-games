/*
 * Candy Land board geometry, no DOM. Lays the path out as a rounded-rectangle spiral
 * that fills whatever box it gets (landscape or portrait) and leaves a clearing in the
 * middle for the card display. Loads in the browser (window.CandyLandBoard) and in Node.
 */
(function (root) {
  'use strict';

  const RING_GAP = 1.42; // distance between neighbouring rings, in tile pitches
  const MARGIN = 0.78;   // box edge to path centerline, in tile pitches

  // Corner points of the spiral, outermost ring first, for tile pitch `s`.
  function spiralCorners(w, h, s, clear) {
    const g = s * RING_GAP;
    const m = s * MARGIN;
    const ring = (k) => ({ x0: m + k * g, x1: w - m - k * g, y0: m + k * g, y1: h - m - k * g });
    // A ring is kept only while the space inside it still fits the clearing.
    const fits = (r) => r.x1 - r.x0 - 1.6 * s >= clear.w && r.y1 - r.y0 - 1.6 * s >= clear.h;

    let k = 0;
    let r = ring(0);
    if (!fits(r)) return null;
    const pts = [[r.x0, r.y1]];
    for (;;) {
      pts.push([r.x1, r.y1], [r.x1, r.y0], [r.x0, r.y0]);
      const next = ring(k + 1);
      if (!fits(next)) return { pts, inner: r };
      pts.push([r.x0, next.y1]);
      k++;
      r = next;
    }
  }

  // Round each corner with an arc and flatten everything into short segments.
  function roundedPolyline(pts, radius) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const [px, py] = pts[i - 1];
      const [cx, cy] = pts[i];
      const [nx, ny] = pts[i + 1];
      const inLen = Math.hypot(cx - px, cy - py);
      const outLen = Math.hypot(nx - cx, ny - cy);
      const r = Math.min(radius, inLen / 2, outLen / 2);
      const a = [cx - ((cx - px) / inLen) * r, cy - ((cy - py) / inLen) * r];
      const b = [cx + ((nx - cx) / outLen) * r, cy + ((ny - cy) / outLen) * r];
      // Quadratic curve through the corner, close enough to an arc at these sizes.
      for (let t = 0; t <= 1; t += 1 / 10) {
        const u = 1 - t;
        out.push([u * u * a[0] + 2 * u * t * cx + t * t * b[0], u * u * a[1] + 2 * u * t * cy + t * t * b[1]]);
      }
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  function measure(points) {
    const lengths = [0];
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1];
      const [bx, by] = points[i];
      lengths.push(lengths[i - 1] + Math.hypot(bx - ax, by - ay));
    }
    return lengths;
  }

  function buildPath(w, h, s, clear) {
    const spiral = spiralCorners(w, h, s, clear);
    if (!spiral) return null;
    const points = roundedPolyline(spiral.pts, s * RING_GAP * 0.5);
    return { points, lengths: measure(points), inner: spiral.inner };
  }

  /*
   * Lay out `count` tiles (Start through the rainbow) in a w×h box.
   * Returns tile centers and angles, the road outline, the clearing rect, and pointAt(d)
   * for moving pawns along the road (d in pixels from the Start tile).
   */
  function layoutBoard(w, h, count) {
    const clear = {
      w: Math.min(Math.max(w * 0.26, 150), 340),
      h: Math.min(Math.max(h * 0.24, 150), 280),
    };
    const need = (s, path) => path && path.lengths[path.lengths.length - 1] >= (count - 1) * s;

    // The biggest tile pitch whose spiral is still long enough for every tile.
    let lo = 6;
    let hi = Math.min(w, h) / 3;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (need(mid, buildPath(w, h, mid, clear))) lo = mid;
      else hi = mid;
    }
    const s = lo;
    const path = buildPath(w, h, s, clear);
    const { points, lengths } = path;

    function pointAt(d) {
      const total = lengths[lengths.length - 1];
      d = Math.max(0, Math.min(d, total));
      let a = 0;
      let b = lengths.length - 1;
      while (b - a > 1) {
        const mid = (a + b) >> 1;
        if (lengths[mid] <= d) a = mid;
        else b = mid;
      }
      const span = lengths[b] - lengths[a] || 1;
      const t = (d - lengths[a]) / span;
      const [ax, ay] = points[a];
      const [bx, by] = points[b];
      return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, angle: (Math.atan2(by - ay, bx - ax) * 180) / Math.PI };
    }

    const tiles = [];
    for (let i = 0; i < count; i++) tiles.push(pointAt(i * s));

    // The road stops at the last tile.
    const end = (count - 1) * s;
    const road = [];
    for (let i = 0; i < points.length && lengths[i] < end; i++) road.push(points[i]);
    const last = tiles[count - 1];
    road.push([last.x, last.y]);

    const inner = path.inner;
    const pad = s * 0.85;
    const clearing = { x: inner.x0 + pad, y: inner.y0 + pad, w: inner.x1 - inner.x0 - 2 * pad, h: inner.y1 - inner.y0 - 2 * pad };

    return { width: w, height: h, pitch: s, tiles, road, clearing, pointAt };
  }

  const api = { layoutBoard };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CandyLandBoard = api;
})(typeof window !== 'undefined' ? window : globalThis);
