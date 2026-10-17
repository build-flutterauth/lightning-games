/*
 * Battleship sound effects, synthesized with the Web Audio API so there are no audio files
 * to load. Each effect draws into any AudioContext (live, or offline for checking how it
 * sounds) starting at time `t`, and sends its output to `out`.
 */
window.BattleshipSounds = (function () {
  'use strict';

  const noiseBuffers = new WeakMap();
  // A couple of seconds of white noise per context, shared by every effect that needs it.
  function noiseBuffer(c) {
    if (!noiseBuffers.has(c)) {
      const buffer = c.createBuffer(1, c.sampleRate * 3, c.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      noiseBuffers.set(c, buffer);
    }
    return noiseBuffers.get(c);
  }

  function noise(c, out, t, { duration, from, to, gain, type = 'lowpass', q = 1 }) {
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c);
    const filter = c.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.exponentialRampToValueAtTime(to, t + duration);
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filter).connect(g).connect(out);
    src.start(t);
    src.stop(t + duration);
  }

  function tone(c, out, t, { freq, duration, gain }) {
    const osc = c.createOscillator();
    osc.frequency.setValueAtTime(freq, t);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  // A soft-clipping curve, for the rasp in a scream.
  function drive(amount) {
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(amount * x) / Math.tanh(amount);
    }
    return curve;
  }

  function boom(c, out, t, huge = false) {
    noise(c, out, t, { duration: huge ? 2.2 : 1.3, from: 1400, to: 50, gain: huge ? 1 : 0.7 });
    tone(c, out, t, { freq: 48, duration: huge ? 1.2 : 0.7, gain: 0.5 });
  }

  function splash(c, out, t) {
    noise(c, out, t, { duration: 0.3, from: 3500, to: 700, gain: 0.2 });
  }

  function ping(c, out, t) {
    tone(c, out, t, { freq: 880, duration: 0.18, gain: 0.15 });
    tone(c, out, t + 0.12, { freq: 1320, duration: 0.25, gain: 0.12 });
  }

  function fanfare(c, out, t) {
    [523, 659, 784, 1047].forEach((freq, i) => tone(c, out, t + i * 0.13, { freq, duration: 0.3, gain: 0.14 }));
  }

  /*
   * A ship is hit: a fart. A low buzz whose pitch sags, flapping open and shut ~30 times a
   * second, muffled, with a breathy edge, and a little different every time.
   */
  function fart(c, out, t, rnd = Math.random) {
    const duration = 0.5 + rnd() * 0.45;
    const base = 62 + rnd() * 38;
    const end = t + duration;

    const buzz = c.createOscillator();
    buzz.type = 'sawtooth';
    buzz.frequency.setValueAtTime(base * 1.5, t);
    buzz.frequency.exponentialRampToValueAtTime(base, t + duration * 0.25);
    buzz.frequency.exponentialRampToValueAtTime(base * 0.7, end);

    // Wobble the pitch a little, irregularly.
    const wobble = c.createOscillator();
    wobble.frequency.value = 7 + rnd() * 6;
    const wobbleDepth = c.createGain();
    wobbleDepth.gain.value = base * 0.18;
    wobble.connect(wobbleDepth).connect(buzz.frequency);

    // The flapping: loudness pulses on and off.
    const flap = c.createGain();
    flap.gain.value = 0.55;
    const flapper = c.createOscillator();
    flapper.type = 'triangle';
    flapper.frequency.setValueAtTime(26 + rnd() * 10, t);
    flapper.frequency.linearRampToValueAtTime(18 + rnd() * 6, end);
    const flapDepth = c.createGain();
    flapDepth.gain.value = 0.45;
    flapper.connect(flapDepth).connect(flap.gain);

    const muffle = c.createBiquadFilter();
    muffle.type = 'lowpass';
    muffle.Q.value = 5;
    muffle.frequency.setValueAtTime(950, t);
    muffle.frequency.exponentialRampToValueAtTime(320, end);

    const envelope = c.createGain();
    envelope.gain.setValueAtTime(0.0001, t);
    envelope.gain.exponentialRampToValueAtTime(0.42, t + 0.03);
    envelope.gain.setValueAtTime(0.42, t + duration * 0.6);
    envelope.gain.exponentialRampToValueAtTime(0.0001, end);

    buzz.connect(flap).connect(muffle).connect(envelope).connect(out);
    noise(c, envelope, t, { duration, from: 500, to: 180, gain: 0.35, type: 'bandpass', q: 1.5 });

    [buzz, wobble, flapper].forEach((osc) => {
      osc.start(t);
      osc.stop(end + 0.05);
    });
  }

  /*
   * A ship sinks: someone screaming. A raspy voice leaps up into an "AAAH", wavers, and
   * sags as it runs out of breath. `pitch` > 1 is a higher voice.
   */
  function scream(c, out, t, { pitch = 1, level = 0.38 } = {}, rnd = Math.random) {
    const duration = 1.25 + rnd() * 0.45;
    const f0 = (430 + rnd() * 110) * pitch;
    const end = t + duration;

    const voice = c.createGain();
    voice.gain.value = 0.6;
    const cords = [-9, 6].map((cents) => {
      const osc = c.createOscillator();
      osc.type = 'sawtooth';
      osc.detune.value = cents;
      osc.frequency.setValueAtTime(f0 * 0.65, t);
      osc.frequency.exponentialRampToValueAtTime(f0 * 1.3, t + 0.16);
      osc.frequency.exponentialRampToValueAtTime(f0 * 1.15, t + duration * 0.7);
      osc.frequency.exponentialRampToValueAtTime(f0 * 0.7, end);
      osc.connect(voice);
      return osc;
    });

    // Vibrato, and a fast flutter in loudness for the rasp.
    const vibrato = c.createOscillator();
    vibrato.frequency.value = 5.5 + rnd() * 2;
    const vibratoDepth = c.createGain();
    vibratoDepth.gain.value = f0 * 0.035;
    vibrato.connect(vibratoDepth);
    cords.forEach((osc) => vibratoDepth.connect(osc.frequency));
    const rasp = c.createOscillator();
    rasp.frequency.value = 48 + rnd() * 20;
    const raspDepth = c.createGain();
    raspDepth.gain.value = 0.3;
    rasp.connect(raspDepth).connect(voice.gain);

    const strain = c.createWaveShaper();
    strain.curve = drive(3);

    // The mouth: "aah" vowel formants.
    const envelope = c.createGain();
    voice.connect(strain);
    [[800, 6, 1.6], [1200, 8, 1.1], [2600, 10, 0.7]].forEach(([freq, q, gain]) => {
      const formant = c.createBiquadFilter();
      formant.type = 'bandpass';
      formant.frequency.value = freq * (pitch > 1 ? 1.08 : 1);
      formant.Q.value = q;
      const level = c.createGain();
      level.gain.value = gain;
      strain.connect(formant).connect(level).connect(envelope);
    });
    noise(c, envelope, t, { duration, from: 3200, to: 1800, gain: 0.12, type: 'bandpass', q: 0.8 });

    envelope.gain.setValueAtTime(0.0001, t);
    envelope.gain.exponentialRampToValueAtTime(level, t + 0.07);
    envelope.gain.setValueAtTime(level, t + duration * 0.72);
    envelope.gain.exponentialRampToValueAtTime(0.0001, end);
    envelope.connect(out);

    [...cords, vibrato, rasp].forEach((osc) => {
      osc.start(t);
      osc.stop(end + 0.05);
    });
  }

  // Several ships at once (the opening collisions): the boom, then a few overlapping screams.
  function collision(c, out, t, sunk) {
    const limiter = c.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    const mix = c.createGain();
    mix.gain.value = 0.8;
    limiter.connect(mix).connect(out);
    boom(c, limiter, t, true);
    const voices = [1, 1.28, 0.82].slice(0, Math.min(3, sunk));
    voices.forEach((pitch, i) => scream(c, limiter, t + 0.35 + i * 0.22, { pitch, level: 0.3 }));
  }

  return { boom, splash, ping, fanfare, fart, scream, collision };
})();
