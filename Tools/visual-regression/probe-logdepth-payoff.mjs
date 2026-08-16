#!/usr/bin/env node
/**
 * Wave B de-risk: does the renderer-wide log-depth master switch fix the
 * Checkerboard far-corner reconstruction-precision artifact
 * (NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION)? Globe-only scene (only the globe
 * writes depth, so no z-fight from non-logging geometry). Capture switch-OFF
 * (baseline artifact) vs switch-ON (log depth). Measure local variance in the
 * FAR (upper-right) quadrant of the polygon — solid => artifact; patterned =>
 * fixed. Nothing is committed; this only reads pixels.
 * @purpose A/B: does the renderer-wide log-depth master switch fix the ground-classification far-corner precision artifact? Variance gate + STRUCTURAL guard.
 * @status ACTIVE
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A/B REPAIR (Batch 861+) — `NEW-PROBE-VACUOUS-REACHABILITY-ASSERTION` sweep
 * ─────────────────────────────────────────────────────────────────────────────
 * The previous revision's "switch-OFF baseline" was captured while log depth was
 * ALREADY ON, so the A/B was null by construction and the module always exited
 * 0 with no predicate anywhere in it:
 *
 *   `WebGPULogDepth.ts:79-84`  active := `context._logDepthWriteEnabled &&
 *                              frameState.useLogDepth`
 *   `WebGPUContext.ts`         `_logDepthWriteEnabled = true` by default since
 *                              Batch 251 (NEW-COLLECTIONS-LOG-DEPTH master switch)
 *   `Scene.js:161`             `defaultLogDepthBuffer = true`
 *   `Scene.js:3528-3533`       `frameState.useLogDepth = _logDepthBuffer &&
 *                              !(orthographic frustum)` — true for this probe's
 *                              perspective camera
 *
 * So BOTH conjuncts were true in the "OFF" capture, and its printed
 * `variance far-UR OFF = … ON = …` was quotable as evidence that log depth
 * fixed the artifact while demonstrating nothing.
 *
 * BOTH halves of the switch are now driven for the OFF leg
 * (`context._logDepthWriteEnabled = false` AND `scene.logarithmicDepthBuffer =
 * false`, which is what reaches `frameState.useLogDepth`), each leg READS BACK
 * its own `active` state after a real render, and the two legs' states MUST
 * DIFFER. If the flip does not take — `Scene.logarithmicDepthBuffer`'s setter
 * ANDs the request with `context.fragmentDepth`, so on a context without it the
 * request is silently dropped — the run reports STRUCTURAL and scores nothing.
 *
 * Usage: PROBE_BASE=http://localhost:8134 node Tools/visual-regression/probe-logdepth-payoff.mjs
 * Exit:
 *   0 PASS — log depth restored the far-corner pattern
 *   1 FAIL — the far corner is still solid with log depth ON
 *   2 watchdog or exception
 *   3 STRUCTURAL — the switch did not flip, the scene did not settle, or the
 *     reference corner is dead: the A/B measured nothing either way
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE ?? "http://localhost:8134";

const WATCHDOG_MS = 420_000;
const watchdog = setTimeout(() => {
  console.error(`[logdepth-payoff] watchdog fired after ${WATCHDOG_MS} ms`);
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref?.();

/**
 * Non-vacuity floor for the NEAR (lower-left) corner, which is the corner the
 * artifact does NOT affect and therefore this probe's own reference. The
 * material is a full-contrast Checkerboard — `lightColor (1, 0.05, 0.05)` vs
 * `darkColor (0.05, 0.05, 1)` at 8x8 repeats over a ~100 px polygon — so a
 * sampled region spanning several cells has per-channel variance in the
 * thousands, while a SOLID region has variance ~0. 100 sits far below any real
 * checkerboard and far above any solid fill.
 */
const NEAR_VARIANCE_MIN = 100;
/**
 * The far corner is foreshortened, so its cells are denser and its variance is
 * legitimately lower than the near corner's even when the pattern is intact.
 * A quarter of the near corner's variance is the "pattern is present" bar; the
 * artifact drives it to ~0. FIRST-PASS value — the orchestrator's first real
 * run should record the measured pair and re-baseline it if the healthy ON leg
 * lands near the bar rather than far above it.
 */
const FAR_PATTERN_FRACTION = 0.25;

/** In-page image decode budget. `page.evaluate` accepts no timeout of its own. */
const DECODE_TIMEOUT_MS = 30_000;

const structural = [];
const notes = [];

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

let fatal = null;
let verdict = null;
try {
  const p = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errs = [];
  const pageErrs = [];
  p.on("pageerror", (e) => pageErrs.push("PAGE:" + e.message.slice(0, 160)));
  p.on("console", (m) => {
    if (m.type() === "error") errs.push("ERR:" + m.text().slice(0, 160));
  });
  await p.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await p.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  // Build the scene + a Checkerboard ground primitive; settle.
  const setup = await p.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.useDefaultRenderLoop = false;
    const s = v.scene;
    s.skyBox.show = false;
    s.skyAtmosphere.show = false;
    s.globe.showGroundAtmosphere = false;
    s.backgroundColor = C.Color.fromCssColorString("#101014");
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-97.5, 41.5, 350000),
      orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 },
    });
    const material = new C.Material({
      fabric: {
        type: "Checkerboard",
        uniforms: {
          lightColor: new C.Color(1, 0.05, 0.05, 1),
          darkColor: new C.Color(0.05, 0.05, 1, 1),
          repeat: new C.Cartesian2(8, 8),
        },
      },
    });
    const positions = C.Cartesian3.fromDegreesArray([
      -97.85, 41.35, -97.15, 41.35, -97.15, 41.65, -97.85, 41.65,
    ]);
    const ground = new C.GroundPrimitive({
      geometryInstances: new C.GeometryInstance({
        geometry: new C.PolygonGeometry({
          polygonHierarchy: new C.PolygonHierarchy(positions),
        }),
      }),
      appearance: new C.MaterialAppearance({
        material,
        translucent: true,
        flat: true,
      }),
      classificationType: C.ClassificationType.TERRAIN,
      asynchronous: false,
    });
    s.groundPrimitives.add(ground);
    window.__ground = ground;
    let f = 0,
      streak = 0;
    while (f < 2500) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
      f++;
      const st = s.globe.tilesLoaded && ground.ready;
      streak = st ? streak + 1 : 0;
      if (streak >= 30) break;
    }
    for (let i = 0; i < 10; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    return {
      settled: s.globe.tilesLoaded && ground.ready,
      frames: f,
      fragmentDepth: s.context.fragmentDepth === true,
    };
  });
  notes.push(`setup: ${JSON.stringify(setup)}`);

  /**
   * Drive BOTH halves of the switch, render, and READ BACK the state that
   * actually governs the encoding. `frameState.useLogDepth` is written inside
   * `Scene.updateFrameState` during render, so the read must follow one.
   */
  const setLogDepth = async (enabled) =>
    p.evaluate(async (want) => {
      const s = window.viewer.scene;
      s.context._logDepthWriteEnabled = want;
      s.logarithmicDepthBuffer = want;
      for (let i = 0; i < 20; i++) {
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      const frameState = s._view?.frameState ?? s._frameState ?? s.frameState;
      const writeEnabled = !!s.context._logDepthWriteEnabled;
      const useLogDepth = !!frameState?.useLogDepth;
      return {
        requested: want,
        writeEnabled,
        useLogDepth,
        logarithmicDepthBuffer: s.logarithmicDepthBuffer,
        // The exact predicate from WebGPULogDepth.isWebGPULogDepthActive.
        active: writeEnabled && useLogDepth,
      };
    }, enabled);

  // ── OFF leg FIRST, and it is now genuinely off.
  const offState = await setLogDepth(false);
  const png1 = await p.screenshot({ type: "png" });
  // ── ON leg.
  const onState = await setLogDepth(true);
  const png2 = await p.screenshot({ type: "png" });
  notes.push(`OFF leg state: ${JSON.stringify(offState)}`);
  notes.push(`ON  leg state: ${JSON.stringify(onState)}`);

  // Decode both, measure local variance in the polygon's far (upper-right)
  // quadrant vs the near (lower-left) quadrant.
  async function quadVar(durl) {
    return await p.evaluate(
      ([d, decodeTimeoutMs]) =>
        new Promise((res, rej) => {
          const img = new Image();
          const timer = setTimeout(
            () => rej(new Error(`image decode exceeded ${decodeTimeoutMs} ms`)),
            decodeTimeoutMs,
          );
          img.onerror = () => {
            clearTimeout(timer);
            rej(new Error("image decode failed (onerror)"));
          };
          img.onload = () => {
            clearTimeout(timer);
            const c = document.createElement("canvas");
            c.width = img.width;
            c.height = img.height;
            const cx = c.getContext("2d");
            cx.drawImage(img, 0, 0);
            const data = cx.getImageData(0, 0, c.width, c.height).data;
            const region = (x0, x1, y0, y1) => {
              const rs = [];
              for (let y = y0; y <= y1; y++)
                for (let x = x0; x <= x1; x++) {
                  const i = (y * c.width + x) * 4;
                  rs.push(data[i], data[i + 1], data[i + 2]);
                }
              const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
              const varc =
                rs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / rs.length;
              return Math.round(varc);
            };
            // polygon ~ x[348..452] y[268..332]; far/NE quadrant = right+top,
            // near/SW = left+bottom
            res({
              farUR: region(404, 450, 270, 300),
              nearLL: region(350, 396, 302, 330),
            });
          };
          img.src = d;
        }),
      [durl, DECODE_TIMEOUT_MS],
    );
  }
  const vOff = await quadVar(
    "data:image/png;base64," + png1.toString("base64"),
  );
  const vOn = await quadVar("data:image/png;base64," + png2.toString("base64"));

  const fs = await import("node:fs");
  fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
  fs.writeFileSync(
    "Tools/visual-regression/output/logdepth-payoff-off.png",
    png1,
  );
  fs.writeFileSync(
    "Tools/visual-regression/output/logdepth-payoff-on.png",
    png2,
  );

  notes.push(
    `variance far-UR (artifact corner): OFF = ${vOff.farUR}  ON = ${vOn.farUR}  (higher = checkerboard present; ~0 = solid/artifact)`,
  );
  notes.push(
    `variance near-LL (reference corner): OFF = ${vOff.nearLL}  ON = ${vOn.nearLL}`,
  );
  notes.push(
    `console errors: ${errs.length} ${JSON.stringify(errs.slice(0, 4))}`,
  );

  // ── STRUCTURAL preconditions.
  if (setup.settled !== true) {
    structural.push(
      `the scene never settled (tilesLoaded && ground.ready false after ${setup.frames} frames) — neither corner is a measurement of the classifier`,
    );
  }
  if (pageErrs.length > 0) {
    structural.push(
      `${pageErrs.length} page error(s) during setup: ${pageErrs[0]} — the scene under test may not be the one described`,
    );
  }
  // The A/B must actually be an A/B. This is the whole repair.
  if (offState.active !== false || onState.active !== true) {
    structural.push(
      `the log-depth switch did not flip: OFF leg active=${offState.active} (writeEnabled=${offState.writeEnabled}, useLogDepth=${offState.useLogDepth}), ` +
        `ON leg active=${onState.active} (writeEnabled=${onState.writeEnabled}, useLogDepth=${onState.useLogDepth}); ` +
        `context.fragmentDepth=${setup.fragmentDepth} — Scene's setter ANDs the request with it. ` +
        `The two captures are the SAME configuration, so their difference measures nothing`,
    );
  }
  for (const [leg, v] of [
    ["OFF", vOff],
    ["ON", vOn],
  ]) {
    if (!(v.nearLL >= NEAR_VARIANCE_MIN)) {
      structural.push(
        `${leg} leg: near-LL reference variance ${v.nearLL} < ${NEAR_VARIANCE_MIN} — the checkerboard is not visible even where the artifact does not reach, so the far corner cannot be read`,
      );
    }
  }

  if (structural.length === 0) {
    const bar = FAR_PATTERN_FRACTION * vOn.nearLL;
    const fixed = vOn.farUR >= bar;
    notes.push(
      `GATE: ON far-UR ${vOn.farUR} vs ${FAR_PATTERN_FRACTION} * ON near-LL ${vOn.nearLL} = ${bar.toFixed(1)} -> ${fixed ? "pattern present" : "still solid"}`,
    );
    verdict = fixed ? 0 : 1;
  }
  await p.close();
} catch (error) {
  fatal = error;
} finally {
  await browser.close();
}

clearTimeout(watchdog);

if (fatal) {
  console.error(`ERROR: ${fatal?.stack ?? fatal}`);
  process.exit(2);
}

console.log("=== probe-logdepth-payoff ===");
for (const n of notes) {
  console.log("  " + n);
}
if (structural.length > 0) {
  console.log("STRUCTURAL");
  for (const s of structural) {
    console.log("  STRUCTURAL: " + s);
  }
  console.log(
    "RESULT: STRUCTURAL — the A/B measured nothing. This probe certifies nothing in this state.",
  );
  process.exit(3);
}
console.log(
  `RESULT: ${verdict === 0 ? "PASS — log depth restored the far-corner pattern" : "FAIL — far corner still solid with log depth ON"}`,
);
process.exit(verdict);
