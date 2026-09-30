/**
 * Time stepping of the coupled energy-balance model (energy.ts): one ~5-day operator-split,
 * backward-Euler step and the yearly driver with monthly averaging.
 */
import { applyStencil } from './dynAdvect';
import {
  iceFraction, iceSheetWeight, snowCoverFactor, snowWeight,
  type EbmCoupling, type EbmModel, type EbmMonthly, type EbmState,
} from './energy';
import { solveCyclic, solveTridiag } from './numerics';
import { ebmTuning } from './tuning';

/**
 * Integrate one model year (stepsPerYear steps) from `S` in place. When `out` is given, monthly
 * means of this year are written into it.
 */
export function integrateYear(M: EbmModel, S: EbmState, cp: EbmCoupling, out: EbmMonthly | null): void {
  const n = M.g.n;
  if (out) {
    out.tAir.fill(0);
    out.sst.fill(0);
    out.ice.fill(0);
  }
  const inv = 1 / M.stepsPerMonth;
  for (let k = 0; k < M.stepsPerYear; k++) {
    step(M, S, cp, k);
    if (!out) continue;
    const o = Math.floor(k / M.stepsPerMonth) * n;
    const { To, ice } = M.work;
    for (let i = 0; i < n; i++) {
      out.tAir[o + i] += S.T[i] * inv;
      out.sst[o + i] += To[i] * inv;
      out.ice[o + i] += ice[i] * inv;
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
  const Tc = S.T, E = S.E, Ti = S.Ti;
  const { F, dep, To, tAirMean, cEff, ice } = work;
  const qOff = k * ny;

  // (0) Land forcing with snow albedo lagged from the previous step (plus the free-troposphere
  //     coupling of high terrain toward the row-mean air temperature); ocean surface state.
  const ft = M.freeTrop;
  const albOff = cp.landAlbedoOffset;
  const aOff = month * n;
  for (let j = 0; j < ny; j++) {
    const Q = M.insol[qOff + j];
    const aL = albLand[j];
    const Co = cOcean[j];
    let rowMean = 0;
    for (let c = 0; c < nx; c++) rowMean += Tc[j * nx + c];
    rowMean /= nx;
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      if (land[i]) {
        const a0 = albOff ? aL + albOff[aOff + i] : aL;
        const aSnow = aIce + (t.albedoIceSheet - aIce) * iceSheetWeight(S.Tann[i]);
        const alb = a0 + (aSnow - a0) * snowWeight(Tc[i] - lapse[i]) * snowCoverFactor(S.Tann[i], lapse[i]);
        F[i] = Q * (1 - alb) - A + B * lapse[i] + ft[i] * rowMean;
        To[i] = 0;
        ice[i] = 0;
      } else {
        ice[i] = iceFraction(E[i], eFull);
        To[i] = Tf + Math.max(0, E[i]) / Co;
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
        Tc[i] = (cdL * (Tc[i] + d) + F[i]) / (cdL + B + ft[i]);
      } else {
        const a = ice[i];
        const tsf = (1 - a) * To[i] + a * Ti[i];
        const ta = (cdA * src[i] + gam * tsf) / (cdA + gam);
        Tc[i] = ta;
        tAirMean[i] += ta / nSub;
      }
    }
  }

  // (2) Mixed-layer heat advection by currents (pass 2).
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
  const aMelt = t.albedoSeaIceMelt;
  const tConv = t.convectiveCapT;
  const kConv = t.convectiveDamping;
  const rampI = 1 / (t.seaIceRampWarm - t.seaIceRampCold);
  for (let j = 0; j < ny; j++) {
    const Q = M.insol[qOff + j];
    const Co = cOcean[j];
    const cdo = Co / dt;
    const cdi = cI / dt;
    const saW = Q * (1 - albWater[j]);
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      if (land[i]) {
        cEff[i] = cL;
        continue;
      }
      cEff[i] = cA;
      const lu = upw ? upw[uOff + i] : 0;
      const ts = tSub ? tSub[i] : Tf;
      const ta = tAirMean[i];
      let e = E[i];
      let ti = Ti[i];
      if (e >= 0) {
        const to = Tf + e / Co;
        let toNew = (cdo * to + saW - A + lu * ts + gam * ta) / (cdo + B + lu + gam);
        // Convective thermostat: deep convection sheds heat steeply above ~28 °C.
        if (toNew > tConv) toNew = (cdo * to + saW - A + lu * ts + gam * ta + kConv * tConv) / (cdo + B + lu + gam + kConv);
        e = Co * (toNew - Tf);
        if (e < 0) ti = Math.min(Tf, ta);
      } else {
        const a = Math.min(1, -e / eFull);
        const hi = Math.max(hFull, -e / Lf);
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
        // Net flux into the ocean enthalpy from the ice part and from the open water at T_f.
        const G = melt - K * (Tf - tiNew);
        const Fw = saW - A - B * Tf + lu * (ts - Tf) + gam * (ta - Tf);
        if (a < 1) {
          const den = 1 + (dt * (G - Fw)) / eFull;
          e = den > 0.3 ? (e + dt * Fw) / den : e + dt * (Fw + a * (G - Fw));
        } else {
          e += dt * G;
        }
        ti = tiNew;
      }
      if (e < -eMax) e = -eMax;
      const aNew = iceFraction(e, eFull);
      if (aNew > 0 && ice[i] === 0) ti = Math.min(Tf, ta);
      E[i] = e;
      Ti[i] = ti;
      To[i] = Tf + Math.max(0, e) / Co;
      ice[i] = aNew;
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
        E[i] = e;
        const aNew = iceFraction(e, eFull);
        if (aNew > 0 && ice[i] === 0) Ti[i] = Math.min(Tf, tAirMean[i]);
        ice[i] = aNew;
        To[i] = Tf + Math.max(0, e) / Co;
        cEff[i] = cA;
      }
    }
    for (let i = 0; i < n; i++) if (land[i]) cEff[i] = cL;
  }

  // (4–5) Implicit diffusion of the air column: rows (periodic) then columns.
  diffuse(M, Tc, cEff, M.kE, M.kN, M.kS);

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
