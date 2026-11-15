// Unit tests for logic.js. Run with:  npm test   (or: node --test)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../logic.js';

const FPS = 30;
const frameTimes = (fromMs, toMs) => {
  const out = [];
  for (let k = Math.ceil((fromMs * FPS) / 1000); (k * 1000) / FPS <= toMs; k++) out.push((k * 1000) / FPS);
  return out;
};

// Deterministic pseudo-random noise in [-1, 1].
function noise(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return (s / 4294967296) * 2 - 1;
  };
}

// ------------------------------------------------------------ synthetic pose

// World landmarks (metres) for a person seen side-on, plus their image projection.
function makePose({ knee = 175, lean = 0, wrists = 'chest', aspect = 16 / 9, vis = 0.99, s = 0.4 } = {}) {
  const w = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));
  const thigh = 0.45, shank = 0.42, torso = 0.5;
  const th = (knee * Math.PI) / 180;
  for (const [hip, kn, ank, heel, toe, z] of [[23, 25, 27, 29, 31, 0.1], [24, 26, 28, 30, 32, -0.1]]) {
    w[hip] = { x: 0, y: 0, z };
    w[kn] = { x: 0, y: thigh, z };
    w[ank] = { x: shank * Math.sin(th), y: thigh - shank * Math.cos(th), z };
    w[heel] = { x: w[ank].x - 0.05, y: w[ank].y + 0.05, z };
    w[toe] = { x: w[ank].x + 0.15, y: w[ank].y + 0.06, z };
  }
  const lr = (lean * Math.PI) / 180;
  const sMid = { x: torso * Math.sin(lr), y: -torso * Math.cos(lr), z: 0 };
  w[11] = { ...sMid, z: 0.18 };
  w[12] = { ...sMid, z: -0.18 };
  w[0] = { x: sMid.x, y: sMid.y - 0.2, z: 0 };
  if (wrists === 'chest') {
    w[15] = { x: sMid.x + 0.08, y: sMid.y + 0.15, z: 0.05 };
    w[16] = { x: sMid.x + 0.08, y: sMid.y + 0.15, z: -0.05 };
  } else {
    w[15] = { x: 0.3, y: 0.05, z: 0.2 };
    w[16] = { x: 0.3, y: 0.05, z: -0.2 };
  }
  const cx = 0.5 * aspect, cy = 0.45;
  const lm = w.map((p) => ({ x: (cx + p.x * s) / aspect, y: cy + p.y * s, z: p.z, visibility: vis }));
  return { lm, wlm: w.map((p) => ({ ...p, visibility: vis })), aspect };
}

// Feature object as extractFeatures returns it, for driving the test state machines.
function baseFeet(dx = 0) {
  return {
    lAnkle: { x: 1.0 + dx, y: 0.8, z: 0 }, rAnkle: { x: 1.02 + dx, y: 0.8, z: 0 },
    lHeel: { x: 0.98 + dx, y: 0.82, z: 0 }, rHeel: { x: 1.0 + dx, y: 0.82, z: 0 },
    lToe: { x: 1.06 + dx, y: 0.83, z: 0 }, rToe: { x: 1.08 + dx, y: 0.83, z: 0 },
  };
}
const feat = (o = {}) => ({
  ok: true, visibility: 0.95, kneeAngle: 90, trunkLeanDeg: 10, wristsAwayRatio: 0.4,
  hipX: 1.0, hipY: 0.6, legLen: 0.35, torsoLen: 0.2, feet: baseFeet(), ...o,
});

// ------------------------------------------------------------ geometry and filters

test('angleAt gives right and straight angles', () => {
  assert.equal(Math.round(L.angleAt({ x: 0, y: -1 }, { x: 0, y: 0 }, { x: 1, y: 0 })), 90);
  assert.equal(Math.round(L.angleAt({ x: 0, y: -1 }, { x: 0, y: 0 }, { x: 0, y: 1 })), 180);
  assert.ok(Number.isNaN(L.angleAt({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 })));
});

test('tiltFromVertical: upright is 0 degrees, horizontal is 90', () => {
  assert.equal(Math.round(L.tiltFromVertical({ x: 0, y: -1, z: 0 })), 0);
  assert.equal(Math.round(L.tiltFromVertical({ x: 1, y: 0, z: 0 })), 90);
});

test('OneEuro keeps a constant, reduces noise and follows a step', () => {
  const f = new L.OneEuro(L.CONFIG.filters.angle);
  for (const t of frameTimes(0, 1000)) assert.ok(Math.abs(f.filter(100, t) - 100) < 1e-9);

  const g = new L.OneEuro(L.CONFIG.filters.angle);
  const rnd = noise(7);
  const raw = [], out = [];
  for (const t of frameTimes(0, 3000)) {
    const x = 120 + 4 * rnd();
    raw.push(x);
    out.push(g.filter(x, t));
  }
  assert.ok(L.std(out.slice(30)) < L.std(raw.slice(30)) * 0.6, 'filtered noise should be clearly smaller');

  const h = new L.OneEuro(L.CONFIG.filters.angle);
  let y = 0;
  for (const t of frameTimes(0, 1500)) y = h.filter(t < 500 ? 90 : 170, t);
  assert.ok(y > 165, `after 1 s the filter should have followed the step (got ${y.toFixed(1)})`);
});

test('extractFeatures recovers knee angle, trunk lean and arm position', () => {
  for (const knee of [90, 120, 175]) {
    const { lm, wlm, aspect } = makePose({ knee });
    const f = L.extractFeatures(lm, wlm, aspect);
    assert.ok(f.ok);
    assert.ok(Math.abs(f.kneeAngle - knee) < 0.5, `knee ${knee} -> ${f.kneeAngle}`);
  }
  const lean = L.extractFeatures(...Object.values(makePose({ lean: 30 })));
  assert.ok(Math.abs(lean.trunkLeanDeg - 30) < 0.5);

  const chest = L.extractFeatures(...Object.values(makePose({ wrists: 'chest' })));
  const thighs = L.extractFeatures(...Object.values(makePose({ wrists: 'thighs' })));
  assert.ok(chest.wristsAwayRatio < L.CONFIG.chairStand.armsAwayRatio);
  assert.ok(thighs.wristsAwayRatio > L.CONFIG.chairStand.armsAwayRatio);

  const hidden = makePose({ vis: 0.2 });
  assert.equal(L.extractFeatures(hidden.lm, hidden.wlm, hidden.aspect).ok, false);
  assert.equal(L.extractFeatures(null).ok, false);
});

test('framingCheck reasons and FramingGate hold time', () => {
  const { lm } = makePose();
  assert.deepEqual(L.framingCheck(lm), { ok: true, reason: 'ok' });
  assert.equal(L.framingCheck(null).reason, 'no_person');

  const noFeet = lm.map((p, i) => (i === 27 ? { ...p, visibility: 0.1 } : p));
  assert.equal(L.framingCheck(noFeet).reason, 'feet_hidden');

  const edge = lm.map((p, i) => (i === 11 ? { ...p, x: 0.005 } : p));
  assert.equal(L.framingCheck(edge).reason, 'at_edge');

  const small = makePose({ s: 0.1 }).lm;
  assert.equal(L.framingCheck(small).reason, 'too_far');

  const gate = new L.FramingGate();
  assert.equal(gate.update(true, 0), false);
  assert.equal(gate.update(true, 600), false);
  assert.equal(gate.update(true, 1000), true);
  assert.equal(gate.update(false, 1100), false);
  assert.equal(gate.update(true, 1200), false);
});

// ------------------------------------------------------------ chair stand

function runChair(angleAt, { okAt = () => true, wristsAt = () => 0.4 } = {}) {
  const test = new L.ChairStandTest();
  test.start(0);
  let result = null;
  for (const t of frameTimes(0, 31000)) {
    const f = okAt(t) ? feat({ kneeAngle: angleAt(t), wristsAwayRatio: wristsAt(t), trunkLeanDeg: 35 }) : { ok: false };
    result = test.update(f, t) ?? result;
    if (result) break;
  }
  return result;
}

test('chair stand counts 10 stands at 3 s per cycle, despite noise', () => {
  const rnd = noise(42);
  const r = runChair((t) => 132.5 - 42.5 * Math.cos((2 * Math.PI * t) / 3000) + 3 * rnd());
  assert.equal(r.stands, 10);
  assert.equal(r.partialStandCounted, false);
  assert.equal(r.reliable, true);
  assert.ok(Math.abs(r.secondsPerStand - 3) < 0.1);
  assert.equal(r.maxTrunkLeanDeg, 35);
});

test('chair stand applies the CDC halfway rule at 30 s', () => {
  const T = 30000 / 9.35; // 9 full stands, the 10th is past halfway when time runs out
  const r = runChair((t) => 132.5 - 42.5 * Math.cos((2 * Math.PI * t) / T));
  assert.equal(r.stands, 10);
  assert.equal(r.partialStandCounted, true);
});

test('chair stand flags wrists leaving the chest', () => {
  const sine = (t) => 132.5 - 42.5 * Math.cos((2 * Math.PI * t) / 3000);
  assert.equal(runChair(sine).armsUsedSuspected, false);
  const r = runChair(sine, { wristsAt: (t) => (t > 10000 && t < 11000 ? 1.2 : 0.4) });
  assert.equal(r.armsUsedSuspected, true);
});

test('chair stand is not reliable when tracking drops too often', () => {
  const sine = (t) => 132.5 - 42.5 * Math.cos((2 * Math.PI * t) / 3000);
  const r = runChair(sine, { okAt: (t) => Math.floor(t / 1000) % 3 !== 0 }); // 1 s lost every 3 s
  assert.equal(r.reliable, false);
});

// ------------------------------------------------------------ balance

function runStage(stage, feetAt, { okAt = () => true } = {}) {
  const s = new L.BalanceStageTest(stage);
  s.start(0);
  let result = null;
  for (const t of frameTimes(0, 11000)) {
    result = s.update(okAt(t) ? feat({ feet: feetAt(t) }) : { ok: false }, t) ?? result;
    if (result) break;
  }
  return result;
}

test('balance stage: still feet pass with 10 s', () => {
  const rnd = noise(3);
  const r = runStage(2, () => {
    const f = baseFeet();
    for (const k of Object.keys(f)) f[k] = { x: f[k].x + 0.002 * rnd(), y: f[k].y + 0.002 * rnd(), z: 0 };
    return f;
  });
  assert.equal(r.passed, true);
  assert.equal(r.heldS, 10);
});

test('balance stage: a foot moving at 6 s ends the hold at 6 s', () => {
  const r = runStage(2, (t) => {
    const f = baseFeet();
    if (t >= 6000) f.lAnkle = { ...f.lAnkle, x: f.lAnkle.x + 0.06 };
    return f;
  });
  assert.equal(r.passed, false);
  assert.equal(r.heldS, 6);
});

test('balance stage: a 100 ms glitch does not end the hold', () => {
  const r = runStage(1, (t) => {
    const f = baseFeet();
    if (t >= 4000 && t < 4100) f.rToe = { ...f.rToe, x: f.rToe.x + 0.08 };
    return f;
  });
  assert.equal(r.passed, true);
});

test('balance one-leg stage: touchdown of the lifted foot ends the hold', () => {
  const r = runStage(3, (t) => {
    const f = baseFeet();
    if (t < 4000) {
      for (const k of ['rAnkle', 'rHeel', 'rToe']) f[k] = { ...f[k], y: f[k].y - 0.05 };
    }
    return f;
  });
  assert.equal(r.liftedFoot, 'r');
  assert.equal(r.passed, false);
  assert.equal(r.heldS, 4);
});

test('balance test stops at the first stage failed', () => {
  const b = new L.BalanceTest();
  const feetMoveAt = (ms) => (t) => {
    const f = baseFeet();
    if (t >= ms) f.lAnkle = { ...f.lAnkle, x: f.lAnkle.x + 0.06 };
    return f;
  };
  let t0 = 0;
  for (const moveAt of [99999, 99999, 6000]) {
    assert.notEqual(b.startStage(t0), null);
    for (const dt of frameTimes(0, 11000)) {
      if (b.update(feat({ feet: feetMoveAt(moveAt)(dt) }), t0 + dt)) break;
    }
    t0 += 20000;
  }
  assert.equal(b.finished, true);
  assert.equal(b.startStage(t0), null);
  const s = b.summary();
  assert.deepEqual(s.seconds, { side_by_side: 10, semi_tandem: 10, tandem: 6, one_leg: null });
  assert.equal(s.tandemHeld10, false);
  assert.equal(s.stagesPassed, 2);
});

// ------------------------------------------------------------ Timed Up and Go

const lerp = (a, b, u) => a + (b - a) * Math.min(1, Math.max(0, u));

function tugFrame(t) {
  const s = t / 1000;
  let knee, hipX, hipY;
  if (s < 1) [knee, hipX, hipY] = [90, 1.0, 0.62];
  else if (s < 2) [knee, hipX, hipY] = [lerp(90, 175, s - 1), 1.0, lerp(0.62, 0.45, s - 1)];
  else if (s < 9) {
    // walk out (2-5 s), turn (5-6 s), walk back (6-9 s); knee dips to 112 deg at each step
    knee = 143.5 + 31.5 * Math.cos(2 * Math.PI * (s - 2));
    hipX = s < 5 ? lerp(1.0, 1.6, (s - 2) / 3) : s < 6 ? 1.6 : lerp(1.6, 1.0, (s - 6) / 3);
    hipY = 0.45 + 0.01 * Math.sin(4 * Math.PI * s);
  } else if (s < 10) [knee, hipX, hipY] = [lerp(175, 90, s - 9), 1.0, lerp(0.45, 0.62, s - 9)];
  else [knee, hipX, hipY] = [90, 1.0, 0.62];
  return feat({ kneeAngle: knee, hipX, hipY });
}

test('TUG stops when the person sits back down after walking', () => {
  const tug = new L.TugTest();
  tug.start(0);
  let r = null;
  for (const t of frameTimes(0, 15000)) {
    r = tug.update(tugFrame(t), t);
    if (r) break;
  }
  assert.ok(r, 'TUG should finish');
  assert.equal(r.stoppedBy, 'auto');
  assert.ok(r.timeS >= 9.5 && r.timeS <= 10.0, `time ${r.timeS}`);
  assert.equal(r.walkDetected, true);
  assert.equal(r.reliable, true);
  assert.equal(r.aboveCutoff, false);
});

test('TUG: standing up and sitting down without walking does not stop the clock', () => {
  const tug = new L.TugTest();
  tug.start(0);
  let r = null;
  for (const t of frameTimes(0, 61000)) {
    const s = t / 1000;
    const knee = s < 1 ? 90 : s < 2 ? lerp(90, 175, s - 1) : s < 3 ? lerp(175, 90, s - 2) : 90;
    const hipY = s < 1 ? 0.62 : s < 2 ? lerp(0.62, 0.45, s - 1) : s < 3 ? lerp(0.45, 0.62, s - 2) : 0.62;
    r = tug.update(feat({ kneeAngle: knee, hipY }), t);
    if (r) break;
  }
  assert.equal(r.stoppedBy, 'timeout');
  assert.equal(r.reliable, false);
});

test('TUG manual stop', () => {
  const tug = new L.TugTest();
  tug.start(1000);
  const r = tug.manualStop(13300);
  assert.equal(r.timeS, 12.3);
  assert.equal(r.stoppedBy, 'manual');
  assert.equal(r.reliable, true);
});

// ------------------------------------------------------------ references, levels, report

test('CDC chair stand reference values', () => {
  assert.equal(L.chairStandReference('75-79', 'F'), 10);
  assert.equal(L.chairStandReference('60-64', 'M'), 14);
  assert.equal(L.chairStandReference('90-94', 'F'), 4);
  assert.equal(L.chairStandReference('95-99', 'F'), null);
});

test('target levels from test results', () => {
  const base = { ageBand: '75-79', sex: 'F' };
  assert.equal(L.targetLevels({ ...base, chair: { reliable: true, stands: 9 } }).sit_to_stand, 2);
  assert.equal(L.targetLevels({ ...base, chair: { reliable: true, stands: 12 } }).sit_to_stand, 3);
  assert.equal(L.targetLevels({ ...base, chair: { reliable: true, stands: 12, armsUsedConfirmed: true } }).sit_to_stand, 1);
  assert.equal(L.targetLevels({ ...base, chair: { reliable: false, stands: 12 } }).sit_to_stand, null);
  const bal = (seconds) => L.targetLevels({ ...base, balance: { reliable: true, seconds } }).balance;
  assert.equal(bal({ side_by_side: 10, semi_tandem: 10, tandem: 6, one_leg: null }), 1);
  assert.equal(bal({ side_by_side: 10, semi_tandem: 10, tandem: 10, one_leg: 4 }), 3);
  assert.equal(bal({ side_by_side: 10, semi_tandem: 10, tandem: 10, one_leg: 10 }), 4);
});

test('proposed levels move one step per visit and default heel raises to level 1', () => {
  const first = L.proposeLevels({ sit_to_stand: 2, heel_raises: null, balance: 1 });
  assert.equal(first.sit_to_stand.level, 2);
  assert.equal(first.sit_to_stand.change, 'start');
  assert.equal(first.heel_raises.level, 1);
  assert.equal(first.balance.prescription, 'Tandem, hold support, 10 s');

  const later = L.proposeLevels({ sit_to_stand: 3, heel_raises: null, balance: 1 }, { sit_to_stand: 1, heel_raises: 2, balance: 3 });
  assert.deepEqual([later.sit_to_stand.level, later.sit_to_stand.change], [2, 'up']);
  assert.deepEqual([later.balance.level, later.balance.change], [2, 'down']);
  assert.deepEqual([later.heel_raises.level, later.heel_raises.change], [2, 'same']);

  assert.deepEqual(L.levelsFromSession({ routine: [{ exercise: 'balance', level: 3 }, { exercise: 'x', level: 2 }] }), { balance: 3 });
});

test('report rows: flags, trend and "not measured"', () => {
  const session = {
    age_band: '75-79',
    sex: 'F',
    tests: {
      tug: { timeS: 14.2, reliable: true },
      chair_stand_30s: { stands: 9, reliable: true },
      balance_4stage: { reliable: true, tandemHeld10: false, seconds: { side_by_side: 10, semi_tandem: 10, tandem: 6, one_leg: null } },
    },
  };
  const previous = {
    tests: {
      tug: { timeS: 15.0, reliable: true },
      chair_stand_30s: { stands: 8, reliable: true },
      balance_4stage: { reliable: true, seconds: { side_by_side: 10, semi_tandem: 10, tandem: 4, one_leg: null } },
    },
  };
  const rows = Object.fromEntries(L.reportRows(session, previous).map((r) => [r.key, r]));
  assert.equal(rows.tug.flag, 'above cut-off');
  assert.equal(rows.tug.trend, 'better');
  assert.equal(rows.chair.flag, 'below CDC reference');
  assert.equal(rows.chair.reference, '10 or more');
  assert.equal(rows.chair.trend, 'better');
  assert.equal(rows.balance.today, 'tandem 6 s');
  assert.equal(rows.balance.flag, 'tandem under 10 s');

  session.tests.chair_stand_30s.reliable = false;
  const r2 = L.reportRows(session).find((r) => r.key === 'chair');
  assert.equal(r2.today, 'not measured');
  assert.equal(r2.flag, 'check');
});
