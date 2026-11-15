// logic.js
// Test logic for the camera-based strength and balance assessment (MVP).
//
// No DOM and no MediaPipe in this file: every function takes landmarks or
// features plus timestamps in milliseconds. That keeps the rules readable,
// lets you replay recorded data through them, and lets `node --test` check them.
//
// Coordinates follow MediaPipe Pose Landmarker:
// - image landmarks: x, y normalized to [0, 1], y grows downward
// - world landmarks: metres, origin at the midpoint of the hips, y grows downward

export const LM = Object.freeze({
  NOSE: 0,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
  L_HEEL: 29, R_HEEL: 30,
  L_FOOT: 31, R_FOOT: 32,
});

// Every threshold lives here, so the team tunes one object and re-runs the tests.
export const CONFIG = {
  minVisibility: 0.5,
  requiredLandmarks: [11, 12, 23, 24, 25, 26, 27, 28], // shoulders, hips, knees, ankles
  framing: { margin: 0.02, minBodyHeight: 0.25, holdMs: 1000 },
  filters: {
    angle: { minCutoff: 1.0, beta: 0.01, dCutoff: 1.0 }, // degrees
    position: { minCutoff: 1.0, beta: 2.0, dCutoff: 1.0 }, // image height units
  },
  chairStand: {
    durationMs: 30000,
    sitBelowDeg: 115, // knee angle under this = seated
    standAboveDeg: 160, // knee angle over this = full stand
    armsAwayRatio: 0.9, // wrist to shoulder-midpoint distance / torso length
    armsAwayMinMs: 400,
  },
  balance: {
    stageMs: 10000,
    settleMs: 500, // baseline foot position taken over the first 0.5 s
    moveRatio: 0.08, // foot displacement / leg length that counts as "moved"
    moveMinMs: 250, // displacement must last this long
    touchdownRatio: 0.04, // one-leg stage: lifted ankle this close to the standing ankle = touchdown
  },
  tug: {
    standAboveDeg: 150,
    sitBelowDeg: 115,
    seatedHipRatio: 0.15, // hip back within 15% of leg length of its seated height
    walkMinRatio: 0.8, // hip must travel at least 0.8 leg lengths sideways
    seatedHoldMs: 300,
    timeoutMs: 60000,
    cutoffS: 13.5, // StoppSturz Spitex manual
  },
  quality: { minGoodFrameRatio: 0.8, minFrames: 10 },
};

// ---------------------------------------------------------------- geometry

const DEG = 180 / Math.PI;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) };
}

export function norm(v) {
  return Math.hypot(v.x, v.y, v.z ?? 0);
}

export function dist(a, b) {
  return norm(sub(a, b));
}

export function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z ?? 0) + (b.z ?? 0)) / 2 };
}

/** Angle at b (degrees) between segments b->a and b->c. */
export function angleAt(a, b, c) {
  const v1 = sub(a, b);
  const v2 = sub(c, b);
  const n = norm(v1) * norm(v2);
  if (n === 0) return NaN;
  const cos = (v1.x * v2.x + v1.y * v2.y + v1.z * v2.z) / n;
  return Math.acos(clamp(cos, -1, 1)) * DEG;
}

/** Angle (degrees) between a vector and "up" (0, -1, 0), since y grows downward. */
export function tiltFromVertical(v) {
  const n = norm(v);
  if (n === 0) return NaN;
  return Math.acos(clamp(-v.y / n, -1, 1)) * DEG;
}

export function median(arr) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function mean(arr) {
  const a = arr.filter(Number.isFinite);
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
}

export function std(arr) {
  const a = arr.filter(Number.isFinite);
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

export function percentile(arr, p) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const i = clamp(Math.ceil((p / 100) * a.length) - 1, 0, a.length - 1);
  return a[i];
}

const round = (v, d = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

// ---------------------------------------------------------------- smoothing

/** One Euro filter (Casiez et al., CHI 2012): little lag when moving, smooth when still. */
export class OneEuro {
  constructor({ minCutoff = 1.0, beta = 0.0, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }

  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x, tMs) {
    if (!Number.isFinite(x)) return x;
    if (this.tPrev === null) {
      this.xPrev = x;
      this.tPrev = tMs;
      return x;
    }
    const dt = Math.max((tMs - this.tPrev) / 1000, 1e-3);
    const dx = (x - this.xPrev) / dt;
    const aD = OneEuro.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = OneEuro.alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    this.tPrev = tMs;
    return xHat;
  }
}

// ---------------------------------------------------------------- features

const FOOT_POINTS = ['lAnkle', 'rAnkle', 'lHeel', 'rHeel', 'lToe', 'rToe'];

/**
 * Turn one frame of landmarks into the numbers the tests use.
 * @param lm  33 image landmarks (normalized)
 * @param wlm 33 world landmarks (metres), optional
 * @param aspect video width / height, to measure image distances in "height units"
 */
export function extractFeatures(lm, wlm, aspect = 1, cfg = CONFIG) {
  if (!lm || lm.length < 33) return { ok: false, visibility: 0 };
  const vis = (i) => lm[i].visibility ?? 1;
  const req = cfg.requiredLandmarks;
  const visibility = mean(req.map(vis));
  const ok = req.every((i) => vis(i) >= cfg.minVisibility);

  const P = (i) => ({ x: lm[i].x * aspect, y: lm[i].y, z: 0 }); // image, height units
  const W = wlm && wlm.length >= 33 ? (i) => wlm[i] : P; // world if available

  // Knee angle from 3D world landmarks: average both legs when both are clearly seen.
  const kneeL = angleAt(W(23), W(25), W(27));
  const kneeR = angleAt(W(24), W(26), W(28));
  const visL = Math.min(vis(23), vis(25), vis(27));
  const visR = Math.min(vis(24), vis(26), vis(28));
  const kneeAngle = visL >= 0.6 && visR >= 0.6 ? (kneeL + kneeR) / 2 : visL >= visR ? kneeL : kneeR;

  // Trunk lean: shoulder midpoint relative to hip midpoint, against vertical.
  const sMidW = midpoint(W(11), W(12));
  const hMidW = midpoint(W(23), W(24));
  const torsoW = dist(sMidW, hMidW);
  const trunkLeanDeg = tiltFromVertical(sub(sMidW, hMidW));

  // Arms crossed on the chest keep the wrists close to the shoulder midpoint.
  const wristsAwayRatio =
    torsoW > 0 ? Math.max(dist(W(15), sMidW), dist(W(16), sMidW)) / torsoW : NaN;

  const hip = midpoint(P(23), P(24));
  const sh = midpoint(P(11), P(12));
  const legLen = (dist(P(23), P(27)) + dist(P(24), P(28))) / 2;
  const feet = {
    lAnkle: P(27), rAnkle: P(28),
    lHeel: P(29), rHeel: P(30),
    lToe: P(31), rToe: P(32),
  };

  return {
    ok,
    visibility,
    kneeAngle,
    kneeL,
    kneeR,
    trunkLeanDeg,
    wristsAwayRatio,
    hipX: hip.x,
    hipY: hip.y,
    legLen,
    torsoLen: dist(sh, hip),
    feet,
  };
}

/** Smooths the feature signals with one One Euro filter per signal. */
export class FeatureSmoother {
  constructor(cfg = CONFIG) {
    this.cfg = cfg;
    this.filters = {};
  }

  reset() {
    this.filters = {};
  }

  _f(key, value, t, kind) {
    if (!Number.isFinite(value)) return value;
    if (!this.filters[key]) this.filters[key] = new OneEuro(this.cfg.filters[kind]);
    return this.filters[key].filter(value, t);
  }

  smooth(feat, t) {
    if (!feat || !feat.ok) return feat; // never feed bad frames into the filters
    const s = { ...feat };
    s.kneeAngle = this._f('knee', feat.kneeAngle, t, 'angle');
    s.trunkLeanDeg = this._f('lean', feat.trunkLeanDeg, t, 'angle');
    s.hipX = this._f('hipX', feat.hipX, t, 'position');
    s.hipY = this._f('hipY', feat.hipY, t, 'position');
    s.feet = {};
    for (const k of FOOT_POINTS) {
      const p = feat.feet[k];
      s.feet[k] = { x: this._f(k + 'x', p.x, t, 'position'), y: this._f(k + 'y', p.y, t, 'position'), z: 0 };
    }
    return s;
  }
}

// ---------------------------------------------------------------- framing

export const FRAMING_MESSAGES = {
  ok: 'Full body in view',
  no_person: 'No person detected',
  feet_hidden: 'Feet not visible: move the phone back or lower',
  body_hidden: 'Body partly hidden: clear the view',
  at_edge: 'Body at the edge of the image: centre the person',
  too_far: 'Person too small: move the phone closer',
};

/** Is the whole body usable in this frame? Returns { ok, reason }. */
export function framingCheck(lm, cfg = CONFIG) {
  if (!lm || lm.length < 33) return { ok: false, reason: 'no_person' };
  const vis = (i) => lm[i].visibility ?? 1;
  const missing = cfg.requiredLandmarks.filter((i) => vis(i) < cfg.minVisibility);
  if (missing.includes(27) || missing.includes(28)) return { ok: false, reason: 'feet_hidden' };
  if (missing.length) return { ok: false, reason: 'body_hidden' };
  const xs = cfg.requiredLandmarks.map((i) => lm[i].x);
  const ys = cfg.requiredLandmarks.map((i) => lm[i].y);
  const m = cfg.framing.margin;
  if (Math.min(...xs) < m || Math.max(...xs) > 1 - m || Math.min(...ys) < m || Math.max(...ys) > 1 - m) {
    return { ok: false, reason: 'at_edge' };
  }
  if (Math.max(...ys) - Math.min(...ys) < cfg.framing.minBodyHeight) return { ok: false, reason: 'too_far' };
  return { ok: true, reason: 'ok' };
}

/** Framing must stay OK for holdMs before a test may start. */
export class FramingGate {
  constructor(cfg = CONFIG) {
    this.holdMs = cfg.framing.holdMs;
    this.reset();
  }

  reset() {
    this.okSince = null;
  }

  update(ok, t) {
    if (!ok) {
      this.okSince = null;
      return false;
    }
    if (this.okSince === null) this.okSince = t;
    return t - this.okSince >= this.holdMs;
  }
}

// ---------------------------------------------------------------- quality

function qualityOf(frames, good, q) {
  const ratio = frames ? good / frames : 0;
  return { quality: round(ratio, 2), reliable: frames >= q.minFrames && ratio >= q.minGoodFrameRatio };
}

// ---------------------------------------------------------------- 30-second chair stand

/**
 * CDC STEADI 30-second chair stand. Counts full stands with hysteresis on the
 * knee angle, applies the "more than halfway up at 30 s counts" rule, tracks
 * trunk lean and flags wrists leaving the chest (possible use of the arms).
 */
export class ChairStandTest {
  constructor(cfg = CONFIG) {
    this.c = cfg.chairStand;
    this.q = cfg.quality;
  }

  start(t) {
    Object.assign(this, {
      t0: t, lastT: t, phase: null, count: 0, standTimes: [], leanMax: 0, leanCycleMax: 0,
      leanPerStand: [], armsMs: 0, armsSuspected: false, frames: 0, good: 0,
      prevAngle: NaN, partial: false, done: false, result: null,
    });
  }

  elapsed(t) {
    return t - this.t0;
  }

  update(f, t) {
    if (this.done) return this.result;
    const c = this.c;
    const dt = Math.max(0, t - this.lastT);
    this.lastT = t;
    const el = t - this.t0;
    this.frames++;

    if (f && f.ok && Number.isFinite(f.kneeAngle)) {
      this.good++;
      const a = f.kneeAngle;
      if (this.phase === null) this.phase = a >= c.standAboveDeg ? 'up' : 'down';
      if (Number.isFinite(f.trunkLeanDeg)) {
        this.leanCycleMax = Math.max(this.leanCycleMax, f.trunkLeanDeg);
        this.leanMax = Math.max(this.leanMax, f.trunkLeanDeg);
      }
      if (this.phase === 'down' && a >= c.standAboveDeg) {
        this.phase = 'up';
        this.count++;
        this.standTimes.push(el);
        this.leanPerStand.push(this.leanCycleMax);
        this.leanCycleMax = 0;
      } else if (this.phase === 'up' && a <= c.sitBelowDeg) {
        this.phase = 'down';
      }
      if (Number.isFinite(f.wristsAwayRatio) && f.wristsAwayRatio > c.armsAwayRatio) {
        this.armsMs += dt;
        if (this.armsMs >= c.armsAwayMinMs) this.armsSuspected = true;
      } else {
        this.armsMs = 0;
      }
      if (el >= c.durationMs) {
        const halfway = (c.sitBelowDeg + c.standAboveDeg) / 2;
        if (this.phase === 'down' && a >= halfway && Number.isFinite(this.prevAngle) && a > this.prevAngle) {
          this.count++;
          this.partial = true;
        }
        return this._finish();
      }
      this.prevAngle = a;
    } else if (el >= c.durationMs) {
      return this._finish();
    }
    return null;
  }

  _finish() {
    const gaps = this.standTimes.slice(1).map((v, i) => v - this.standTimes[i]);
    this.done = true;
    this.result = {
      test: 'chair_stand_30s',
      stands: this.count,
      partialStandCounted: this.partial,
      standTimesS: this.standTimes.map((v) => round(v / 1000, 2)),
      secondsPerStand: gaps.length ? round(mean(gaps) / 1000, 2) : null,
      maxTrunkLeanDeg: round(this.leanMax, 0),
      trunkLeanPerStandDeg: this.leanPerStand.map((v) => round(v, 0)),
      armsUsedSuspected: this.armsSuspected,
      ...qualityOf(this.frames, this.good, this.q),
    };
    return this.result;
  }
}

// ---------------------------------------------------------------- 4-stage balance

export const BALANCE_STAGES = ['side_by_side', 'semi_tandem', 'tandem', 'one_leg'];
const STANDING_FOOT = { l: ['rAnkle', 'rHeel', 'rToe'], r: ['lAnkle', 'lHeel', 'lToe'] };

/**
 * One stage of the CDC STEADI 4-stage balance test: times the hold until a foot
 * moves (or, on one leg, until the lifted foot touches down), up to 10 s.
 */
export class BalanceStageTest {
  constructor(stageIndex, cfg = CONFIG) {
    this.stage = stageIndex;
    this.c = cfg.balance;
    this.q = cfg.quality;
  }

  start(t) {
    Object.assign(this, {
      t0: t, lastT: t, base: null, samples: [], lifted: null, moveMs: 0, moveStart: null,
      hipXs: [], frames: 0, good: 0, done: false, result: null,
    });
  }

  update(f, t) {
    if (this.done) return this.result;
    const c = this.c;
    const dt = Math.max(0, t - this.lastT);
    this.lastT = t;
    const el = t - this.t0;
    this.frames++;

    if (f && f.ok && f.feet && f.legLen > 0) {
      this.good++;
      if (!this.base) {
        this.samples.push(f);
        if (el >= c.settleMs) this._setBaseline();
      } else {
        const L = this.base.legLen;
        this.hipXs.push(f.hipX / L);
        const points = this.stage === 3 ? STANDING_FOOT[this.lifted] : FOOT_POINTS;
        const disp = Math.max(...points.map((k) => dist(f.feet[k], this.base.feet[k]))) / L;
        let failing = disp > c.moveRatio;
        if (this.stage === 3) {
          const lifted = this.lifted === 'l' ? f.feet.lAnkle : f.feet.rAnkle;
          const standing = this.lifted === 'l' ? f.feet.rAnkle : f.feet.lAnkle;
          if (standing.y - lifted.y < c.touchdownRatio * L) failing = true; // y grows downward
        }
        if (failing) {
          if (this.moveStart === null) this.moveStart = el;
          this.moveMs += dt;
          if (this.moveMs >= c.moveMinMs) return this._finish(this.moveStart, false);
        } else {
          this.moveMs = 0;
          this.moveStart = null;
        }
      }
    }
    if (el >= c.stageMs) return this._finish(c.stageMs, true);
    return null;
  }

  _setBaseline() {
    const S = this.samples;
    const feet = {};
    for (const k of FOOT_POINTS) {
      feet[k] = { x: median(S.map((s) => s.feet[k].x)), y: median(S.map((s) => s.feet[k].y)), z: 0 };
    }
    this.base = { feet, legLen: median(S.map((s) => s.legLen)) };
    if (this.stage === 3) this.lifted = feet.lAnkle.y < feet.rAnkle.y ? 'l' : 'r';
  }

  _finish(heldMs, passed) {
    this.done = true;
    this.result = {
      stage: BALANCE_STAGES[this.stage],
      heldS: round(Math.min(heldMs, this.c.stageMs) / 1000, 1),
      passed,
      liftedFoot: this.lifted,
      swayPctLeg: round(std(this.hipXs) * 100, 1),
      ...qualityOf(this.frames, this.good, this.q),
    };
    return this.result;
  }
}

/** Runs the four stages in order and stops at the first stage failed, as the protocol says. */
export class BalanceTest {
  constructor(cfg = CONFIG) {
    this.cfg = cfg;
    this.results = [];
    this.current = null;
    this.stopped = false;
  }

  get nextStage() {
    if (this.stopped || this.results.length >= BALANCE_STAGES.length) return null;
    return this.results.length;
  }

  get finished() {
    return this.nextStage === null && !this.current;
  }

  startStage(t) {
    const i = this.nextStage;
    if (i === null) return null;
    this.current = new BalanceStageTest(i, this.cfg);
    this.current.start(t);
    return i;
  }

  update(f, t) {
    if (!this.current) return null;
    const r = this.current.update(f, t);
    if (r) {
      this.results.push(r);
      this.current = null;
      if (!r.passed) this.stopped = true;
    }
    return r;
  }

  summary() {
    const seconds = Object.fromEntries(BALANCE_STAGES.map((s) => [s, null]));
    for (const r of this.results) seconds[r.stage] = r.heldS;
    return {
      test: 'balance_4stage',
      seconds,
      stagesPassed: this.results.filter((r) => r.passed).length,
      tandemHeld10: seconds.tandem !== null && seconds.tandem >= 10,
      stages: this.results,
      reliable: this.results.length > 0 && this.results.every((r) => r.reliable),
      quality: round(mean(this.results.map((r) => r.quality)), 2),
    };
  }
}

// ---------------------------------------------------------------- Timed Up and Go

/**
 * Timed Up and Go: the clock starts at "Go" (the caller passes that time to
 * start) and stops when the person is seated again after standing up and walking.
 */
export class TugTest {
  constructor(cfg = CONFIG) {
    this.c = cfg.tug;
    this.q = cfg.quality;
  }

  start(t) {
    Object.assign(this, {
      t0: t, phase: 'seated', hip0: null, legLen: null, maxWalk: 0, seatedSince: null,
      standAtMs: null, frames: 0, good: 0, done: false, result: null,
    });
  }

  get walked() {
    return this.maxWalk >= this.c.walkMinRatio;
  }

  update(f, t) {
    if (this.done) return this.result;
    const c = this.c;
    const el = t - this.t0;
    this.frames++;
    if (f && f.ok && Number.isFinite(f.kneeAngle) && f.legLen > 0) {
      this.good++;
      if (!this.hip0) {
        this.hip0 = { x: f.hipX, y: f.hipY };
        this.legLen = f.legLen;
      }
      const L = this.legLen;
      if (this.phase === 'seated' && f.kneeAngle >= c.standAboveDeg) {
        this.phase = 'up';
        this.standAtMs = el;
      } else if (this.phase === 'up') {
        this.maxWalk = Math.max(this.maxWalk, Math.abs(f.hipX - this.hip0.x) / L);
        const seated = f.kneeAngle <= c.sitBelowDeg && f.hipY >= this.hip0.y - c.seatedHipRatio * L;
        if (this.walked && seated) {
          if (this.seatedSince === null) this.seatedSince = el;
          if (el - this.seatedSince >= c.seatedHoldMs) return this._finish(this.seatedSince, 'auto');
        } else {
          this.seatedSince = null;
        }
      }
    }
    if (el >= c.timeoutMs) return this._finish(el, 'timeout');
    return null;
  }

  manualStop(t) {
    if (this.done) return this.result;
    return this._finish(t - this.t0, 'manual');
  }

  _finish(ms, stoppedBy) {
    this.done = true;
    const q = qualityOf(this.frames, this.good, this.q);
    const timeS = round(ms / 1000, 1);
    const reliable = stoppedBy === 'manual' ? true : stoppedBy === 'auto' && q.reliable;
    this.result = {
      test: 'tug',
      timeS,
      stoppedBy,
      standUpS: this.standAtMs === null ? null : round(this.standAtMs / 1000, 1),
      walkDetected: this.walked,
      aboveCutoff: timeS >= this.c.cutoffS,
      quality: q.quality,
      reliable,
    };
    return this.result;
  }
}

// ---------------------------------------------------------------- reference values

export const AGE_BANDS = ['60-64', '65-69', '70-74', '75-79', '80-84', '85-89', '90-94'];

/** CDC STEADI 30-second chair stand: fewer stands than this = below average for age and sex. */
export const CHAIR_STAND_BELOW_AVERAGE = {
  '60-64': { M: 14, F: 12 },
  '65-69': { M: 12, F: 11 },
  '70-74': { M: 12, F: 10 },
  '75-79': { M: 11, F: 10 },
  '80-84': { M: 10, F: 9 },
  '85-89': { M: 8, F: 8 },
  '90-94': { M: 7, F: 4 },
};

export function chairStandReference(ageBand, sex) {
  const row = CHAIR_STAND_BELOW_AVERAGE[ageBand];
  return row && row[sex] !== undefined ? row[sex] : null;
}

/** Stands to report: CDC records 0 when the arms were needed (confirmed by the nurse). */
export function chairStandScore(chair) {
  if (!chair) return null;
  return chair.armsUsedConfirmed ? 0 : chair.stands;
}

// ---------------------------------------------------------------- exercise levels

export const EXERCISES = {
  sit_to_stand: {
    name: 'Sit to stand',
    levels: ['2 hands, 5 stands', '1 hand, 5 stands', 'No hands, 10 stands', 'No hands, 2 × 10 stands'],
  },
  heel_raises: {
    name: 'Heel raises',
    levels: ['Hold support, 10 raises', 'No support, 10 raises', 'Hold support, 2 × 10', 'No support, 2 × 10'],
  },
  balance: {
    name: 'Balance stance',
    levels: ['Tandem, hold support, 10 s', 'Tandem, no support, 10 s', 'One leg, hold support, 10 s', 'One leg, no support, 10 s, then 30 s'],
  },
};

/** Level that today's results point to (null when the exercise was not measured). */
export function targetLevels({ chair, balance, ageBand, sex }) {
  const target = { sit_to_stand: null, heel_raises: null, balance: null };
  if (chair && chair.reliable) {
    const score = chairStandScore(chair);
    const ref = chairStandReference(ageBand, sex);
    if (score === 0) target.sit_to_stand = 1;
    else if (ref !== null && score < ref) target.sit_to_stand = 2;
    else target.sit_to_stand = 3;
  }
  if (balance && balance.reliable) {
    const s = balance.seconds;
    if (s.one_leg !== null && s.one_leg >= 10) target.balance = 4;
    else if (s.tandem !== null && s.tandem >= 10) target.balance = 3;
    else target.balance = 1;
  }
  return target;
}

/**
 * Proposed level per exercise. First visit: start at the target level.
 * Later visits: move at most one level toward the target. The nurse confirms.
 */
export function proposeLevels(target, previous = {}) {
  const out = {};
  for (const ex of Object.keys(EXERCISES)) {
    const tgt = target[ex] ?? null;
    const prev = previous[ex] ?? null;
    let level;
    let change;
    let reason;
    if (tgt === null && prev === null) {
      [level, change, reason] = [1, 'start', 'not tested: the nurse sets the level'];
    } else if (prev === null) {
      [level, change, reason] = [tgt, 'start', "starting level from today's test"];
    } else if (tgt === null) {
      [level, change, reason] = [prev, 'same', 'not measured today'];
    } else if (tgt > prev) {
      [level, change, reason] = [prev + 1, 'up', "today's result fits a higher level (one step per visit)"];
    } else if (tgt < prev) {
      [level, change, reason] = [prev - 1, 'down', "today's result fits a lower level (one step per visit)"];
    } else {
      [level, change, reason] = [prev, 'same', "today's result fits the current level"];
    }
    out[ex] = { exercise: ex, name: EXERCISES[ex].name, level, prescription: EXERCISES[ex].levels[level - 1], change, reason };
  }
  return out;
}

/** Levels from a previous session JSON ({ routine: [{ exercise, level }] }). */
export function levelsFromSession(session) {
  const out = {};
  for (const r of session?.routine ?? []) {
    if (EXERCISES[r.exercise] && Number.isInteger(r.level)) out[r.exercise] = r.level;
  }
  return out;
}

// ---------------------------------------------------------------- report

function balanceText(s) {
  if (!s) return '–';
  if (s.one_leg !== null) return `one leg ${s.one_leg} s`;
  if (s.tandem !== null) return `tandem ${s.tandem} s`;
  if (s.semi_tandem !== null) return `semi-tandem ${s.semi_tandem} s`;
  if (s.side_by_side !== null) return `side by side ${s.side_by_side} s`;
  return '–';
}

function balanceTotal(s) {
  return s ? Object.values(s).reduce((sum, v) => sum + (v ?? 0), 0) : null;
}

function trend(today, last, higherIsBetter) {
  if (!Number.isFinite(today) || !Number.isFinite(last)) return null;
  if (today === last) return 'same';
  return today > last === higherIsBetter ? 'better' : 'worse';
}

/** Rows for the one-page report: Test | Today | Last visit | Reference | Flag. */
export function reportRows(session, previous = null, cfg = CONFIG) {
  const T = session?.tests ?? {};
  const P = previous?.tests ?? {};
  const rows = [];

  if (T.tug) {
    const t = T.tug;
    const p = P.tug?.reliable ? P.tug : null;
    rows.push({
      key: 'tug',
      test: 'Timed Up and Go',
      today: t.reliable ? `${t.timeS} s` : 'not measured',
      last: p ? `${p.timeS} s` : '–',
      reference: `under ${cfg.tug.cutoffS} s`,
      flag: !t.reliable ? 'check' : t.timeS >= cfg.tug.cutoffS ? 'above cut-off' : 'ok',
      trend: t.reliable && p ? trend(t.timeS, p.timeS, false) : null,
    });
  }

  if (T.chair_stand_30s) {
    const c = T.chair_stand_30s;
    const p = P.chair_stand_30s?.reliable ? P.chair_stand_30s : null;
    const score = chairStandScore(c);
    const ref = chairStandReference(session.age_band, session.sex);
    rows.push({
      key: 'chair',
      test: '30-second chair stand',
      today: c.reliable ? `${score} stands${c.armsUsedConfirmed ? ' (arms used)' : ''}` : 'not measured',
      last: p ? `${chairStandScore(p)} stands` : '–',
      reference: ref !== null ? `${ref} or more` : '–',
      flag: !c.reliable ? 'check' : ref !== null && score < ref ? 'below CDC reference' : 'ok',
      trend: c.reliable && p ? trend(score, chairStandScore(p), true) : null,
    });
  }

  if (T.balance_4stage) {
    const b = T.balance_4stage;
    const p = P.balance_4stage?.reliable ? P.balance_4stage : null;
    rows.push({
      key: 'balance',
      test: '4-stage balance',
      today: b.reliable ? balanceText(b.seconds) : 'not measured',
      last: p ? balanceText(p.seconds) : '–',
      reference: 'tandem 10 s',
      flag: !b.reliable ? 'check' : b.tandemHeld10 ? 'ok' : 'tandem under 10 s',
      trend: b.reliable && p ? trend(balanceTotal(b.seconds), balanceTotal(p.seconds), true) : null,
    });
  }
  return rows;
}

/** Plain-language observations under the report table. */
export function observations(session) {
  const T = session?.tests ?? {};
  const out = [];
  const c = T.chair_stand_30s;
  if (c) {
    if (!c.reliable) out.push(`Chair stand: tracking quality ${Math.round((c.quality ?? 0) * 100)}%, so no count is reported.`);
    if (Number.isFinite(c.maxTrunkLeanDeg)) out.push(`Chair stand: maximum trunk lean ${c.maxTrunkLeanDeg}°.`);
    if (c.armsUsedSuspected && !c.armsUsedConfirmed) out.push('Chair stand: wrists left the chest. Check whether the arms were used (CDC scores that as 0).');
    if (c.partialStandCounted) out.push('Chair stand: last stand was more than halfway up at 30 s and was counted, as the CDC protocol says.');
  }
  const t = T.tug;
  if (t) {
    if (t.stoppedBy === 'manual') out.push('TUG: timer stopped by hand.');
    if (t.stoppedBy === 'timeout') out.push('TUG: no return to the chair detected within 60 s.');
    if (!t.walkDetected && t.stoppedBy !== 'manual') out.push('TUG: walk not detected. Check that the whole walkway is in view.');
  }
  const b = T.balance_4stage;
  if (b) {
    if (!b.reliable) out.push('Balance: tracking quality too low on at least one stage, so no time is reported.');
    const tandem = b.stages?.find((s) => s.stage === 'tandem');
    if (tandem && Number.isFinite(tandem.swayPctLeg)) out.push(`Balance: sway in tandem stance ${tandem.swayPctLeg}% of leg length.`);
  }
  return out;
}
