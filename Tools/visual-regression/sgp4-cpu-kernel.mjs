// sgp4-cpu-kernel.mjs — the DEMO/PROBE-owned CPU (FP64) near-earth SGP4 kernel
// that mirrors the WGSL `SGP4_KERNEL_WGSL` (sgp4-kernel.mjs), shaped as a
// `ComputeInstanceCollection` cpuKernel. NOT engine code — this is orbital
// domain math (the engine stays orbital-agnostic; it only runs the kernel and
// RTE-splits the result).
// @purpose Demo/probe-owned CPU FP64 near-earth SGP4 kernel mirroring the WGSL kernel, shaped as a ComputeInstanceCollection cpuKernel (42-lane layout).
// @status ACTIVE
//
// The WebGL2 fallback of ComputeInstanceCollection takes a JS kernel
//   (out, index, timeSeconds, params) => void
// and the engine RTE-splits `out.position`, packs the records, and instanced-
// draws them. This module provides that kernel for the SGP4 param lane layout,
// so the WebGL2 leg lands satellites at the same screen positions the WebGPU
// df64 WGSL kernel produces. probe-compute-instance-webgl2-sgp4.mjs imports it
// (WebGL-vs-WebGPU), and the SGP4 Sandcastle demo carries the SAME algorithm
// inline as its cpuKernel.
//
// It reads the SAME packed param lanes the WGSL kernel reads (the lane layout
// of packSgp4Instance in sgp4-kernel.mjs) and reproduces the TIME-DEPENDENT
// half of SGP4 (sgp4() in sgp4-reference.mjs) operating directly over those
// lanes — secular mean-element update (gravity + drag), long-period (J3)
// periodics, Kepler solve, short-period periodics, and TEME->ECEF by -GMST(t).
// On the CPU all math is FP64; the df64 (hi,lo) rate pairs reconstruct to the
// FP64 rate as hi + lo.
//
// Element lane layout (MUST match SGP4_FLOATS_PER_INSTANCE = 42):
//   0 ecco   1 inclo   2 nodeo   3 argpo   4 mo   5 bstar   6 noUnkozai
//   7 con41  8 x1mth2  9 x7thm1 10 aycof  11 xlcof 12 cc1   13 cc4  14 cc5
//  15 omgcof 16 xmcof 17 eta   18 delmo  19 sinmao 20 t2cof 21 t3cof 22 t4cof
//  23 t5cof 24 d2    25 d3    26 d4    27 isimp 28 nodecf 29 gsto 30 cosio
//  31 sinio 32 mdotHi 33 mdotLo 34 argpdotHi 35 argpdotLo 36 nodedotHi
//  37 nodedotLo  38 r  39 g  40 b  41 pixelSize

export const SGP4_CPU_FLOATS_PER_INSTANCE = 42;

// WGS-72 constants (must match sgp4-reference.mjs / sgp4-kernel.mjs).
const RADIUSEARTHKM = 6378.135;
const MU = 398600.8;
const XKE =
  60.0 / Math.sqrt((RADIUSEARTHKM * RADIUSEARTHKM * RADIUSEARTHKM) / MU);
const J2 = 0.001082616;
const X2O3 = 2.0 / 3.0;
const TWOPI = 2.0 * Math.PI;
// Earth rotation rate (rad/s), reconstructed FP64 from the df64 pair the
// WGSL kernel uses (7.2921159e-5 + -1.60853e-12).
const EARTH_ROT = 7.2921159e-5 + -1.60853e-12;

// Time-dependent SGP4 update from the flat param lanes. Returns the absolute
// ECEF position [x, y, z] in METERS at `timeSeconds` since the catalog epoch.
// This is the FP64 mirror of SGP4_KERNEL_WGSL, line-for-line (the WGSL kernel
// is itself a port of sgp4() from sgp4-reference.mjs).
export function propagateSgp4FromParams(params, base, timeSeconds) {
  const ecco = params[base + 0];
  const inclo = params[base + 1];
  const nodeo = params[base + 2];
  const argpo = params[base + 3];
  const mo = params[base + 4];
  const bstar = params[base + 5];
  const noU = params[base + 6];
  const con41 = params[base + 7];
  const x1mth2 = params[base + 8];
  const x7thm1 = params[base + 9];
  const aycof = params[base + 10];
  const xlcof = params[base + 11];
  const cc1 = params[base + 12];
  const cc4 = params[base + 13];
  const cc5 = params[base + 14];
  const omgcof = params[base + 15];
  const xmcof = params[base + 16];
  const eta = params[base + 17];
  const delmo = params[base + 18];
  const sinmao = params[base + 19];
  const t2cof = params[base + 20];
  const t3cof = params[base + 21];
  const t4cof = params[base + 22];
  const t5cof = params[base + 23];
  const d2 = params[base + 24];
  const d3 = params[base + 25];
  const d4 = params[base + 26];
  const isimp = params[base + 27];
  const nodecf = params[base + 28];
  const gsto = params[base + 29];
  // cosio/sinio (lanes 30/31) are unused in the position-only update, same as
  // the WGSL kernel (it recomputes sin/cos of inclm directly).
  const mdot = params[base + 32] + params[base + 33]; // df64 hi+lo
  const argpdot = params[base + 34] + params[base + 35];
  const nodedot = params[base + 36] + params[base + 37];

  const tsince = timeSeconds / 60.0; // engine passes SECONDS; SGP4 uses minutes

  // ── Secular update of mean elements (gravity + drag) ──
  const xmdf = mo + mdot * tsince;
  const argpdf = argpo + argpdot * tsince;
  const nodedf = nodeo + nodedot * tsince;
  const t2 = tsince * tsince;
  const nodem = nodedf + nodecf * t2;

  let argpm = argpdf;
  let mm = xmdf;
  let tempa = 1.0 - cc1 * tsince;
  let tempe = bstar * cc4 * tsince;
  let templ = t2cof * t2;

  if (isimp < 0.5) {
    const delomg = omgcof * tsince;
    const dmtemp = 1.0 + eta * Math.cos(xmdf);
    const delm = xmcof * (dmtemp * dmtemp * dmtemp - delmo);
    const tempd = delomg + delm;
    mm = xmdf + tempd;
    argpm = argpdf - tempd;
    const t3 = t2 * tsince;
    const t4 = t3 * tsince;
    tempa = tempa - d2 * t2 - d3 * t3 - d4 * t4;
    tempe = tempe + bstar * cc5 * (Math.sin(mm) - sinmao);
    templ = templ + t3cof * t3 + t4 * (t4cof + tsince * t5cof);
  }

  const nm = noU;
  let em = ecco - tempe;
  const inclm = inclo;
  const am = Math.pow(XKE / nm, X2O3) * tempa * tempa;
  if (em < 1.0e-6) {
    em = 1.0e-6;
  }

  mm = mm + noU * templ;
  // Reduce angles to [-pi, pi] / [0, 2pi) matching the WGSL kernel's reduction
  // (the node uses the df64 reducePi -> [-pi, pi]; argpm/xlm use floor-based
  // mod to [0, 2pi)). Reproduce with FP64 here.
  const nodemRed = reduceToPi(nodem);
  let xlm = mm + argpm + nodemRed;
  argpm = argpm - TWOPI * Math.floor(argpm / TWOPI);
  xlm = xlm - TWOPI * Math.floor(xlm / TWOPI);
  mm = xlm - argpm - nodemRed;

  // ── Long-period (J3) periodics ──
  const sinim = Math.sin(inclm);
  const cosim = Math.cos(inclm);
  const ep = em;
  const xincp = inclm;
  const argpp = argpm;
  const nodep = nodemRed;
  const mp = mm;
  const sinip = sinim;
  const cosip = cosim;

  const axnl = ep * Math.cos(argpp);
  const tempLP = 1.0 / (am * (1.0 - ep * ep));
  const aynl = ep * Math.sin(argpp) + tempLP * aycof;
  const xl = mp + argpp + nodep + tempLP * xlcof * axnl;

  // ── Kepler solve for (E + omega) ──
  let u = xl - nodep;
  u = u - TWOPI * Math.floor(u / TWOPI);
  let eo1 = u;
  let tem5 = 9999.9;
  let sineo1 = 0.0;
  let coseo1 = 0.0;
  let ktr = 0;
  while (Math.abs(tem5) >= 1.0e-12 && ktr < 10) {
    sineo1 = Math.sin(eo1);
    coseo1 = Math.cos(eo1);
    tem5 = 1.0 - coseo1 * axnl - sineo1 * aynl;
    tem5 = (u - aynl * coseo1 + axnl * sineo1 - eo1) / tem5;
    let t5 = tem5;
    if (Math.abs(t5) >= 0.95) {
      t5 = t5 > 0.0 ? 0.95 : -0.95;
    }
    eo1 = eo1 + t5;
    ktr = ktr + 1;
  }

  // ── Short-period periodics -> position ──
  const ecose = axnl * coseo1 + aynl * sineo1;
  const esine = axnl * sineo1 - aynl * coseo1;
  const el2 = axnl * axnl + aynl * aynl;
  const pl = am * (1.0 - el2);
  const rl = am * (1.0 - ecose);
  const betal = Math.sqrt(1.0 - el2);
  const tempSU = esine / (1.0 + betal);
  const sinu = (am / rl) * (sineo1 - aynl - axnl * tempSU);
  const cosu = (am / rl) * (coseo1 - axnl + aynl * tempSU);
  let su = Math.atan2(sinu, cosu);
  const sin2u = (cosu + cosu) * sinu;
  const cos2u = 1.0 - 2.0 * sinu * sinu;
  const tempB = 1.0 / pl;
  const temp1 = 0.5 * J2 * tempB;
  const temp2 = temp1 * tempB;

  const mrt =
    rl * (1.0 - 1.5 * temp2 * betal * con41) + 0.5 * temp1 * x1mth2 * cos2u;
  su = su - 0.25 * temp2 * x7thm1 * sin2u;
  const xnode = nodep + 1.5 * temp2 * cosip * sin2u;
  const xinc = xincp + 1.5 * temp2 * cosip * sinip * cos2u;

  // ── Orientation vectors -> TEME position (km) ──
  const sinsu = Math.sin(su);
  const cossu = Math.cos(su);
  const snod = Math.sin(xnode);
  const cnod = Math.cos(xnode);
  const sini = Math.sin(xinc);
  const cosi = Math.cos(xinc);
  const ux = -snod * cosi * sinsu + cnod * cossu;
  const uy = cnod * cosi * sinsu + snod * cossu;
  const uz = sini * sinsu;
  const rkm = mrt * RADIUSEARTHKM;
  const xTeme = rkm * ux;
  const yTeme = rkm * uy;
  const zTeme = rkm * uz;

  // ── TEME -> ECEF: rotate by -GMST(t) about +Z; * 1000 -> meters ──
  // GMST(t) = gsto + omega_earth * (tsince minutes * 60 s).
  const gmst = gsto + EARTH_ROT * 60.0 * tsince;
  const cg = Math.cos(gmst);
  const sg = Math.sin(gmst);
  const xEcef = (cg * xTeme + sg * yTeme) * 1000.0;
  const yEcef = (-sg * xTeme + cg * yTeme) * 1000.0;
  const zEcef = zTeme * 1000.0;
  return [xEcef, yEcef, zEcef];
}

// Reduce an angle to [-pi, pi] (mirrors the WGSL csm_df64_reducePi outcome).
function reduceToPi(angle) {
  let r = angle - TWOPI * Math.round(angle / TWOPI);
  if (r > Math.PI) {
    r -= TWOPI;
  } else if (r < -Math.PI) {
    r += TWOPI;
  }
  return r;
}

// The ComputeInstanceCollection cpuKernel shape: writes out.position
// ({x,y,z} ECEF m), out.color ({red,green,blue,alpha} in [0,1]) and
// out.pixelSize (px). `out` is a reused scratch object — write every field.
export function cpuKernelSgp4(out, index, timeSeconds, params) {
  const base = index * SGP4_CPU_FLOATS_PER_INSTANCE;
  const pos = propagateSgp4FromParams(params, base, timeSeconds);
  out.position.x = pos[0];
  out.position.y = pos[1];
  out.position.z = pos[2];
  out.color.red = params[base + 38];
  out.color.green = params[base + 39];
  out.color.blue = params[base + 40];
  out.color.alpha = 1.0;
  out.pixelSize = params[base + 41];
}
