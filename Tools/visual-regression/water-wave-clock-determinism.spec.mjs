// water-wave-clock-determinism.spec.mjs - W-A3 of the water landing (opt-in determinism).
// @purpose Pins that two page loads pinned to the same scene clock hand both backends the same water wave phase once the probe stage sets the FFT surface's simulationEpoch to that instant (the deterministic switch, scene.globe.water.ocean.simulationEpoch), records that without it the phase depends on when each page first rendered, and turns red under a mutant that lets the first-frame epoch back in.
// @status ACTIVE
//
// THE FINDING. The seat's Edge executor ran E-T-water twice at a pinned clock
// (2026-06-21T16:00:00Z) with the water presets on. On WebGL run0 and run1 differ
// by 360,638 px, all on the masked water (VERIFY_CALENHAD B5). The only time input
// the WebGL water shading reads is `u_oceanWaveSeconds` (GlobeFS.glsl), which the
// WebGPU tile uniform buffer mirrors as `tile.time`; both come from
// `advanceGlobeOceanWaveClock` (Scene/GlobeOceanWaveClock.js, Batch 1288), resolved
// once per frame in `Globe.beginFrame`.
//
// THE SOURCE THAT IS NOT THE SCENE CLOCK. With no pinned epoch the wave clock
// measures elapsed seconds from the FIRST frame that carries a time. A Viewer's
// clock starts at wall-clock now, and the probe pins the clock after the viewer
// exists (`lib/determinism-kit.mjs` pinClock), so the epoch is the page-load
// instant and the phase at the pinned clock is (pinned - load time): a different
// sea on every run. That design is base's and deliberate (an elapsed count from a
// fixed epoch such as J2000 would hand the float32 uniform about 8e8 s and lose
// the sub-second phase), so W-A3 does not change it.
//
// THE SWITCH. `scene.globe.water.ocean.simulationEpoch = <instant>` pins the epoch
// for both seas (the globe's wave clock reads it through
// `GlobeWater.pinnedOceanSimulationEpoch`). The probe stage sets it to the pinned
// clock instant right after pinClock; both runs then resolve 0 s at the pinned
// clock, on both renderers. Creating the `ocean` sub-facade allocates CPU state
// only; no FFT surface, no GPU owner and no fetch.
//
// A second wall-clock input exists on WebGPU only and is transient: the
// classic-to-enhanced fade (`WebGPUGlobeSurfaceOceanTiers.ts`, `defaultNow`) runs
// 600 ms after the enhanced pipelines resolve and is 0 from then on; the rig's
// 120 settle frames outlast it.
//
// Run: node --test Tools/visual-regression/water-wave-clock-determinism.spec.mjs

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";
import { importMutated } from "./lib/import-mutated.mjs";

enableEngineTsResolution();

const here = path.dirname(fileURLToPath(import.meta.url));
const SCENE = path.resolve(here, "../../packages/engine/Source/Scene");
const CLOCK_FILE = path.join(SCENE, "GlobeOceanWaveClock.js");

const { default: JulianDate } =
  await import("../../packages/engine/Source/Core/JulianDate.js");
const realClock =
  await import("../../packages/engine/Source/Scene/GlobeOceanWaveClock.js");
const { default: GlobeWaterOcean } =
  await import("../../packages/engine/Source/Scene/GlobeWaterOcean.js");

const PINNED = "2026-06-21T16:00:00Z";

/**
 * One page load: the viewer renders a few frames on its wall-clock start, the
 * probe pins the clock, and (with `pinEpoch`) the stage pins the water epoch
 * to the same instant, through the real facade. Returns the wave phase both
 * backends are handed for each of the next frames at the pinned clock.
 */
function pageLoad(clockModule, loadIso, { pinEpoch }) {
  const clock = clockModule.createGlobeOceanWaveClock();
  const ocean = new GlobeWaterOcean({}, {});
  const water = { pinnedOceanSimulationEpoch: undefined };
  const frame = (time) =>
    clockModule.advanceGlobeOceanWaveClock(
      clock,
      { time },
      water.pinnedOceanSimulationEpoch,
    );
  const start = JulianDate.fromIso8601(loadIso);
  for (let i = 0; i < 3; i++) {
    frame(JulianDate.addSeconds(start, i / 60, new JulianDate()));
  }
  const pinned = JulianDate.fromIso8601(PINNED);
  if (pinEpoch) {
    ocean.simulationEpoch = pinned;
    water.pinnedOceanSimulationEpoch = ocean.simulationEpoch;
  }
  return [frame(pinned), frame(pinned), frame(pinned)];
}

/** Two loads, 7.3 s apart in wall-clock time, pinned to the same clock. */
function twoRuns(clockModule, options) {
  return [
    pageLoad(clockModule, "2026-10-22T21:19:04.100Z", options),
    pageLoad(clockModule, "2026-10-22T21:19:11.400Z", options),
  ];
}

function assertSameSea([run0, run1]) {
  assert.deepEqual(run0, run1, "both runs hand the shaders the same phase");
  assert.ok(
    run0.every((s) => s === run0[0]),
    "a held clock holds the sea",
  );
}

test("1: with the stage's epoch pin, two runs at the same pinned clock get the same wave phase (0 s)", () => {
  const runs = twoRuns(realClock, { pinEpoch: true });
  assertSameSea(runs);
  assert.equal(runs[0][0], 0);
});

test("2 (the finding): without the pin, the phase depends on when the page first rendered", () => {
  const [run0, run1] = twoRuns(realClock, { pinEpoch: false });
  assert.ok(
    run0.every((s) => s === run0[0]),
    "still held within a run",
  );
  assert.notEqual(run0[0], run1[0], "different loads, different seas");
  assert.ok(Math.abs(run0[0] - run1[0] - 7.3) < 1e-6);
});

test("3 (mutant): a wave clock that lets the first-frame epoch back in over the pin is DETECTED", async () => {
  const mutant = await importMutated(CLOCK_FILE, [
    [
      "  if (pinnedEpoch !== clock._pinnedEpochSource) {",
      "  if (false && pinnedEpoch !== clock._pinnedEpochSource) {",
    ],
  ]);
  assert.throws(() => assertSameSea(twoRuns(mutant, { pinEpoch: true })));
});
