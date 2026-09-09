/* Flight physics + Estes data, ported from the Recovery Plot web tool.
   Units: SI internally. */

export const G = 9.80665;
export const FT = 3.28084, MPH = 2.23694, IN = 39.3701, OZ = 0.0352740;

export function airDensity(elevM, tempC) {
  const p = 101325 * Math.pow(1 - 2.25577e-5 * elevM, 5.25588);
  return p / (287.058 * (tempC + 273.15));
}

function makeShape(r) {
  const p = Math.max(0.08, (1 - 0.125 * r) / 0.76);
  const pts = [[0, 0], [0.08, r], [0.25, p], [0.85, p], [1, 0]];
  let area = 0;
  for (let i = 0; i < pts.length - 1; i++) area += (pts[i][1] + pts[i + 1][1]) / 2 * (pts[i + 1][0] - pts[i][0]);
  const k = 1 / area;
  return function (tau) {
    if (tau <= 0 || tau >= 1) return 0;
    for (let j = 0; j < pts.length - 1; j++) {
      if (tau >= pts[j][0] && tau <= pts[j + 1][0]) {
        const f = (tau - pts[j][0]) / (pts[j + 1][0] - pts[j][0]);
        return k * (pts[j][1] + f * (pts[j + 1][1] - pts[j][1]));
      }
    }
    return 0;
  };
}

/* A wind profile is [{ h: metres AGL, spd: m/s, dir: degrees the wind comes FROM }],
   sorted by height. Real air veers as well as strengthens with altitude, so speed
   and direction are interpolated separately, direction through its vector so it
   crosses north without spinning the long way round. Below the lowest level and
   above the highest, fall back to the power law anchored on that end level. */
export function windAtHeight(profile, z, alpha) {
  const h = Math.max(2, z);
  const p = profile;
  if (!p || !p.length) return null;
  if (h <= p[0].h) {
    return { spd: p[0].spd * Math.pow(h / p[0].h, alpha), dir: p[0].dir };
  }
  const top = p[p.length - 1];
  if (h >= top.h) {
    return { spd: top.spd * Math.pow(h / top.h, alpha * 0.5), dir: top.dir };
  }
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i], b = p[i + 1];
    if (h >= a.h && h <= b.h) {
      const f = (h - a.h) / (b.h - a.h);
      const ar = a.dir * Math.PI / 180, br = b.dir * Math.PI / 180;
      const sx = Math.sin(ar) * (1 - f) + Math.sin(br) * f;
      const cy = Math.cos(ar) * (1 - f) + Math.cos(br) * f;
      return {
        spd: a.spd * (1 - f) + b.spd * f,
        dir: (Math.atan2(sx, cy) * 180 / Math.PI + 360) % 360
      };
    }
  }
  return { spd: top.spd, dir: top.dir };
}

export function simulate(o) {
  const rho = o.rho, A = Math.PI * Math.pow(o.dia / 2, 2);
  const burn = o.burn, Favg = o.impulse / burn;
  const shape = o.shapeFn || makeShape(o.maxThrust / Favg);
  const ejectT = burn + o.delay;
  const toRad = ((o.windFrom + 180) * Math.PI) / 180;
  const wE = Math.sin(toRad), wN = Math.cos(toRad);
  let t = 0, x = 0, y = 0, z = 0, vx = 0, vy = 0, vz = 0;
  let m = o.dryMass + o.motorInit, impDone = 0;
  const tr = (o.tiltDeg || 0) * Math.PI / 180, ta = (o.tiltAzim || 0) * Math.PI / 180;
  const rodAxis = [Math.sin(tr) * Math.sin(ta), Math.sin(tr) * Math.cos(ta), Math.cos(tr)];
  let axis = rodAxis.slice(), onRod = true, deployed = false, lifted = false;
  let apogee = 0, apogeeT = 0, rodExit = 0, maxV = 0, maxAcc = 0;
  let deployAlt = null, deploySpeed = null, deployT = null;
  const traj = []; let sc = 0, landed = false;
  while (t < 400) {
    const dt = deployed ? 0.02 : 0.004;
    const F = t < burn ? Favg * shape(t / burn) : 0;
    let wv, wEz = wE, wNz = wN;
    if (o.profile && o.profile.length) {
      const w = windAtHeight(o.profile, z, o.alpha);
      wv = w.spd * (o.windScale || 1);
      const tr = ((w.dir + (o.dirShift || 0) + 180) * Math.PI) / 180;
      wEz = Math.sin(tr); wNz = Math.cos(tr);
    } else {
      wv = o.windSpeed * Math.pow(Math.max(z, 2) / 10, o.alpha);
    }
    const rvx = vx - wv * wEz, rvy = vy - wv * wNz, rvz = vz;
    const rs = Math.sqrt(rvx * rvx + rvy * rvy + rvz * rvz);
    if (onRod) { axis = rodAxis; }
    else if (rs > 0.5) {
      const gs = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1e-9, W = o.weathercock;
      const bx = (vx / gs) * (1 - W) + (rvx / rs) * W;
      const by = (vy / gs) * (1 - W) + (rvy / rs) * W;
      const bz = (vz / gs) * (1 - W) + (rvz / rs) * W;
      const bl = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
      axis = [bx / bl, by / bl, bz / bl];
    }
    const CdA = deployed ? o.chuteCdA + 0.35 * A : o.cd * A;
    const q = 0.5 * rho * CdA * rs;
    let ax = (F * axis[0] - q * rvx) / m, ay = (F * axis[1] - q * rvy) / m, az = (F * axis[2] - q * rvz) / m - G;
    if (onRod) {
      let adot = ax * rodAxis[0] + ay * rodAxis[1] + az * rodAxis[2];
      if (!lifted) { if (adot <= 0) { adot = 0; } else { lifted = true; } }
      ax = adot * rodAxis[0]; ay = adot * rodAxis[1]; az = adot * rodAxis[2];
    } else { lifted = true; }
    vx += ax * dt; vy += ay * dt; vz += az * dt;
    const prevZ = z;
    x += vx * dt; y += vy * dt; z += vz * dt; t += dt;
    impDone += F * dt;
    m = o.dryMass + o.motorInit - o.propMass * Math.min(1, impDone / o.impulse);
    if (onRod && Math.sqrt(x * x + y * y + z * z) >= o.rodLen) {
      onRod = false; rodExit = Math.sqrt(vx * vx + vy * vy + vz * vz);
    }
    const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (sp > maxV) maxV = sp;
    const am = Math.sqrt(ax * ax + ay * ay + az * az);
    if (t < burn + 0.05 && am > maxAcc) maxAcc = am;
    if (z > apogee) { apogee = z; apogeeT = t; }
    if (!deployed && t >= ejectT) { deployed = true; deployAlt = z; deployT = t; deploySpeed = sp; }
    if (o.keepTraj && sc++ % (deployed ? 12 : 25) === 0) traj.push({ t, z, x, y });
    if (z <= 0 && t > 0.3) {
      const frac = prevZ / Math.max(1e-9, prevZ - z);
      x -= vx * dt * (1 - frac); y -= vy * dt * (1 - frac); t -= dt * (1 - frac); z = 0;
      landed = true;
      if (o.keepTraj) traj.push({ t, z: 0, x, y });
      break;
    }
  }
  const descentTime = deployT != null ? t - deployT : 0;
  return {
    landed, east: x, north: y,
    drift: Math.sqrt(x * x + y * y),
    bearing: (Math.atan2(x, y) * 180 / Math.PI + 360) % 360,
    apogee, apogeeT, rodExit, maxV, maxAcc,
    deployAlt, deploySpeed, deployT, ejectT, burn, descentTime,
    descentRate: descentTime > 0 ? deployAlt / descentTime : 0,
    flightTime: t, liftMass: o.dryMass + o.motorInit, traj
  };
}

/* impulse Ns, delay s, maxThrust N, burn s, initial mass g, propellant g, max lift g, mount mm */
export const MOTORS = [
  { n: "1/4A3-3T", I: 0.625, d: 3, mx: 4.9, b: 0.25, mi: 5.6, mp: 0.85, lift: 28, mm: 13 },
  { n: "1/2A3-2T", I: 1.25, d: 2, mx: 8.3, b: 0.30, mi: 5.6, mp: 1.75, lift: 57, mm: 13 },
  { n: "1/2A3-4T", I: 1.25, d: 4, mx: 8.3, b: 0.30, mi: 6.0, mp: 1.75, lift: 28, mm: 13 },
  { n: "A3-4T", I: 2.5, d: 4, mx: 6.8, b: 0.60, mi: 7.6, mp: 3.50, lift: 57, mm: 13 },
  { n: "A10-3T", I: 2.5, d: 3, mx: 13.0, b: 0.80, mi: 7.9, mp: 3.78, lift: 85, mm: 13 },
  { n: "1/2A6-2", I: 1.25, d: 2, mx: 8.9, b: 0.30, mi: 15.0, mp: 1.56, lift: 57, mm: 18 },
  { n: "A8-3", I: 2.5, d: 3, mx: 10.7, b: 0.50, mi: 16.2, mp: 3.12, lift: 85, mm: 18 },
  { n: "A8-5", I: 2.5, d: 5, mx: 13.3, b: 0.50, mi: 17.6, mp: 3.12, lift: 57, mm: 18 },
  { n: "B4-2", I: 5, d: 2, mx: 13.2, b: 1.10, mi: 19.8, mp: 8.33, lift: 113, mm: 18 },
  { n: "B4-4", I: 5, d: 4, mx: 13.2, b: 1.10, mi: 21.0, mp: 8.33, lift: 99, mm: 18 },
  { n: "B6-2", I: 5, d: 2, mx: 12.1, b: 0.80, mi: 19.3, mp: 6.24, lift: 127, mm: 18 },
  { n: "B6-4", I: 5, d: 4, mx: 12.1, b: 0.80, mi: 20.1, mp: 6.24, lift: 113, mm: 18 },
  { n: "B6-6", I: 5, d: 6, mx: 12.1, b: 0.80, mi: 22.1, mp: 6.24, lift: 71, mm: 18 },
  { n: "C5-3", I: 10, d: 3, mx: 20.4, b: 1.85, mi: 23.6, mp: 11.00, lift: 227, mm: 18 },
  { n: "C6-3", I: 10, d: 3, mx: 15.3, b: 1.60, mi: 24.9, mp: 12.48, lift: 113, mm: 18 },
  { n: "C6-5", I: 10, d: 5, mx: 15.3, b: 1.60, mi: 25.8, mp: 12.48, lift: 113, mm: 18 },
  { n: "C6-7", I: 10, d: 7, mx: 15.3, b: 1.60, mi: 26.9, mp: 12.48, lift: 71, mm: 18 },
  { n: "C11-3", I: 10, d: 3, mx: 22.1, b: 0.80, mi: 32.2, mp: 11.00, lift: 170, mm: 24 },
  { n: "C11-5", I: 10, d: 5, mx: 22.1, b: 0.80, mi: 33.3, mp: 11.00, lift: 142, mm: 24 },
  { n: "C11-7", I: 10, d: 7, mx: 22.1, b: 0.80, mi: 34.5, mp: 11.00, lift: 71, mm: 24 },
  { n: "D12-3", I: 20, d: 3, mx: 32.9, b: 1.60, mi: 42.2, mp: 24.93, lift: 396, mm: 24 },
  { n: "D12-5", I: 20, d: 5, mx: 32.9, b: 1.60, mi: 43.1, mp: 24.93, lift: 283, mm: 24 },
  { n: "D12-7", I: 20, d: 7, mx: 32.9, b: 1.60, mi: 44.0, mp: 24.93, lift: 226, mm: 24 },
  { n: "E9-4", I: 30, d: 4, mx: 25.0, b: 2.80, mi: 56.7, mp: 35.80, lift: 425, mm: 24 },
  { n: "E9-6", I: 30, d: 6, mx: 25.0, b: 2.80, mi: 56.7, mp: 35.80, lift: 340, mm: 24 },
  { n: "E9-8", I: 30, d: 8, mx: 25.0, b: 2.80, mi: 56.7, mp: 35.80, lift: 283, mm: 24 },
  { n: "E12-4", I: 29.5, d: 4, mx: 29.6, b: 2.70, mi: 63.2, mp: 36.90, lift: 397, mm: 24 },
  { n: "E12-6", I: 29.5, d: 6, mx: 29.6, b: 2.70, mi: 63.2, mp: 36.90, lift: 397, mm: 24 },
  { n: "E12-8", I: 29.5, d: 8, mx: 29.6, b: 2.70, mi: 63.2, mp: 36.90, lift: 397, mm: 24 },
  { n: "F15-4", I: 49.61, d: 4, mx: 25.26, b: 3.45, mi: 103.8, mp: 60.0, lift: 482, mm: 29 },
  { n: "F15-6", I: 49.61, d: 6, mx: 25.26, b: 3.45, mi: 103.8, mp: 60.0, lift: 482, mm: 29 },
  { n: "F15-8", I: 49.61, d: 8, mx: 25.26, b: 3.45, mi: 103.8, mp: 60.0, lift: 482, mm: 29 },
  { n: "E16-4", I: 33.68, d: 4, mx: 26.44, b: 2.09, mi: 84.7, mp: 40.0, lift: 566, mm: 29 },
  { n: "E16-6", I: 33.68, d: 6, mx: 26.44, b: 2.09, mi: 84.7, mp: 40.0, lift: 453, mm: 29 },
  { n: "E16-8", I: 33.68, d: 8, mx: 26.44, b: 2.09, mi: 84.7, mp: 40.0, lift: 396, mm: 29 },
  /* G40 and G80 are the composite motors Estes sells for the big Pro Series II kits.
     ThrustCurve has the certified numbers; neither publishes a max lift weight, so
     these two are worked out at the usual 5:1 thrust to weight and flagged est. */
  { n: "G40-4", I: 97.1, d: 4, mx: 84.5, b: 2.40, mi: 123, mp: 55, lift: 834, mm: 29, est: true },
  { n: "G40-7", I: 97.1, d: 7, mx: 84.5, b: 2.40, mi: 123, mp: 55, lift: 834, mm: 29, est: true },
  { n: "G80-7", I: 136.6, d: 7, mx: 108.5, b: 1.70, mi: 128, mp: 63, lift: 1583, mm: 29, est: true },
  { n: "G80-10", I: 136.6, d: 10, mx: 108.5, b: 1.70, mi: 128, mp: 63, lift: 1583, mm: 29, est: true }
];

/* published kit specs: weight without motor (g), body diameter (mm), chute (in) */
export const KITS = [
  { n: "Alpha", g: 22.7, mm: 25, chute: 12, motor: "C6-5", mount: 18, grp: "fleet",
    note: "1,000 ft on a C6-5, 18 mm mount", eng: ["1/2A6-2", "A8-3", "A8-5", "B4-4", "B6-4", "B6-6", "C6-5", "C6-7"] },
  { n: "Sun-Sational", g: 44.4, mm: 25, chute: 12, motor: "C6-5", mount: 18, grp: "fleet",
    note: "1,100 ft on a C, 18 mm mount", eng: ["A8-3", "B4-4", "B6-4", "C6-5", "C6-7"] },
  { n: "Patriot M-104", g: 56.7, mm: 42, chute: 12, motor: "C6-5", mount: 18, grp: "fleet",
    note: "600 ft, 18 mm mount", eng: ["B4-4", "B6-4", "B6-6", "C6-5"] },
  { n: "Green Eggs (empty)", g: 99.2, mm: 46, chute: 18, motor: "D12-5", mount: 24, cd: 0.6, grp: "fleet",
    note: "1,050 ft on a D12-5, 24 mm mount", eng: ["C11-5", "D12-5", "D12-7"] },
  { n: "Green Eggs (one egg)", g: 156, mm: 46, chute: 18, motor: "D12-5", mount: 24, cd: 0.6, grp: "fleet",
    note: "825 ft with an egg aboard, 24 mm mount", eng: ["C11-3", "C11-5", "D12-5"] },
  { n: "Alpha III", g: 34, mm: 25, chute: 12, motor: "C6-5", mount: 18, grp: "catalog",
    note: "1,100 ft on a C, 18 mm mount", eng: ["1/2A6-2", "A8-3", "B4-4", "B6-4", "C6-5", "C6-7"] },
  { n: "Baby Bertha", g: 57, mm: 42, chute: 12, motor: "C6-5", mount: 18, grp: "catalog",
    note: "about 600 ft, 18 mm mount", eng: ["A8-3", "B4-4", "B6-4", "C6-5"] },
  { n: "Big Bertha", g: 71, mm: 42, chute: 18, motor: "C6-5", mount: 18, grp: "catalog",
    note: "500 ft, 18 mm mount", eng: ["B4-2", "B4-4", "B6-2", "B6-4", "C6-5"] },
  { n: "Der Red Max", g: 68, mm: 42, chute: 18, motor: "C6-5", mount: 18, grp: "catalog",
    note: "600 ft, 18 mm mount", eng: ["B4-2", "B4-4", "B6-2", "B6-4", "C6-5"] },
  { n: "Hi-Flier", g: 25.5, mm: 19, chute: 12, motor: "C6-7", mount: 18, grp: "catalog",
    rec: "streamer", rateFps: 20, note: "1,500 ft, 18 mm mount, streamer",
    eng: ["1/2A6-2", "A8-3", "A8-5", "B4-4", "B6-4", "B6-6", "C6-5", "C6-7"] },
  { n: "Wizard", g: 14.2, mm: 19, chute: 12, motor: "C6-7", mount: 18, grp: "catalog",
    rec: "streamer", rateFps: 20, note: "1,600 ft on a C, 18 mm mount, streamer",
    eng: ["1/2A6-2", "A8-3", "A8-5", "B4-4", "B6-4", "B6-6", "C6-5", "C6-7"] },
  { n: "Big Daddy", g: 150, mm: 76, chute: 24, motor: "E12-4", mount: 24, cd: 0.5, grp: "catalog",
    note: "900 ft on an E, 24 mm mount", eng: ["C11-3", "D12-3", "D12-5", "E12-4", "E12-6"] },
  { n: "Hi-Flier XL", g: 99.2, mm: 42, chute: 18, motor: "D12-5", mount: 24, cd: 0.6, grp: "catalog",
    note: "1,325 ft, 24 mm mount", eng: ["C11-3", "D12-5", "D12-7", "E12-6"] },
  { n: "Super Big Bertha", g: 252, mm: 66, chute: 24, motor: "F15-6", mount: 29, cd: 0.55, rod: 48, grp: "catalog",
    note: "1,200 ft on an F, 29 mm mount", eng: ["F15-4", "F15-6"] },
  { n: "K-25 Astron Alpha", g: 22.7, mm: 25, chute: 12, motor: "C6-5", mount: 18, grp: "catalog",
    note: "1,500 ft, 18 mm mount", eng: ["A8-3", "B6-4", "C6-5", "C6-7"] },
  { n: "Astron Constellation", g: 40, mm: 25, chute: 12, motor: "C6-7", mount: 18, grp: "catalog",
    note: "1,200 ft, 18 mm mount", eng: ["1/2A6-2", "A8-3", "B6-4", "C6-7"] },
  { n: "Crossfire ISX", g: 37, mm: 25, chute: 12, motor: "C6-5", mount: 18, grp: "catalog",
    note: "1,150 ft, 18 mm mount", eng: ["A8-3", "B4-4", "B6-4", "C6-5", "C6-7"] },
  { n: "Bull Pup 12D", g: 51, mm: 34, chute: 12, motor: "C6-5", mount: 18, grp: "catalog",
    note: "675 ft, 18 mm mount", eng: ["A8-3", "B4-4", "B6-4", "C6-5"] },
  { n: "Gnome", g: 14.2, mm: 14, chute: 12, motor: "A3-4T", mount: 13, grp: "catalog",
    rec: "streamer", rateFps: 20, note: "800 ft, 13 mm mini mount, streamer",
    eng: ["1/2A3-2T", "1/2A3-4T", "A3-4T"] },
  { n: "Viking", g: 14.2, mm: 19, chute: 12, motor: "C6-7", mount: 18, grp: "catalog",
    rec: "streamer", rateFps: 20, note: "1,400 ft on a C, 18 mm mount, streamer" },
  { n: "Saturn V (1:200 RTF)", g: 141.7, mm: 50, chute: 18, motor: "C5-3", mount: 18, cd: 0.9, grp: "catalog",
    note: "200 ft. Over the C6-3 rated lift at 5 oz \u2014 the high-thrust C5-3 is the one to fly",
    eng: ["C5-3", "C6-3"] },
  { n: "Saturn V (1:100 kit)", g: 312, mm: 100, chute: 24, chuteN: 2, motor: "F15-4", mount: 29, cd: 0.9, rod: 48, grp: "catalog",
    note: "350 ft. Two 24 in canopies (the nose also carries an 18 in, not counted here)",
    eng: ["E12-4", "F15-4"] },
  { n: "Majestic (Pro Series II)", g: 273, mm: 51, chute: 18, motor: "F15-6", mount: 29, cd: 0.55, rod: 48, grp: "catalog",
    note: "2,000 ft, 29 mm mount", eng: ["F15-4", "F15-6", "F15-8"] },
  { n: "Ventris (Pro Series II)", g: 442, mm: 64, chute: 24, motor: "F15-6", mount: 29, cd: 0.55, rod: 48, grp: "catalog",
    note: "Estes lists composite F and G motors for this, which are not in this table \u2014 an F15 is the closest here and comes out over its lift weight" },
  { n: "Leviathan (Pro Series II)", g: 496, mm: 76, chute: 24, motor: "F15-6", mount: 29, cd: 0.55, rod: 48, grp: "catalog",
    note: "Estes lists composite F and G motors for this, which are not in this table \u2014 an F15 is the closest here and comes out over its lift weight" }
];

export function motorByName(name) {
  return MOTORS.find(m => m.n === name) || MOTORS[15];
}

function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* Several canopies add drag area, not diameter: n chutes of D across pull like one
   of D*sqrt(n). Real clusters shadow each other and one often lags open, so the
   equivalent diameter is knocked back 5% whenever there is more than one. */
export function equivChuteIn(chuteIn, n) {
  const c = Math.max(1, Math.round(n || 1));
  return c > 1 ? chuteIn * Math.sqrt(c) * 0.95 : chuteIn;
}

export function chuteCdA(S) {
  if (S.rec === 'chute') {
    const d = equivChuteIn(S.chuteIn, S.chuteN) * 0.0254;
    return 0.75 * Math.PI * Math.pow(d / 2, 2);
  }
  const rho = airDensity(S.elevM, S.tempC);
  const m = S.massKg + S.motor.mi / 1000 - S.motor.mp / 1000;
  return 2 * m * G / (rho * Math.pow(Math.max(1, S.rateMs), 2));
}


function leanBearing(S) {
  if (S.tiltMode === 'wind') return S.dirFrom;              /* lean into the wind */
  if (S.tiltMode === 'down') return (S.dirFrom + 180) % 360; /* lean downwind */
  return S.tiltBrg;
}

function baseOpts(S) {
  return {
    dryMass: S.massKg, dia: S.diaM, cd: S.cd,
    impulse: S.motor.I, burn: S.motor.b, maxThrust: S.motor.mx, delay: S.motor.d,
    motorInit: S.motor.mi / 1000, propMass: S.motor.mp / 1000,
    chuteCdA: chuteCdA(S),
    windSpeed: S.windMs, windFrom: S.dirFrom, alpha: S.alpha,
    rho: airDensity(S.elevM, S.tempC),
    profile: S.profile || null, rodLen: S.rodM, weathercock: S.wc,
    tiltDeg: S.tiltDeg, tiltAzim: leanBearing(S)
  };
}

/* nominal flight + a dispersion cloud; returns the 90th-percentile search radius */
export function predict(S, nCloud = 42) {
  const gust = Math.max(S.gustMs, S.windMs);
  const wEff = (S.windMs + gust) / 2;
  const o = baseOpts(S);
  o.keepTraj = true;
  o.windSpeed = wEff;
  if (o.profile) o.windScale = wEff / Math.max(0.3, S.windMs || wEff);
  o.shapeFn = makeShape(S.motor.mx / (S.motor.I / S.motor.b));
  const nom = simulate(o);

  const pts = [];
  for (let i = 0; i < nCloud; i++) {
    const mc = baseOpts(S);
    mc.shapeFn = o.shapeFn;
    mc.windSpeed = Math.max(0, S.windMs + (gust - S.windMs) * Math.random() + randn() * wEff * 0.09);
    mc.windFrom = S.dirFrom + randn() * 12;
    if (mc.profile) {
      /* jitter the whole column together: gusts lift every level, and a shift in
         the synoptic flow turns every level. */
      mc.windScale = Math.max(0.2, mc.windSpeed / Math.max(0.3, wEff));
      mc.dirShift = randn() * 12;
    }
    mc.cd = Math.max(0.15, S.cd * (1 + randn() * 0.18));
    mc.dryMass = S.massKg * (1 + randn() * 0.04);
    mc.chuteCdA = chuteCdA(S) * (1 + randn() * 0.14);
    mc.delay = Math.max(0, S.motor.d + (Math.random() * 2 - 1) * Math.max(1, S.motor.d * 0.1));
    mc.weathercock = Math.min(1, Math.max(0, S.wc + randn() * 0.12));
    const r = simulate(mc);
    pts.push([r.east, r.north]);
  }
  const rads = pts
    .map(p => Math.sqrt(Math.pow(p[0] - nom.east, 2) + Math.pow(p[1] - nom.north, 2)))
    .sort((a, b) => a - b);
  const r90 = rads[Math.floor(rads.length * 0.9)] || 0;

  /* where the chute is out, split from the drift under canopy */
  const tj = nom.traj;
  let depIdx = tj.length - 1, apoIdx = 0;
  for (let i = 0; i < tj.length; i++) {
    if (tj[i].z > tj[apoIdx].z) apoIdx = i;
    if (nom.deployT != null && tj[i].t <= nom.deployT) depIdx = i;
  }
  return { nom, pts, r90, apoIdx, depIdx };
}

/* mean walk for a given rod tilt leaned into the wind — the recommender's cost function */
export function meanMiss(S, tiltDeg, runs) {
  const gust = Math.max(S.gustMs, S.windMs);
  let tot = 0;
  for (let i = 0; i < runs; i++) {
    const o = baseOpts(S);
    o.tiltDeg = tiltDeg;
    o.tiltAzim = S.dirFrom;
    o.windSpeed = Math.max(0, S.windMs + (gust - S.windMs) * Math.random());
    o.windFrom = S.dirFrom + randn() * 10;
    tot += simulate(o).drift;
  }
  return tot / runs;
}

export function offsetLatLon(lat, lon, east, north) {
  return [lat + north / 111320, lon + east / (111320 * Math.cos(lat * Math.PI / 180))];
}

export function compassWord(b) {
  const w = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return w[Math.round(b / 22.5) % 16];
}

export function fmt(v, dp) {
  return v.toLocaleString(undefined, { minimumFractionDigits: dp || 0, maximumFractionDigits: dp || 0 });
}

if (typeof window !== "undefined") {
  window.RPPhysics = { G, FT, MPH, IN, OZ, airDensity, simulate, MOTORS, KITS, motorByName, chuteCdA, predict, offsetLatLon, compassWord, fmt };
}


/* ---------------------------------------------------------------------------
   Rockets you enter yourself. They live in localStorage and are spliced into
   KITS under grp "mine", so every screen treats them exactly like a stock kit:
   same card, same motor list filtered to the mount, same checks.
   --------------------------------------------------------------------------- */
export const MYKEY = 'rp.mykits.v1';

export function loadMyKits() {
  let raw = [];
  try { raw = JSON.parse(localStorage.getItem(MYKEY) || '[]'); } catch (e) {}
  return Array.isArray(raw) ? raw : [];
}

function writeMyKits(list) {
  try { localStorage.setItem(MYKEY, JSON.stringify(list)); return true; }
  catch (e) { return false; }
}

/* Biggest motor that fits the mount and still lifts the rocket, else the
   smallest that fits, so a new kit always lands on something sane. */
export function defaultMotorFor(mount, grams) {
  const fit = MOTORS.filter(m => m.mm === mount);
  if (!fit.length) return MOTORS[0].n;
  const ok = fit.filter(m => grams + m.mi <= m.lift);
  const pick = (ok.length ? ok : fit).slice().sort((a, b) => b.I - a.I)[0];
  return (ok.length ? pick : fit.slice().sort((a, b) => a.I - b.I)[0]).n;
}

function normaliseMine(raw) {
  const mount = [13, 18, 24, 29].indexOf(Number(raw.mount)) >= 0 ? Number(raw.mount) : 18;
  const g = Math.max(1, Number(raw.g) || 30);
  const rec = raw.rec === 'streamer' ? 'streamer' : 'chute';
  const k = {
    id: raw.id,
    n: String(raw.n || 'Unnamed').slice(0, 40),
    g: g,
    mm: Math.max(8, Number(raw.mm) || 25),
    mount: mount,
    cd: Number(raw.cd) > 0 ? Number(raw.cd) : 0.7,
    chute: Math.max(4, Number(raw.chute) || 18),
    rec: rec,
    rateFps: Math.max(5, Number(raw.rateFps) || 20),
    rod: Number(raw.rod) > 0 ? Number(raw.rod) : (mount === 29 ? 48 : 36),
    grp: 'mine',
    motor: raw.motor && MOTORS.some(m => m.n === raw.motor) ? raw.motor : defaultMotorFor(mount, g)
  };
  k.note = (k.g / 28.3495).toFixed(1) + ' oz, ' + k.mount + ' mm mount, ' +
           (rec === 'streamer' ? k.rateFps + ' ft/s streamer' : k.chute + ' in canopy');
  return k;
}

/* Rebuild the "mine" slice of KITS from storage. Returns the new KITS. */
export function syncMyKits() {
  for (let i = KITS.length - 1; i >= 0; i--) if (KITS[i].grp === 'mine') KITS.splice(i, 1);
  loadMyKits().forEach(raw => KITS.push(normaliseMine(raw)));
  return KITS;
}

export function addMyKit(raw) {
  const list = loadMyKits();
  const rec = Object.assign({}, raw, { id: raw.id || ('rk' + Date.now().toString(36)) });
  const at = list.findIndex(x => x.id === rec.id);
  if (at >= 0) list[at] = rec; else list.push(rec);
  writeMyKits(list);
  syncMyKits();
  return KITS.findIndex(k => k.id === rec.id);
}

export function removeMyKit(id) {
  writeMyKits(loadMyKits().filter(x => x.id !== id));
  syncMyKits();
}


/* ---------------------------------------------------------------------------
   What is in the range box. Counts live on the phone, keyed by engine name.
   --------------------------------------------------------------------------- */
export const STOCKKEY = 'rp.motorstock.v1';

export function loadStock() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(STOCKKEY) || '{}'); } catch (e) {}
  return raw && typeof raw === 'object' ? raw : {};
}

export function setStock(name, n) {
  const all = loadStock();
  const v = Math.max(0, Math.round(n) || 0);
  if (v === 0) delete all[name]; else all[name] = v;
  try { localStorage.setItem(STOCKKEY, JSON.stringify(all)); } catch (e) {}
  return all;
}

export function stockSummary() {
  const all = loadStock();
  let count = 0, impulse = 0;
  MOTORS.forEach(m => { const n = all[m.n] || 0; count += n; impulse += n * m.I; });
  return { count, impulse };
}

/* Apogee with no wind, for the engine charts. Cheap enough to sweep. */
export function quickApogee(motor, dryG, diaMm, cd, elevM, tempC) {
  const r = simulate({
    dryMass: dryG / 1000, dia: diaMm / 1000, cd: cd,
    impulse: motor.I, burn: motor.b, maxThrust: motor.mx, delay: motor.d,
    motorInit: motor.mi / 1000, propMass: motor.mp / 1000,
    chuteCdA: 0.05, windSpeed: 0, windFrom: 0, alpha: 0.16,
    rho: airDensity(elevM || 0, tempC == null ? 20 : tempC),
    rodLen: 0.9144, weathercock: 0.75, tiltDeg: 0, tiltAzim: 0
  });
  return { apogeeM: r.apogee, rodExit: r.rodExit, lifts: (dryG + motor.mi) <= motor.lift };
}
