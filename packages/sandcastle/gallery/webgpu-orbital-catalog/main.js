import * as Cesium from "cesium";

// Backend is selectable via ?renderer= (default webgpu) so a user can
// exercise the WebGL2 CPU-kernel fallback (cpuKernel below) straight
// from the demo — on WebGL2 the engine runs the JS kernel each frame
// instead of the WGSL compute kernel.
const requestedRenderer =
  new URLSearchParams(window.location.search).get("renderer") || "webgpu";
const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: requestedRenderer },
  shouldAnimate: true,
});
const scene = viewer.scene;

// ── Orbital element layout (DEMO-owned — the engine never sees it) ──
// A real secular-J2 mean-element set (Batch 277 upgrade from the
// Batch-231 circular MVP). All angles are at epoch.
// Lane 0: semiMajorAxis a (m)   Lane 1: eccentricity e
// Lane 2: inclination (rad)     Lane 3: RAAN at epoch (rad)
// Lane 4: argPerigee at epoch   Lane 5: meanAnomaly at epoch (rad)
// Lane 6: mDotHi  Lane 7: mDotLo — the J2-corrected mean-anomaly
//   secular rate (rad/s), computed in JS FP64 and DOUBLE-SINGLE
//   SPLIT into a df64 pair. This is what makes df64 win: the rate
//   itself carries ~46-bit precision into the GPU, so accumulating
//   M0 + mDot*t over a long span (large t) does not lose angular
//   resolution to f32 rounding of the rate.
// Lane 8: GMST at epoch (rad)
// Lane 9-11: color r, g, b      Lane 12: pixelSize (px)
const FLOATS_PER_INSTANCE = 13;

// ── Physical constants (WGS-84 / IERS) ──
// Earth gravitational parameter (m^3/s^2), equatorial radius (m),
// J2 zonal coefficient, Earth rotation rate (rad/s).
const GM = 3.986004418e14;
const EARTH_RADIUS = 6.378137e6;
const J2 = 1.08263e-3;
const EARTH_ROTATION_RATE = 7.2921159e-5;

// Secular-J2 mean-element propagator with Earth rotation (GMST), the
// real-orbit upgrade from the circular MVP. WGSL kernel — DEMO-owned
// content; the engine has zero orbital knowledge.
//
// What it does, per object, every frame, on the GPU:
//   1. Advance the three secularly-precessing angles by their J2
//      rates over the elapsed time t: mean anomaly M, RAAN Omega,
//      argument of perigee omega. The M and GMST accumulations
//      (M0 + Mdot*t, gmst0 + omega_earth*t) use the engine's df64
//      (two-float, ~46-bit) helpers, AND the precision-critical
//      mean-anomaly rate Mdot arrives as a df64 pair (computed in JS
//      FP64) — so both the rate and the M0+Mdot*t accumulation keep
//      full precision instead of losing it to f32 over a long span.
//      (RAAN/argp drift only a few rad over the span, so their rates
//      stay f32; only the fast M and GMST terms need df64.)
//   2. Solve Kepler's equation M = E - e*sin(E) for the eccentric
//      anomaly E (Newton, 4 iterations — ample for LEO/MEO/GEO e).
//   3. Eccentric -> true anomaly nu, radius r = a(1 - e*cos E).
//   4. Perifocal (r in the orbit plane) -> ECI via the 3-1-3 rotation
//      Rz(Omega) Rx(inc) Rz(omega).
//   5. ECI -> ECEF by rotating about +Z by -GMST(t), so RAAN is a
//      true inertial node and the catalog co-rotates with the globe.
//   6. Build the ECEF position component-wise in df64 and emit via
//      csm_emitDF64, so the RTE low part carries real precision
//      (the f32 "low = 0" limitation is gone for this kernel).
//
// Accuracy: matches a CPU FP64 reference to < ~1 km at LEO over an
// orbit (probe-orbital-j2.mjs), vs the kilometers the f32-circular
// MVP drifts. Still a SECULAR mean-element model (no short-period
// J2 terms, no drag) — good for catalog visualization, not for
// conjunction screening.
const orbitalKernel = `
  fn csm_computeInstance(index: u32, time: f32) -> ComputeInstanceOut {
    let base = index * FLOATS_PER_INSTANCE;
    let a      = params[base + 0u];
    let e      = params[base + 1u];
    let inc    = params[base + 2u];
    let raan0  = params[base + 3u];
    let argp0  = params[base + 4u];
    let m0     = params[base + 5u];
    let mDot   = vec2<f32>(params[base + 6u], params[base + 7u]); // df64
    let gmst0  = params[base + 8u];

    // ── Secular J2 rates for the SLOW angles (RAAN, argp) ──
    // p = a(1-e^2); factor = 1.5 J2 (Re/p)^2 n, with n the UNPERTURBED
    // mean motion sqrt(GM/a^3) (NOT the J2-corrected mDot — using
    // mDot here biases the apsidal/nodal drift by ~6 km/orbit at LEO).
    // These angles drift only a few rad over the span, so f32 is
    // plenty; the FAST angles (M, GMST) get df64 below.
    let n = sqrt(${GM} / (a * a * a));
    let ome2 = max(1.0 - e * e, 1.0e-6);
    let p = a * ome2;
    let reOverP = ${EARTH_RADIUS} / p;
    let factor = 1.5 * ${J2} * reOverP * reOverP * n;
    let ci = cos(inc);
    let si = sin(inc);
    let si2 = si * si;

    let raanDot = -factor * ci;                       // nodal regression
    let argpDot = factor * (2.0 - 2.5 * si2);         // apsidal rotation

    // ── df64 angle accumulation (the precision-sensitive part) ──
    // M(t) = M0 + mDot*t: mDot is a df64 pair and t (an exact-integer
    // f32 here) multiplies it in df64, so the huge mod-2pi angle keeps
    // ~46-bit precision. GMST likewise with a df64 Earth-rotation rate.
    // EARTH_ROTATION_RATE split to df64: (hi, lo).
    let EARTH_ROT = vec2<f32>(7.2921159e-5, -1.6085300e-12);
    let M    = csm_df64_add_f32(csm_df64_mul_f32(mDot, time), m0);
    let raan = raan0 + raanDot * time;                // small rate; f32 fine
    let argp = argp0 + argpDot * time;
    let gmst = csm_df64_add_f32(csm_df64_mul_f32(EARTH_ROT, time), gmst0);

    // ── Kepler: solve M = E - e sin E for E (Newton) ──
    let Mhi = csm_df64_reducePi(M).x;                 // E iterates in f32 near M
    var E = Mhi;
    for (var k = 0; k < 4; k = k + 1) {
      let f = E - e * sin(E) - Mhi;
      let fp = 1.0 - e * cos(E);
      E = E - f / fp;
    }
    let cosE = cos(E);
    let sinE = sin(E);
    let r = a * (1.0 - e * cosE);

    // True anomaly nu from E.
    let beta = sqrt(max(1.0 - e * e, 0.0));
    let nu = atan2(beta * sinE, cosE - e);

    // ── Perifocal position (orbit plane), magnitude r ──
    let u = nu + argp;                                // argument of latitude
    let cu = cos(u);
    let su = sin(u);
    let co = cos(raan);
    let so = sin(raan);

    // ECI = Rz(raan) Rx(inc) Rz(argp) * (r,0,0)_perifocal, collapsed:
    //   x = r ( cu cosO - su ci sinO )
    //   y = r ( cu sinO + su ci cosO )
    //   z = r ( su si )
    let xEci = r * (cu * co - su * ci * so);
    let yEci = r * (cu * so + su * ci * co);
    let zEci = r * (su * si);

    // ── ECI -> ECEF: rotate by -GMST about +Z (df64 sin/cos) ──
    let cg = csm_df64_cos(gmst);
    let sg = csm_df64_sin(gmst);
    //   x_ecef =  x cosG + y sinG
    //   y_ecef = -x sinG + y cosG
    // Each ECEF component built as a df64 sum of two products so the
    // RTE low part is meaningful.
    let xEcef = csm_df64_add(csm_df64_mul_f32(csm_df64(cg), xEci),
                             csm_df64_mul_f32(csm_df64(sg), yEci));
    let yEcef = csm_df64_add(csm_df64_mul_f32(csm_df64(-sg), xEci),
                             csm_df64_mul_f32(csm_df64(cg), yEci));
    let zEcef = csm_df64(zEci);

    var out = csm_emitDF64(xEcef, yEcef, zEcef);
    out.color = vec4<f32>(params[base + 9u], params[base + 10u], params[base + 11u], 1.0);
    out.pixelSize = params[base + 12u];
    return out;
  }`;

// ── WebGL2 CPU fallback kernel (NEW-COMPUTE-INSTANCE-WEBGL2-FALLBACK) ──
// WebGL2 has no compute shaders, so the WGSL `orbitalKernel` above
// cannot run there. This JS kernel is the SAME secular-J2 propagation
// expressed for the CPU; on a WebGL2 context the engine runs it over
// all objects each frame, RTE-splits the positions, and instanced-draws
// them — landing satellites at the same screen positions as the WebGPU
// leg. On WebGPU this is ignored (the GPU kernel runs instead). The two
// kernels share the element lane layout by THIS demo's contract; the
// engine never transpiles WGSL.
function reduceToPi(angle) {
  const twoPi = 2.0 * Math.PI;
  let r = angle - twoPi * Math.round(angle / twoPi);
  if (r > Math.PI) {
    r -= twoPi;
  } else if (r < -Math.PI) {
    r += twoPi;
  }
  return r;
}
function orbitalCpuKernel(out, index, timeSeconds, params) {
  const base = index * FLOATS_PER_INSTANCE;
  const a = params[base + 0];
  const e = params[base + 1];
  const inc = params[base + 2];
  const raan0 = params[base + 3];
  const argp0 = params[base + 4];
  const m0 = params[base + 5];
  const mDot = params[base + 6] + params[base + 7]; // df64 hi+lo
  const gmst0 = params[base + 8];

  const n = Math.sqrt(GM / (a * a * a));
  const ome2 = Math.max(1.0 - e * e, 1.0e-6);
  const p = a * ome2;
  const reOverP = EARTH_RADIUS / p;
  const factor = 1.5 * J2 * reOverP * reOverP * n;
  const ci = Math.cos(inc);
  const si = Math.sin(inc);
  const si2 = si * si;

  const raanDot = -factor * ci;
  const argpDot = factor * (2.0 - 2.5 * si2);

  const M = m0 + mDot * timeSeconds;
  const raan = raan0 + raanDot * timeSeconds;
  const argp = argp0 + argpDot * timeSeconds;
  const gmst = gmst0 + EARTH_ROTATION_RATE * timeSeconds;

  const Mred = reduceToPi(M);
  let E = Mred;
  for (let k = 0; k < 4; k++) {
    const f = E - e * Math.sin(E) - Mred;
    const fp = 1.0 - e * Math.cos(E);
    E = E - f / fp;
  }
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const r = a * (1.0 - e * cosE);
  const beta = Math.sqrt(Math.max(1.0 - e * e, 0.0));
  const nu = Math.atan2(beta * sinE, cosE - e);

  const u = nu + argp;
  const cu = Math.cos(u);
  const su = Math.sin(u);
  const co = Math.cos(raan);
  const so = Math.sin(raan);

  const xEci = r * (cu * co - su * ci * so);
  const yEci = r * (cu * so + su * ci * co);
  const zEci = r * (su * si);

  const cg = Math.cos(gmst);
  const sg = Math.sin(gmst);
  out.position.x = cg * xEci + sg * yEci;
  out.position.y = -sg * xEci + cg * yEci;
  out.position.z = zEci;
  out.color.red = params[base + 9];
  out.color.green = params[base + 10];
  out.color.blue = params[base + 11];
  out.color.alpha = 1.0;
  out.pixelSize = params[base + 12];
}

// GMST at the catalog epoch (rad). Same value for every object — the
// kernel advances it per frame as gmst0 + omega_earth * t. Computed
// once when the catalog is (re)built from the scene clock so the
// inertial frame is anchored to the real sim epoch.
function gmstAtEpoch(julianDate) {
  // IAU-82 GMST: a low-order polynomial in centuries since J2000,
  // reduced to [0, 2pi). Ample for visualization.
  const jd =
    Cesium.JulianDate.toDate(julianDate).getTime() / 86400000.0 + 2440587.5;
  const T = (jd - 2451545.0) / 36525.0;
  const gmstSec =
    67310.54841 +
    (876600.0 * 3600.0 + 8640184.812866) * T +
    0.093104 * T * T -
    6.2e-6 * T * T * T;
  let gmst = ((gmstSec / 240.0) * Math.PI) / 180.0; // sec -> deg -> rad
  gmst = gmst % (2.0 * Math.PI);
  if (gmst < 0.0) {
    gmst += 2.0 * Math.PI;
  }
  return gmst;
}

let catalog;

function rebuildCatalog(count) {
  if (Cesium.defined(catalog)) {
    scene.primitives.remove(catalog);
  }
  catalog = scene.primitives.add(
    new Cesium.ComputeInstanceCollection({
      kernel: orbitalKernel,
      // WebGL2 fallback (ignored on WebGPU) — same propagation on CPU.
      cpuKernel: orbitalCpuKernel,
      floatsPerInstance: FLOATS_PER_INSTANCE,
      // Positions are GPU-resident, so the bounding volume is a
      // USER contract: every orbit fits inside GEO radius + margin
      // (largest apoapsis ≈ 4.22e7 m at GEO + eccentricity slack).
      // Enables per-frustum culling/binning of the catalog draw.
      boundingSphere: new Cesium.BoundingSphere(Cesium.Cartesian3.ZERO, 4.6e7),
    }),
  );
  const gmst0 = gmstAtEpoch(viewer.clock.currentTime);

  // Three altitude regimes. meanMotion n = sqrt(GM / a^3), so LEO
  // objects visibly lap the higher shells. Small eccentricities give
  // the orbits real apsides (the J2 apsidal rotation then precesses
  // them); GEO stays near-circular and near-equatorial.
  const REGIMES = [
    // [altitude range (m), weight, eccMax, [r, g, b]]
    [[400.0e3, 2000.0e3], 0.6, 0.02, [0.0, 1.0, 1.0]], // LEO — cyan
    [[19000.0e3, 21000.0e3], 0.25, 0.01, [1.0, 1.0, 0.0]], // MEO — yellow
    [[35786.0e3, 35786.0e3], 0.15, 0.0005, [1.0, 0.0, 1.0]], // GEO — magenta
  ];
  const TWO_PI = 2.0 * Math.PI;

  // Split an FP64 scalar into a df64 (two-float) pair (hi, lo) the
  // kernel reads back as ~46-bit precision. hi = the nearest f32,
  // lo = the FP64 residual (itself representable in f32).
  function df64Split(x) {
    const hi = Math.fround(x);
    return [hi, x - hi];
  }

  for (let i = 0; i < count; i++) {
    let pick = Math.random();
    let regime = REGIMES[0];
    for (const r of REGIMES) {
      if (pick < r[1]) {
        regime = r;
        break;
      }
      pick -= r[1];
    }
    const [altRange, , eccMax, color] = regime;
    const altitude = altRange[0] + Math.random() * (altRange[1] - altRange[0]);
    const isGEO = regime === REGIMES[2];
    const a = EARTH_RADIUS + altitude;
    const e = Math.random() * eccMax;
    const inc = isGEO ? Math.random() * 0.1 : Math.random() * Math.PI;

    // J2-corrected mean-anomaly secular rate, computed in JS FP64 and
    // split to df64 so the kernel keeps full precision over long t.
    const n = Math.sqrt(GM / (a * a * a));
    const ome2 = 1.0 - e * e;
    const p = a * ome2;
    const reOverP = EARTH_RADIUS / p;
    const factor = 1.5 * J2 * reOverP * reOverP * n;
    const si = Math.sin(inc);
    const mDot = n + factor * Math.sqrt(ome2) * (1.0 - 1.5 * si * si);
    const [mDotHi, mDotLo] = df64Split(mDot);

    catalog.addInstance([
      a,
      e,
      inc,
      Math.random() * TWO_PI, // RAAN at epoch
      Math.random() * TWO_PI, // argument of perigee at epoch
      Math.random() * TWO_PI, // mean anomaly at epoch
      mDotHi,
      mDotLo,
      gmst0,
      color[0],
      color[1],
      color[2],
      3.0, // pixelSize
    ]);
  }
}

const viewModel = {
  objectCount: "5000",
  clockMultiplier: 60,
};

function applySettings() {
  viewer.clock.multiplier = Number(viewModel.clockMultiplier);
}

Cesium.knockout.track(viewModel);
const toolbar = document.getElementById("toolbar");
Cesium.knockout.applyBindings(viewModel, toolbar);
Cesium.knockout
  .getObservable(viewModel, "objectCount")
  .subscribe(function (value) {
    rebuildCatalog(parseInt(value, 10));
  });
Cesium.knockout
  .getObservable(viewModel, "clockMultiplier")
  .subscribe(applySettings);

rebuildCatalog(5000);
applySettings();

// Pull back far enough to see the GEO shell.
viewer.camera.setView({
  destination: new Cesium.Cartesian3(1.1e8, 4.0e7, 5.0e7),
  orientation: {
    direction: Cesium.Cartesian3.normalize(
      new Cesium.Cartesian3(-1.1, -0.4, -0.5),
      new Cesium.Cartesian3(),
    ),
    up: new Cesium.Cartesian3(0.0, 0.0, 1.0),
  },
});
