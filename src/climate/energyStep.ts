/**
 * Time stepping of the coupled energy-balance model (energy.ts): one ~5-day operator-split,
 * backward-Euler step and the yearly driver with monthly averaging.
 */
import { applyStencil } from './dynAdvect';
import {
  glacierWeight, iceAreaAfter, snowCoverFactor, snowfallRate, snowMassCover, snowWeight,
  type EbmCoupling, type EbmModel, type EbmMonthly, type EbmState,
} from './energy';
import { applyIceFlow, applyIceSurface } from './energyIce';
import { solveCyclic, solveTridiag } from './numerics';
import { ebmTuning } from './tuning';

/**
 * Integrate one model year (stepsPerYear steps) from `S` in place. When `out` is given, monthly
 * means of this year are written into it.
 */
export function integrateYear(M: EbmModel, S: EbmState, cp: EbmCoupling, out: EbmMonthly | null): void {
  const n = M.g.n;
  // Ice flow feeds last year's ablation zones; ice-sheet surfaces follow the glacier mask.
  applyIceFlow(M, S);
  applyIceSurface(M, S);
  if (out) {
    out.tAir.fill(0);
    out.sst.fill(0);
    out.ice.fill(0);
    out.mMin.set(S.M);
  }
  const inv = 1 / M.stepsPerMonth;
  const minY = M.minY;
  for (let k = 0; k < M.stepsPerYear; k++) {
    step(M, S, cp, k);
    for (let i = 0; i < n; i++) if (S.M[i] < minY[i]) minY[i] = S.M[i];
    if (!out) continue;
    const o = Math.floor(k / M.stepsPerMonth) * n;
    const { To, ice } = M.work;
    const Mm = S.M, mMin = out.mMin;
    for (let i = 0; i < n; i++) {
      out.tAir[o + i] += S.T[i] * inv;
      out.sst[o + i] += To[i] * inv;
      out.ice[o + i] += ice[i] * inv;
      if (Mm[i] < mMin[i]) mMin[i] = Mm[i];
    }
  }
}

/** One operator-split step k (0..stepsPerYear−1) of the coupled model, in place. */
function step(M: EbmModel, S: EbmState, cp: EbmCoupling, k: number): void {
  const t = ebmTuning;
  const { g, land, lapse, dt, cOcean, albLand, albWater, eFull, eMax, work } = M;
  const { nx, ny, n } = g;
  const month = Math.floor(k / M.stepsPerMonth) % 12;
  const A = t.olrA, B = t.olrB, Tf = t.freezeT, aIce = t.albedoIce;
  const cL = t.cLand, cA = t.cAir, cI = t.cIceSurface, gam = t.airSeaExchange;
  const Tc = S.T, E = S.E, Ti = S.Ti, Es = S.Es, Mass = S.M;
  // Seasonal stratified layer (energy.ts EbmState.Es): capacity and per-step mixing into the deep layer.
  const Cs = t.stratDepth > 0 ? t.rhoCpWater * t.stratDepth : 0;
  const invCs = Cs > 0 ? 1 / Cs : 0;
  const stratMix = Cs > 0 ? 1 - Math.exp(-dt / (t.stratMixDays * 86400)) : 1;
  const { F, dep, To, tAirMean, cEff, ice, melt } = work;
  const mMax = t.glacierMassMax;
  const rampLand = 1 / (t.seaIceRampWarm - t.seaIceRampCold);
  const LfSnow = t.latentFusion;
  const { accY, ablY, potY } = M;
  const kPot = t.meltCoupling / LfSnow;
  const qOff = k * ny;

  // (0) Land forcing with snow albedo lagged from the previous step (plus the free-troposphere
  //     coupling of high terrain toward the row-mean air temperature) and snowfall on the land
  //     snow/ice mass; ocean surface state. Snow albedo: the colder of a temperature ramp (fresh
  //     snow of the cold season) and the cover of the snowpack itself, which stays bright until it
  //     has melted; glaciers take the ice-sheet albedo and are not patchy on high terrain.
  const ft = M.freeTrop;
  const albOff = cp.albedoOffset;
  const aOff = month * n;
  for (let j = 0; j < ny; j++) {
    const Q = M.insol[qOff + j];
    const aL = albLand[j];
    const Co = cOcean[j];
    let rowMean = 0;
    for (let c = 0; c < nx; c++) rowMean += Tc[j * nx + c];
    rowMean /= nx;
    const moistShift = t.moistLapseReduction > 0 ? (t.moistLapseReduction / 6.5) * Math.min(1, Math.max(0, rowMean / t.moistLapseWarmT)) : 0;
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      if (land[i]) {
        const ts0 = Tc[i] - lapse[i];
        const sf = snowfallRate(ts0) * dt;
        accY[i] += sf;
        let m = Mass[i] + sf;
        if (m > mMax) m = mMax;
        Mass[i] = m;
        const G = glacierWeight(m);
        const cover = snowMassCover(m);
        let w = snowWeight(ts0);
        const wet = cover * t.snowWetWeight;
        if (wet > w) w = wet;
        if (G > w) w = G;
        const a0 = albOff ? aL + albOff[aOff + i] : aL;
        const wCold = (t.seaIceRampWarm - ts0) * rampLand;
        const aSheet = t.albedoIceSheetMelt + (t.albedoIceSheet - t.albedoIceSheetMelt) * (wCold < 0 ? 0 : wCold > 1 ? 1 : wCold);
        const aSnow = aIce + (aSheet - aIce) * G;
        const alb = a0 + (aSnow - a0) * w * snowCoverFactor(G, lapse[i]);
        melt[i] = t.meltCoupling * cover;
        // Free-troposphere coupling target: the free air at the terrain height follows the moist
        // adiabat, which in warm climates is shallower than the standard lapse rate Γ (the surface
        // of a tropical plateau sits in air warmer than T_sl − Γh).
        F[i] = Q * (1 - alb) - A + B * lapse[i] + ft[i] * (rowMean + moistShift * lapse[i]);
        To[i] = 0;
        ice[i] = 0;
      } else {
        ice[i] = E[i] < 0 ? S.Ai[i] : 0;
        To[i] = Tf + Math.max(0, E[i]) / Co + (Es[i] > 0 ? Es[i] * invCs : 0);
      }
    }
  }

  // (1) Air column: land relaxes toward its radiative balance, ocean air toward the surface
  //     (open water / ice); sub-stepped with semi-Lagrangian advection in pass 2 (coupling
  //     factors over land: see EbmCoupling.airWarm / airCold).
  const airSt = cp.air ? cp.air[month] : null;
  const nSub = airSt ? airSt.nSub : 1;
  const dts = dt / nSub;
  const cdL = cL / dts, cdA = cA / dts;
  const kWarm = cp.airWarm ? cp.airWarm.subarray(month * n, (month + 1) * n) : null;
  const kCold = cp.airCold ? cp.airCold.subarray(month * n, (month + 1) * n) : null;
  tAirMean.fill(0);
  for (let s = 0; s < nSub; s++) {
    const src = airSt ? dep : Tc;
    if (airSt) applyStencil(airSt, Tc, dep);
    for (let i = 0; i < n; i++) {
      if (land[i]) {
        let d = src[i] - Tc[i];
        if (kWarm && kCold) d *= d > 0 ? kWarm[i] : kCold[i];
        const rhs = cdL * (Tc[i] + d) + F[i];
        const den = cdL + B + ft[i];
        let tn = rhs / den;
        const m = Mass[i];
        if (m > 0 && tn > lapse[i]) {
          // Snow or ice at the surface: it cannot warm above 0 °C; the surplus melts it.
          const lam = melt[i];
          tn = (rhs + lam * lapse[i]) / (den + lam);
          const dm = (lam * (tn - lapse[i]) * dts) / LfSnow;
          if (dm >= m) {
            // The pack is gone within the sub-step: only its latent heat is taken up.
            tn = (rhs - (m * LfSnow) / dts) / den;
            Mass[i] = 0;
            ablY[i] += m;
          } else {
            Mass[i] = m - dm;
            ablY[i] += dm;
          }
        }
        // Melt an ice surface would still have had here (bare land warmer than 0 °C).
        if (tn > lapse[i] && Mass[i] <= 0) potY[i] += kPot * (tn - lapse[i]) * dts;
        Tc[i] = tn;
      } else {
        const a = ice[i];
        const tsf = (1 - a) * To[i] + a * Ti[i];
        const ta = (cdA * src[i] + gam * tsf) / (cdA + gam);
        Tc[i] = ta;
        tAirMean[i] += ta / nSub;
      }
    }
  }

  // (2) Mixed-layer heat advection by currents (pass 2); currents, the overturning and the ocean
  //     diffusion move the deep mixed layer (To holds its temperature until the end of step 3b).
  for (let j = 0; j < ny; j++) {
    const Co = cOcean[j];
    for (let i = j * nx; i < (j + 1) * nx; i++) if (!land[i]) To[i] = Tf + Math.max(0, E[i]) / Co;
  }
  const seaSt = cp.sea ? cp.sea[month] : null;
  if (seaSt && cp.nearestOcean) {
    const near = cp.nearestOcean;
    for (let s = 0; s < seaSt.nSub; s++) {
      for (let i = 0; i < n; i++) if (land[i]) To[i] = To[near[i]];
      applyStencil(seaSt, To, dep);
      for (let j = 0; j < ny; j++) {
        const Co = cOcean[j];
        for (let c = 0; c < nx; c++) {
          const i = j * nx + c;
          if (land[i]) continue;
          E[i] += Co * (dep[i] - To[i]);
          To[i] = Tf + Math.max(0, E[i]) / Co;
        }
      }
    }
  }

  // (3) Local ocean / sea-ice step (implicit), forced by the mean air temperature of the step.
  const upw = cp.upwellLambda;
  const tSub = cp.tSub;
  const uOff = month * n;
  const kIce = t.iceConductivity;
  const hSnow = t.iceSnowEquivalent;
  const Lf = t.iceLatent;
  const hFull = t.iceFullThickness;
  const hLead = t.seaIceLeadThickness;
  const hMin = t.seaIceMinThickness;
  const fBasal = t.iceBasalHeatFlux;
  const Ai = S.Ai;
  const aMelt = t.albedoSeaIceMelt;
  const tConv = t.convectiveCapT;
  const kConv = t.convectiveDamping;
  const rampI = 1 / (t.seaIceRampWarm - t.seaIceRampCold);
  for (let j = 0; j < ny; j++) {
    const Q = M.insol[qOff + j];
    const Co = cOcean[j];
    const cdo = Co / dt;
    const cdi = cI / dt;
    const saWRow = Q * (1 - albWater[j]);
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      if (land[i]) {
        cEff[i] = cL;
        continue;
      }
      cEff[i] = cA;
      const saW = albOff ? saWRow - Q * albOff[aOff + i] : saWRow;
      const lu = upw ? upw[uOff + i] : 0;
      const ts = tSub ? tSub[i] : Tf;
      const ta = tAirMean[i];
      let e = E[i];
      let ti = Ti[i];
      let es = Es[i];
      if (e >= 0) {
        const to = Tf + e / Co;
        const t1 = to + es * invCs;
        const F0 = saW - A + lu * ts + gam * ta;
        const lam = B + lu + gam;
        if (Cs > 0 && Cs < Co && (es > 0 || F0 - lam * t1 > 0)) {
          // Stratified (or stratifying) surface layer takes the surface flux; once cooling has
          // eroded it, the rest of the cooling reaches the deep mixed layer.
          const cds = Cs / dt;
          let t1New = (cds * t1 + F0) / (cds + lam);
          if (t1New > tConv) t1New = (cds * t1 + F0 + kConv * tConv) / (cds + lam + kConv);
          es += Cs * (t1New - t1);
          if (es < 0) {
            e += es;
            es = 0;
          }
          // Wind stirring mixes the stratified heat down.
          const d = es * stratMix;
          es -= d;
          e += d;
        } else {
          let toNew = (cdo * to + F0) / (cdo + lam);
          // Convective thermostat: deep convection sheds heat steeply above ~28 °C.
          if (toNew > tConv) toNew = (cdo * to + F0 + kConv * tConv) / (cdo + lam + kConv);
          e = Co * (toNew - Tf);
        }
        if (e < 0) {
          ti = Math.min(Tf, ta);
          e += es;
          es = 0;
        }
      } else {
        e += es;
        es = 0;
        const v = -e / Lf;
        let a = ice[i] > 0 ? ice[i] : Math.min(1, v / hLead);
        if (a > v / hMin) a = v / hMin;
        const hi = Math.max(hFull, v / a);
        const K = kIce / (hi + hSnow);
        // Sea-ice albedo from the previous ice-surface temperature (melting ice is darker).
        const wCold = Math.min(1, Math.max(0, (t.seaIceRampWarm - ti) * rampI));
        const saI = Q * (1 - (aMelt + (aIce - aMelt) * wCold));
        let tiNew = (cdi * ti + saI - A + K * Tf + gam * ta) / (cdi + B + K + gam);
        let melt = 0;
        if (tiNew > 0) {
          melt = cdi * ti + saI - A + K * Tf + gam * ta;
          tiNew = 0;
        }
        // Net flux into the ocean enthalpy from the ice part and from the open water at T_f; heat
        // of upwelled deep water reaches the whole cell (it melts the ice from below).
        const G = melt - K * (Tf - tiNew);
        const Fw = saW - A - B * Tf + gam * (ta - Tf);
        const Fu = lu * (ts - Tf);
        const e0 = e;
        e += dt * ((1 - a) * Fw + a * (G + fBasal) + Fu);
        if (e < -eMax) e = -eMax;
        // Area: open water freezing in the leads closes them with new ice; net melt thins the pack
        // from its thin end (iceAreaAfter).
        let aa = a;
        if (Fw < 0 && e < 0) aa += ((1 - a) * -Fw * dt) / (Lf * hLead);
        Ai[i] = iceAreaAfter(e0, e, aa > 1 ? 1 : aa);
        ti = tiNew;
      }
      if (e < -eMax) e = -eMax;
      if (e >= 0) Ai[i] = 0;
      else if (E[i] >= 0) Ai[i] = iceAreaAfter(E[i], e, 0);
      const aNew = Ai[i];
      if (aNew > 0 && ice[i] === 0) ti = Math.min(Tf, ta);
      E[i] = e;
      Es[i] = es;
      Ti[i] = ti;
      To[i] = Tf + Math.max(0, e) / Co;
      ice[i] = aNew;
    }
  }

  // (3a) Interhemispheric overturning: steady heat source/sink of the ocean (melts ice where released).
  const moc = M.overturning;
  if (moc) {
    for (let j = 0; j < ny; j++) {
      const Co = cOcean[j];
      for (let c = 0; c < nx; c++) {
        const i = j * nx + c;
        const q = moc[i];
        if (q === 0 || land[i]) continue;
        let e = E[i] + dt * q;
        if (e < -eMax) e = -eMax;
        const aNew = iceAreaAfter(E[i], e, Ai[i]);
        if (aNew > 0 && ice[i] === 0) Ti[i] = Math.min(Tf, tAirMean[i]);
        E[i] = e;
        Ai[i] = aNew;
        ice[i] = aNew;
        To[i] = Tf + Math.max(0, e) / Co;
      }
    }
  }

  // (3b) Implicit diffusion of the mixed-layer temperature between ocean cells; the heat goes into
  //      the enthalpy (melting or growing ice where T_o is pinned at freezing).
  if (t.oceanDiffusion > 0) {
    for (let i = 0; i < n; i++) {
      if (land[i]) {
        // Decoupled placeholder (all faces touching land carry zero flux).
        To[i] = 0;
        cEff[i] = cL;
      } else {
        cEff[i] = cOcean[(i / nx) | 0];
      }
    }
    work.dep.set(To);
    diffuse(M, To, cEff, M.oE, M.oN, M.oS);
    for (let j = 0; j < ny; j++) {
      const Co = cOcean[j];
      for (let c = 0; c < nx; c++) {
        const i = j * nx + c;
        if (land[i]) continue;
        let e = E[i] + Co * (To[i] - work.dep[i]);
        if (e < -eMax) e = -eMax;
        const aNew = iceAreaAfter(E[i], e, Ai[i]);
        E[i] = e;
        Ai[i] = aNew;
        if (aNew > 0 && ice[i] === 0) Ti[i] = Math.min(Tf, tAirMean[i]);
        ice[i] = aNew;
        To[i] = Tf + Math.max(0, e) / Co;
        cEff[i] = cA;
      }
    }
    for (let i = 0; i < n; i++) if (land[i]) cEff[i] = cL;
  }

  // Surface (stratified-layer) temperature for the monthly SST and the annual memory.
  if (Cs > 0) for (let i = 0; i < n; i++) if (!land[i] && Es[i] > 0) To[i] += Es[i] * invCs;

  // (4–5) Implicit diffusion of the air column: rows (periodic) then columns. Over cold, snow-covered
  //       land a stable surface layer decouples the ground air from the transient eddies: the
  //       face couplings are scaled by the mean stability factor of the two cells.
  if (t.stableLandDiffusion < 1) {
    const sf = work.stab;
    // Ice sheets keep their own (inversion) factor in kE/kN/kS.
    for (let i = 0; i < n; i++) {
      sf[i] = land[i] ? 1 - (1 - t.stableLandDiffusion) * snowWeight(Tc[i] - lapse[i]) * (1 - glacierWeight(Mass[i])) : 1;
    }
    const { kE, kN, kS } = M;
    const sE = work.kE2, sN = work.kN2, sS = work.kS2;
    for (let j = 0; j < ny; j++) {
      for (let c = 0; c < nx; c++) {
        const i = j * nx + c;
        const e = j * nx + (c === nx - 1 ? 0 : c + 1);
        sE[i] = kE[i] * 0.5 * (sf[i] + sf[e]);
        sN[i] = j > 0 ? kN[i] * 0.5 * (sf[i] + sf[i - nx]) : kN[i];
        sS[i] = j < ny - 1 ? kS[i] * 0.5 * (sf[i] + sf[i + nx]) : kS[i];
      }
    }
    diffuse(M, Tc, cEff, sE, sN, sS);
  } else diffuse(M, Tc, cEff, M.kE, M.kN, M.kS);

  // (6) Annual memory of the surface temperature.
  const rate = 1 / M.stepsPerYear;
  const Tann = S.Tann;
  for (let i = 0; i < n; i++) {
    const ts = land[i] ? Tc[i] - lapse[i] : (1 - ice[i]) * To[i] + ice[i] * Ti[i];
    Tann[i] += (ts - Tann[i]) * rate;
  }
}

/** Backward-Euler diffusion: periodic tridiagonal solve per row, then tridiagonal per column. */
function diffuse(M: EbmModel, Tc: Float64Array, cEff: Float64Array, kE: Float64Array, kN: Float64Array, kS: Float64Array): void {
  diffuseRows(M, Tc, cEff, kE);
  diffuseColumns(M, Tc, cEff, kN, kS);
}

function diffuseRows(M: EbmModel, Tc: Float64Array, cEff: Float64Array, kE: Float64Array): void {
  const { g, dt, work } = M;
  const { nx, ny } = g;
  const { ra, rb, rc, rd, rx, cyc } = work;
  const idt = 1 / dt;
  for (let j = 0; j < ny; j++) {
    const base = j * nx;
    for (let c = 0; c < nx; c++) {
      const i = base + c;
      const kw = kE[c === 0 ? base + nx - 1 : i - 1];
      const ke = kE[i];
      const cd = cEff[i] * idt;
      ra[c] = -kw;
      rc[c] = -ke;
      rb[c] = cd + kw + ke;
      rd[c] = cd * Tc[i];
    }
    solveCyclic(ra, rb, rc, rd, rx, nx, cyc);
    for (let c = 0; c < nx; c++) Tc[base + c] = rx[c];
  }
}

function diffuseColumns(M: EbmModel, Tc: Float64Array, cEff: Float64Array, kN: Float64Array, kS: Float64Array): void {
  const { g, dt, work } = M;
  const { nx, ny } = g;
  const { ca, cb, cc, cd, cx, cp } = work;
  const idt = 1 / dt;
  for (let c = 0; c < nx; c++) {
    for (let j = 0; j < ny; j++) {
      const i = j * nx + c;
      const cdt = cEff[i] * idt;
      ca[j] = -kN[i];
      cc[j] = -kS[i];
      cb[j] = cdt + kN[i] + kS[i];
      cd[j] = cdt * Tc[i];
    }
    solveTridiag(ca, cb, cc, cd, cx, ny, cp);
    for (let j = 0; j < ny; j++) Tc[j * nx + c] = cx[j];
  }
}
