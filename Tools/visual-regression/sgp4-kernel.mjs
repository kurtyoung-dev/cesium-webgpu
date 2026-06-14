// sgp4-kernel.mjs — the demo/probe-owned SGP4 artifacts that ride the
// engine's feature-agnostic ComputeInstanceCollection. Two exports:
//
//   SGP4_FLOATS_PER_INSTANCE  — the param lane count (demo-owned layout)
//   packSgp4Instance(satrec, color, pixelSize)
//                             — turn one CPU-FP64 sgp4init() result into the
//                               flat f32 param lanes the GPU kernel reads.
//                               The PRECISION-CRITICAL secular rates are
//                               uploaded as df64 (hi,lo) pairs.
//   SGP4_KERNEL_WGSL          — the GPU df64 kernel string (the TIME-DEPENDENT
//                               half of SGP4; ported 1:1 from sgp4() in
//                               sgp4-reference.mjs). Composes with
//                               ComputeInstanceScaffold.wgsl exactly like the
//                               J2 demo kernel.
//
// SGP4 stage guardrails honored here:
//   - FP64 mean-element PRE-CONDITIONING is done on the CPU (sgp4init in
//     sgp4-reference.mjs); the GPU does ONLY the per-frame time update.
//   - NEAR-EARTH ONLY: deep-space objects (period >= 225 min) are flagged by
//     sgp4init and the demo SKIPS them (does not upload). The kernel never
//     sees a deep-space object, so it never produces a silently-wrong result.
//   - The secular rates (mdot/argpdot/nodedot) + the GMST advance keep df64
//     precision so a full-day propagation does not lose angular resolution to
//     f32 rounding of `rate * tsince`.

// WGS-72 constants the kernel needs (must match sgp4-reference.mjs).
const RADIUSEARTHKM = 6378.135;
const MU = 398600.8;
const XKE = 60.0 / Math.sqrt((RADIUSEARTHKM * RADIUSEARTHKM * RADIUSEARTHKM) / MU);
const J2 = 0.001082616;
const X2O3 = 2.0 / 3.0;

// Earth rotation rate (rad/s) as a df64 pair (hi, lo) for the GMST advance.
// 7.2921159e-5 rad/s in df64.
const EARTH_ROT_HI = 7.2921159e-5;
const EARTH_ROT_LO = -1.60853e-12;

// ── Param lane layout (DEMO-owned; the engine never sees it) ──
// All values are the FP64 sgp4init() constants, downcast to f32 EXCEPT the
// three secular rates + mDot, which ship as df64 (hi,lo) pairs. `tsince` (the
// GPU `time` scalar) is MINUTES since the catalog epoch.
//
//  0 ecco            1 inclo           2 nodeo           3 argpo
//  4 mo             5 bstar           6 noUnkozai       7 con41
//  8 x1mth2         9 x7thm1         10 aycof          11 xlcof
// 12 cc1           13 cc4            14 cc5            15 omgcof
// 16 xmcof         17 eta            18 delmo          19 sinmao
// 20 t2cof         21 t3cof          22 t4cof          23 t5cof
// 24 d2            25 d3             26 d4             27 isimp(0/1)
// 28 nodecf        29 gsto           30 cosio          31 sinio
// 32 mdotHi        33 mdotLo         34 argpdotHi      35 argpdotLo
// 36 nodedotHi     37 nodedotLo
// 38 r             39 g              40 b              41 pixelSize
export const SGP4_FLOATS_PER_INSTANCE = 42;

function df64Split(x) {
  const hi = Math.fround(x);
  return [hi, x - hi];
}

export function packSgp4Instance(s, color, pixelSize) {
  const [mdotHi, mdotLo] = df64Split(s.mdot);
  const [argpdotHi, argpdotLo] = df64Split(s.argpdot);
  const [nodedotHi, nodedotLo] = df64Split(s.nodedot);
  return [
    s.ecco,
    s.inclo,
    s.nodeo,
    s.argpo,
    s.mo,
    s.bstar,
    s.noUnkozai,
    s.con41,
    s.x1mth2,
    s.x7thm1,
    s.aycof,
    s.xlcof,
    s.cc1,
    s.cc4,
    s.cc5,
    s.omgcof,
    s.xmcof,
    s.eta,
    s.delmo,
    s.sinmao,
    s.t2cof,
    s.t3cof,
    s.t4cof,
    s.t5cof,
    s.d2,
    s.d3,
    s.d4,
    s.isimp,
    s.nodecf,
    s.gsto,
    s.cosio,
    s.sinio,
    mdotHi,
    mdotLo,
    argpdotHi,
    argpdotLo,
    nodedotHi,
    nodedotLo,
    color[0],
    color[1],
    color[2],
    pixelSize,
  ];
}

// ── The GPU df64 SGP4 update kernel (time-dependent half of SGP4) ──
// `time` is SECONDS since epoch — the engine's ComputeInstanceCollection
// contract (frameState.time − epoch, in seconds). SGP4 works in minutes, so
// the kernel converts `tsince = time / 60` up front; this keeps the demo and
// probe kernels byte-identical and matched to the engine's time source.
// The kernel reproduces sgp4() from sgp4-reference.mjs: secular mean-element update
// (gravity + drag), long-period (J3) periodics, Kepler solve, short-period
// periodics, and TEME->ECEF by -GMST(t). The precision-sensitive secular
// angle accumulation uses df64 (the rates arrive as df64 pairs); the rest is
// f32 (it operates on reduced/small quantities that fit f32 comfortably).
export const SGP4_KERNEL_WGSL = `
  // WGS-72 constants (match sgp4-reference.mjs).
  const SGP4_XKE: f32 = ${XKE};
  const SGP4_J2: f32 = ${J2};
  const SGP4_X2O3: f32 = ${X2O3};
  const SGP4_RE_KM: f32 = ${RADIUSEARTHKM};
  const SGP4_TWOPI: f32 = 6.2831853071795864;
  // Earth rotation rate (rad/s) as df64 for the GMST advance; * 60 -> rad/min.
  const SGP4_EARTH_ROT: vec2<f32> = vec2<f32>(${EARTH_ROT_HI}, ${EARTH_ROT_LO});

  fn csm_computeInstance(index: u32, time: f32) -> ComputeInstanceOut {
    let base = index * FLOATS_PER_INSTANCE;
    let ecco   = params[base + 0u];
    let inclo  = params[base + 1u];
    let nodeo  = params[base + 2u];
    let argpo  = params[base + 3u];
    let mo     = params[base + 4u];
    let bstar  = params[base + 5u];
    let noU    = params[base + 6u];
    let con41  = params[base + 7u];
    let x1mth2 = params[base + 8u];
    let x7thm1 = params[base + 9u];
    let aycof  = params[base + 10u];
    let xlcof  = params[base + 11u];
    let cc1    = params[base + 12u];
    let cc4    = params[base + 13u];
    let cc5    = params[base + 14u];
    let omgcof = params[base + 15u];
    let xmcof  = params[base + 16u];
    let eta    = params[base + 17u];
    let delmo  = params[base + 18u];
    let sinmao = params[base + 19u];
    let t2cof  = params[base + 20u];
    let t3cof  = params[base + 21u];
    let t4cof  = params[base + 22u];
    let t5cof  = params[base + 23u];
    let d2     = params[base + 24u];
    let d3     = params[base + 25u];
    let d4     = params[base + 26u];
    let isimp  = params[base + 27u];
    let nodecf = params[base + 28u];
    let gsto   = params[base + 29u];
    let cosio  = params[base + 30u];
    let sinio  = params[base + 31u];
    let mdot     = vec2<f32>(params[base + 32u], params[base + 33u]); // df64
    let argpdot  = vec2<f32>(params[base + 34u], params[base + 35u]); // df64
    let nodedot  = vec2<f32>(params[base + 36u], params[base + 37u]); // df64

    let tsince = time / 60.0; // engine passes SECONDS; SGP4 works in minutes

    // ── Secular update (df64 angle accumulation for the fast/precise terms) ──
    // xmdf = mo + mdot*t ; argpdf = argpo + argpdot*t ; nodedf = nodeo + nodedot*t.
    let xmdf64    = csm_df64_add_f32(csm_df64_mul_f32(mdot, tsince), mo);
    let argpdf64  = csm_df64_add_f32(csm_df64_mul_f32(argpdot, tsince), argpo);
    let nodedf64  = csm_df64_add_f32(csm_df64_mul_f32(nodedot, tsince), nodeo);
    let xmdf   = xmdf64.x + xmdf64.y;
    let argpdf = argpdf64.x + argpdf64.y;

    let t2 = tsince * tsince;
    // nodem = nodedf + nodecf*t^2 (in df64 so the node keeps precision too).
    let nodem64 = csm_df64_add_f32(nodedf64, nodecf * t2);

    var argpm = argpdf;
    var mm = xmdf;
    var tempa = 1.0 - cc1 * tsince;
    var tempe = bstar * cc4 * tsince;
    var templ = t2cof * t2;

    if (isimp < 0.5) {
      let delomg = omgcof * tsince;
      let dmtemp = 1.0 + eta * cos(xmdf);
      let delm = xmcof * (dmtemp * dmtemp * dmtemp - delmo);
      let tempd = delomg + delm;
      mm = xmdf + tempd;
      argpm = argpdf - tempd;
      let t3 = t2 * tsince;
      let t4 = t3 * tsince;
      tempa = tempa - d2 * t2 - d3 * t3 - d4 * t4;
      tempe = tempe + bstar * cc5 * (sin(mm) - sinmao);
      templ = templ + t3cof * t3 + t4 * (t4cof + tsince * t5cof);
    }

    let nm = noU;
    var em = ecco - tempe;
    let inclm = inclo;
    let am = pow(SGP4_XKE / nm, SGP4_X2O3) * tempa * tempa;
    if (em < 1.0e-6) { em = 1.0e-6; }

    mm = mm + noU * templ;
    // Reduce angles to [0, 2pi) — do it in df64 for the node (large over a day),
    // f32 is fine for argpm/mm after the reductions.
    let nodemRed = csm_df64_reducePi(nodem64).x;
    var xlm = mm + argpm + nodemRed;
    argpm = argpm - SGP4_TWOPI * floor(argpm / SGP4_TWOPI);
    xlm = xlm - SGP4_TWOPI * floor(xlm / SGP4_TWOPI);
    mm = xlm - argpm - nodemRed;

    // ── Long-period (J3) periodics ──
    let sinim = sin(inclm);
    let cosim = cos(inclm);
    let ep = em;
    let xincp = inclm;
    let argpp = argpm;
    let nodep = nodemRed;
    let mp = mm;
    let sinip = sinim;
    let cosip = cosim;

    let axnl = ep * cos(argpp);
    let tempLP = 1.0 / (am * (1.0 - ep * ep));
    let aynl = ep * sin(argpp) + tempLP * aycof;
    let xl = mp + argpp + nodep + tempLP * xlcof * axnl;

    // ── Kepler solve for (E + omega) ──
    var u = (xl - nodep);
    u = u - SGP4_TWOPI * floor(u / SGP4_TWOPI);
    var eo1 = u;
    var tem5 = 9999.9;
    var sineo1 = 0.0;
    var coseo1 = 0.0;
    var ktr = 0;
    loop {
      if (abs(tem5) < 1.0e-12 || ktr >= 10) { break; }
      sineo1 = sin(eo1);
      coseo1 = cos(eo1);
      tem5 = 1.0 - coseo1 * axnl - sineo1 * aynl;
      tem5 = (u - aynl * coseo1 + axnl * sineo1 - eo1) / tem5;
      var t5 = tem5;
      if (abs(t5) >= 0.95) {
        if (t5 > 0.0) { t5 = 0.95; } else { t5 = -0.95; }
      }
      eo1 = eo1 + t5;
      ktr = ktr + 1;
    }

    // ── Short-period periodics -> position ──
    let ecose = axnl * coseo1 + aynl * sineo1;
    let esine = axnl * sineo1 - aynl * coseo1;
    let el2 = axnl * axnl + aynl * aynl;
    let pl = am * (1.0 - el2);
    let rl = am * (1.0 - ecose);
    let betal = sqrt(1.0 - el2);
    let tempSU = esine / (1.0 + betal);
    let sinu = (am / rl) * (sineo1 - aynl - axnl * tempSU);
    let cosu = (am / rl) * (coseo1 - axnl + aynl * tempSU);
    var su = atan2(sinu, cosu);
    let sin2u = (cosu + cosu) * sinu;
    let cos2u = 1.0 - 2.0 * sinu * sinu;
    let tempB = 1.0 / pl;
    let temp1 = 0.5 * SGP4_J2 * tempB;
    let temp2 = temp1 * tempB;

    let mrt = rl * (1.0 - 1.5 * temp2 * betal * con41) + 0.5 * temp1 * x1mth2 * cos2u;
    su = su - 0.25 * temp2 * x7thm1 * sin2u;
    let xnode = nodep + 1.5 * temp2 * cosip * sin2u;
    let xinc = xincp + 1.5 * temp2 * cosip * sinip * cos2u;

    // ── Orientation vectors -> TEME position (km) ──
    let sinsu = sin(su);
    let cossu = cos(su);
    let snod = sin(xnode);
    let cnod = cos(xnode);
    let sini = sin(xinc);
    let cosi = cos(xinc);
    let xmx = -snod * cosi;
    let xmy = cnod * cosi;
    let ux = xmx * sinsu + cnod * cossu;
    let uy = xmy * sinsu + snod * cossu;
    let uz = sini * sinsu;
    let rkm = mrt * SGP4_RE_KM;
    let xTeme = rkm * ux; // km
    let yTeme = rkm * uy;
    let zTeme = rkm * uz;

    // ── TEME -> ECEF: rotate by -GMST(t) about +Z, in df64 ──
    // GMST(t) = gsto + omega_earth * (t minutes * 60 s) = gsto + (EARTH_ROT*60)*t.
    let gmst64 = csm_df64_add_f32(
      csm_df64_mul_f32(csm_df64_mul_f32(SGP4_EARTH_ROT, 60.0), tsince), gsto);
    let cg = csm_df64_cos(gmst64);
    let sg = csm_df64_sin(gmst64);

    // ECEF (meters) built component-wise in df64 so the RTE low part is real.
    // x_ecef = ( cg*xTeme + sg*yTeme) * 1000
    // y_ecef = (-sg*xTeme + cg*yTeme) * 1000
    let xEcefKm = csm_df64_add(csm_df64_mul_f32(csm_df64(cg), xTeme),
                               csm_df64_mul_f32(csm_df64(sg), yTeme));
    let yEcefKm = csm_df64_add(csm_df64_mul_f32(csm_df64(-sg), xTeme),
                               csm_df64_mul_f32(csm_df64(cg), yTeme));
    let zEcefKm = csm_df64(zTeme);
    let xEcef = csm_df64_mul_f32(xEcefKm, 1000.0);
    let yEcef = csm_df64_mul_f32(yEcefKm, 1000.0);
    let zEcef = csm_df64_mul_f32(zEcefKm, 1000.0);

    var out = csm_emitDF64(xEcef, yEcef, zEcef);
    out.color = vec4<f32>(params[base + 38u], params[base + 39u], params[base + 40u], 1.0);
    out.pixelSize = params[base + 41u];
    return out;
  }`;
