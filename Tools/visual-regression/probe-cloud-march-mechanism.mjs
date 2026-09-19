#!/usr/bin/env node
/**
 * The orbital band mechanism preflight. SOURCE + DESCRIPTOR CONTRACT ONLY.
 * @purpose Drive one orbital recipe camera through the mechanism arm table - one dial per arm off a restored baseline, a clouds-ON and a clouds-OFF frame each - recording the frustum, the depth format, the tier realization and the weather counters, so the concentric-band family in orbital cloud views is attributed by experiment rather than by inference.
 * @status ACTIVE
 * @runtime lib/probe-runtime.mjs
 *
 * WHAT HAS RUN: NOTHING. At the batch that lands this file no leg of this
 * probe has been executed — the lane that wrote it had no browser. Its recipe
 * is in the landing packet. Nothing here should be cited as evidence until a
 * receipt exists.
 *
 * WHAT IT DECIDES. Four independent readings say the band family in orbital
 * cloud captures is not the march's step size. The surviving model is that the
 * march's occlusion clamp compares against a depth value read through a 16-bit
 * float resolve whose one-ulp quantum is tens of kilometres at orbital range.
 * That model reproduces the banked captures in period and in duty cycle and
 * has never been tested by changing anything. The arm table in
 * `lib/cloud-march-mechanism.mjs` is that test: one camera, one dial per arm,
 * a veto arm that can only refute, and a positive arm — a frustum far sweep —
 * that makes a number with the globe on screen.
 *
 * WHERE THE PAGE-SIDE CODE LIVES, AND WHY NOT HERE. `pageBuildScene` and
 * `pageRunArm` are imported from `lib/cloud-march-mechanism.mjs` rather than
 * declared in this file, so that a Node spec can EXECUTE them against a fake
 * viewer with the real cloud harness installed over it. The first draft kept
 * them inline behind a `c8 ignore` block; the arm-isolation logic inside that
 * block was the one part of this probe two independent reviewers found broken,
 * and it was the one part no case could reach. `page.evaluate` serialises a
 * function's source, so an imported self-contained function reaches the page
 * exactly as a local one would.
 *
 * NO VERDICT, BUT ONE REFUSAL. This probe reports measurements. Scoring
 * happens afterwards in Node, over the banked PNGs, with
 * `lib/metrics/radial-banding.mjs`; the numbers decide the branch and nothing
 * here prints a pass or a fail. The single exception is not a verdict about
 * the RENDERER, it is a verdict about the RUN: an arm whose dial did not
 * apply — read back off the scene by `pageRunArm`, never echoed from the
 * request — refuses by name instead of banking two PNGs under a label whose
 * treatment never happened. The arms already on disk survive it.
 *
 * THE CAMERA IS THE BANKED ONE, AND THAT IS THE WHOLE POINT. A default-camera
 * or low-altitude probe renders a clean-looking field and would miss this
 * defect entirely: it only appears at an orbital full-disc framing. Every arm
 * uses the rig `rigs/orbital-fulldisc-6608km.mjs`, which reproduces the banked
 * receipt's camera exactly.
 */

import fs from "node:fs";
import path from "node:path";

import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import {
  MECHANISM_ARMS,
  pageBuildScene,
  pageRunArm,
} from "./lib/cloud-march-mechanism.mjs";
import { installCloudProbeHarness } from "./lib/cloud-probe-harness.mjs";
import { ProbeRefusal, isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";
import { STRIP_WIDGETS_SOURCE } from "./lib/strip-viewer-widgets.mjs";
import RIG from "./rigs/orbital-fulldisc-6608km.mjs";

/**
 * Machine-safety ceiling for one run. Fourteen capturing arms at sixty settle
 * frames each, TWICE over — clouds on and clouds off — plus one non-capturing
 * arm, is minutes of real work; the budget's job is to end a HUNG device, not
 * to bound a slow one.
 */
const WATCHDOG_BUDGET_MS = 20 * 60 * 1000;

/**
 * The engine module the served page loads for itself.
 *
 * The CesiumViewer page publishes `window.viewer`, never `window.Cesium`.
 * Importing the absolute URL its own relative import resolves to returns the
 * module instance already in the page's registry, so there is one engine and
 * nothing to wait for.
 */
const CESIUM_MODULE_URL = "/Build/CesiumUnminified/index.js";

/** Far-plane multipliers the positive arm sweeps. 1 is the reference row. */
const FAR_MULTIPLIERS = Object.freeze([1, 0.25, 4, 16]);

/** Raw step counts the step-count-only arm sweeps through the escape hatch. */
const RAW_QUALITY_STEPS = Object.freeze([32, 64, 128, 256]);

// ---------------------------------------------------------------------------
// The one page-side function that stays here: it is about THIS probe's page
// bootstrap rather than about the arm table. It carries a unique marker comment
// so a stubbed page can dispatch on its source, the convention the
// probe-descriptor contract specs established.
// ---------------------------------------------------------------------------

/**
 * Install the engine namespace on the page as `Cesium`, and report what was
 * done rather than leaving the caller to infer it.
 *
 * It RETURNS a verdict instead of throwing, because a throw inside
 * `page.evaluate` reaches the Node side as an opaque browser error — the shape
 * this is avoiding, not one to reproduce.
 */
async function pageInstallCesiumNamespace(moduleUrl) {
  // __mechanismInstallNamespace
  const root = globalThis;
  // Every name this probe reads off the namespace, not just the first one: a
  // guard over a subset is how a namespace gets accepted here and then dies
  // one evaluate later with the property-access shape it exists to prevent.
  const required = ["JulianDate", "Cartesian3", "Math", "Color"];
  const missingFrom = (candidate) =>
    candidate ? required.filter((name) => !candidate[name]) : required;
  if (missingFrom(root.Cesium).length === 0) {
    return { ok: true, source: "page", moduleUrl };
  }
  let namespace;
  try {
    namespace = await import(moduleUrl);
  } catch (error) {
    return {
      ok: false,
      source: "import-failed",
      moduleUrl,
      reason: String((error && error.message) || error),
    };
  }
  const missing = missingFrom(namespace);
  if (missing.length > 0) {
    return {
      ok: false,
      source: "module-incomplete",
      moduleUrl,
      reason: `${moduleUrl} loaded but exposes no ${missing.join(", ")}`,
    };
  }
  root.Cesium = namespace;
  return { ok: true, source: "module", moduleUrl };
}

/**
 * Acquire the page's engine namespace, or refuse by name.
 *
 * Exported so a contract spec can pin the behaviour worth pinning: a page
 * WITHOUT the namespace produces this named refusal — the probe declined to
 * measure — rather than a property-access crash one or more evaluates later.
 *
 * @param {object} page A Playwright page, or a stub with `evaluate`.
 * @param {string} [moduleUrl] The engine module to import.
 * @returns {Promise<object>} The page's verdict.
 */
export async function acquireCesiumNamespace(
  page,
  moduleUrl = CESIUM_MODULE_URL,
) {
  const outcome = await page.evaluate(pageInstallCesiumNamespace, moduleUrl);
  if (outcome?.ok !== true) {
    throw new ProbeRefusal(
      "cesium-namespace-unavailable",
      `the mechanism preflight could not obtain the engine namespace from ${moduleUrl}: ` +
        `${outcome?.reason ?? "the page returned no verdict"}. Every arm reads ` +
        "JulianDate, Cartesian3, Math and Color off the page global, so there " +
        "is nothing to measure without it.",
      { moduleUrl, outcome: outcome ?? null },
    );
  }
  return outcome;
}

/**
 * The per-arm dial sets, derived from the arm table.
 *
 * Exported so a spec can assert that every arm changes exactly one thing and
 * that the far sweep carries its reference row, without launching anything.
 *
 * @returns {Array<object>} `{armId, label, dial}` in execution order.
 */
export function armDialSets() {
  const sets = [];
  for (const arm of MECHANISM_ARMS) {
    if (arm.id === "M0") {
      sets.push({ armId: "M0", label: "M0", dial: {} });
    } else if (arm.id === "M1") {
      sets.push({ armId: "M1", label: "M1", dial: { globeShow: false } });
    } else if (arm.id === "M3") {
      sets.push({
        armId: "M3",
        label: "M3-ellipsoid",
        dial: { ellipsoidTerrain: true },
      });
      for (const sse of [2, 32]) {
        sets.push({
          armId: "M3",
          label: `M3-sse${sse}`,
          dial: { maximumScreenSpaceError: sse },
        });
      }
    } else if (arm.id === "M4") {
      for (const raw of RAW_QUALITY_STEPS) {
        sets.push({
          armId: "M4",
          label: `M4-q${raw}`,
          dial: { volumetric: { cloudQuality: raw } },
        });
      }
    } else if (arm.id === "M6") {
      for (const multiplier of FAR_MULTIPLIERS) {
        sets.push({
          armId: "M6",
          label: `M6-far-x${multiplier}`,
          dial: { farMultiplier: multiplier },
        });
      }
    } else if (arm.id === "M7") {
      sets.push({ armId: "M7", label: "M7-godrays", dial: { godRays: true } });
    } else if (arm.id === "M2") {
      sets.push({
        armId: "M2",
        label: "M2-msaa1",
        dial: { msaaSamples: 1 },
        capturesNothing: true,
      });
    }
  }
  return sets;
}

/**
 * The dial sets one run will execute, narrowed by `--only-arm`.
 *
 * Exported so the smoke selection is a covered behaviour rather than an
 * option nobody has run: a name that matches no arm REFUSES, because a leg
 * that quietly executed nothing and exited 0 is the worst possible answer to
 * "is the engine the shape this probe believes it is?".
 *
 * @param {string} [onlyArm] An arm label (`M6-far-x4`) or an arm id (`M6`).
 * @returns {Array<object>} The dial sets to run, in execution order.
 */
export function selectArms(onlyArm) {
  const all = armDialSets();
  if (onlyArm === undefined || onlyArm === null || onlyArm === "") {
    return all;
  }
  const selected = all.filter(
    (set) => set.label === onlyArm || set.armId === onlyArm,
  );
  if (selected.length === 0) {
    throw new ProbeRefusal(
      "unknown-arm",
      `--only-arm ${onlyArm} matches no arm; the table is ${all
        .map((set) => set.label)
        .join(", ")}`,
      { onlyArm, available: all.map((set) => set.label) },
    );
  }
  return selected;
}

// ---------------------------------------------------------------------------
// The descriptor the shared runtime executes
// ---------------------------------------------------------------------------

export const descriptor = {
  name: "cloud-march-mechanism",
  title:
    "Cloud march mechanism preflight — one dial per arm off a restored baseline, clouds on and off, at the orbital full-disc recipe camera",
  outputSubdirectory: "",
  // The default list names `Cesium.js` and the engine build but NOT
  // `Build/CesiumUnminified/index.js`, which is both what the CesiumViewer
  // page imports and what this probe pulls into the page. An unlisted artifact
  // is an unchecked one.
  servedArtifacts: [
    "Build/CesiumUnminified/Cesium.js",
    "Build/CesiumUnminified/index.js",
    "packages/engine/Build/Unminified/index.js",
  ],
  receiptEnvelope: "probe-owned",
  // No `workBudgetMs`: declaring it adopts the lifecycle path, which carries a
  // recorded hole where a malformed scope call drops the work and the run
  // reports success. A brand-new probe stays on the pre-adoption path until
  // that lands, and carries its own deadline below instead.
  args: {
    extraOptions: [
      {
        flag: "--settle-frames",
        key: "settleFrames",
        kind: "positive-integer",
        default: RIG.readiness.frames,
      },
      // THE ENGINE-SHAPE SMOKE, AND WHY IT IS A FLAG RATHER THAN ADVICE.
      // Three review rounds of this leg were argued in Node against a page
      // NOBODY COULD SEE, and every one of them missed a member the engine
      // does not have — a master gate that makes the clouds-OFF frame throw,
      // a god-ray dial on a collection member that has never existed, a cache
      // field name that was the wrong one. A Node double can only be as right
      // as the reading that built it. So the first REAL execution is cheap by
      // construction: `--only-arm M0` runs the baseline arm and its own
      // clouds-OFF control and stops, about a minute, and either the two
      // frames come back with every dial `applied: true` or the twenty-minute
      // run is not booked. `EDGE_LEG_1_RECIPE.md` STEP 0 is that job.
      { flag: "--only-arm", key: "onlyArm", kind: "string" },
    ],
  },
  async cells({ browser, options, origin, outputDirectory }) {
    // MACHINE SAFETY. The pre-adoption runtime path carries no deadline and
    // this probe drives a dozen settle legs. A hung device with no ceiling is
    // how a background probe takes the machine with it.
    const work = (async () => {
      fs.mkdirSync(outputDirectory, { recursive: true });
      if (!options.renderers.includes("webgpu")) {
        throw new ProbeRefusal(
          "renderer-unavailable",
          "the volumetric march is WebGPU-only, so a mechanism preflight on " +
            `${options.renderers.join(",")} would measure a globe with no clouds on it`,
          { renderers: options.renderers },
        );
      }

      const page = await browser.newPage({ viewport: RIG.viewport });
      const consoleErrors = attachConsoleErrorGate(page);
      await page.addInitScript(errorGateInit);
      await page.addInitScript(installCloudProbeHarness);
      await page.goto(`${origin}/${RIG.page}?renderer=webgpu&offline=true`, {
        waitUntil: "networkidle",
        timeout: 120000,
      });
      await page.waitForFunction(() => !!window.viewer, { timeout: 120000 });
      await acquireCesiumNamespace(page);
      // The ladder probe's constant saturated chrome fraction is a filed
      // instrument defect; widgets are stripped so no absolute figure here
      // carries it.
      const strippedWidgets = await page.evaluate(
        `(${STRIP_WIDGETS_SOURCE})()`,
      );
      // Arm BEFORE the first cloud frame: a validation error raised while the
      // march compiles its first pipeline is exactly the fault this leg would
      // otherwise report as a dark arm.
      await armWebGPUDevices(page);

      const scene = await page.evaluate(pageBuildScene, {
        clock: RIG.clock,
        dials: RIG.dials,
      });
      if (!scene.ok || scene.renderLoopDisabled !== true) {
        throw new ProbeRefusal(
          "scene-not-owned",
          "the preflight must own every frame it measures; the viewer's own " +
            "render loop was still running, the cloud configuration did not " +
            "round-trip, or the rig named a globe dial this probe does not " +
            `apply (${scene.unappliedGlobeDials?.join(", ") || "none"})`,
          { scene },
        );
      }

      // BANK AS YOU GO. Each arm's PNGs and its own manifest line are written
      // the moment the arm finishes, so a device that dies at arm 11 leaves ten
      // arms of banked evidence rather than an empty directory. `receipt.json`
      // is the run's own envelope and only exists at the end; this file is what
      // the executor repatriates from a killed run.
      const progressFile = path.join(outputDirectory, "arms-so-far.json");
      const capture = async (label) => {
        const buffer = await page.locator("canvas").first().screenshot();
        const file = path.join(
          outputDirectory,
          `cloud-march-mechanism-${label}.png`,
        );
        fs.writeFileSync(file, buffer);
        return path.basename(file);
      };

      // `--only-arm` narrows the table by LABEL or by arm id, and refuses a
      // name that matches nothing rather than running a zero-arm leg that
      // reports success — which is the shape STEP 0 exists to avoid.
      const selected = selectArms(options.onlyArm);
      const arms = [];
      for (const set of selected) {
        const before = consoleErrors.length;
        const armConfig = {
          camera: RIG.camera,
          baseline: scene.baseline,
          cloudDials: scene.cloudDials,
          dial: set.dial,
          settleFrames: options.settleFrames,
        };
        const measurement = await page.evaluate(pageRunArm, {
          ...armConfig,
          cloudsOn: true,
        });
        // AN ARM WHOSE DIAL DID NOT APPLY IS NOT BANKED. `pageRunArm` reads
        // every dial BACK off the scene rather than echoing the request, so a
        // dial written to a property the engine does not have reports
        // `applied: false` here. The first draft had no such report, and M7's
        // god-ray write sat behind an `if` with no `else`: the arm rendered
        // M0's scene, banked two PNGs under M7's label, and the summary
        // printed the REQUEST in the dial column. The refusal is named and it
        // ends the run, because a capture labelled with a treatment that did
        // not take is worse evidence than no capture at all (Reginard R2-2,
        // Sigismond R5). The arms already banked survive it — `arms-so-far.json`
        // is written per arm, so a refusal costs the leg its remainder rather
        // than its evidence.
        if (measurement?.dialsApplied !== true) {
          throw new ProbeRefusal(
            "arm-dial-did-not-apply",
            `arm ${set.label} requested ${JSON.stringify(set.dial)} and the scene did not take it: ` +
              `${(measurement?.unappliedDials ?? ["the arm returned no dial report at all"]).join("; ")}. ` +
              "A capture banked under this label would be a picture of the arm before it.",
            {
              armId: set.armId,
              label: set.label,
              dial: set.dial,
              dialReports: measurement?.dialReports ?? null,
            },
          );
        }
        let png = null;
        let pngCloudsOff = null;
        let measurementCloudsOff = null;
        if (set.capturesNothing !== true) {
          png = await capture(set.label);
          // THE ARM'S OWN CONTROL. `cloudContributionField(on, off)` is what
          // separates the ring energy from the limb, the terminator and the
          // terrain, and the OFF frame has to come from THIS arm's scene —
          // M1 has no globe and M3 has no real terrain, so a borrowed OFF
          // frame subtracts a different picture (Sigismond R3).
          measurementCloudsOff = await page.evaluate(pageRunArm, {
            ...armConfig,
            cloudsOn: false,
          });
          pngCloudsOff = await capture(`${set.label}-clouds-off`);
        }
        arms.push({
          ...set,
          png,
          pngCloudsOff,
          measurement,
          measurementCloudsOff,
          // The arm's OWN console errors, not the run's: the single-sample arm
          // is expected to raise a device validation error and the report has
          // to say which arm raised what.
          consoleErrors: consoleErrors.slice(before),
          deviceGate: await collectGateErrors(page),
        });
        fs.writeFileSync(progressFile, JSON.stringify(arms, null, 2));
      }

      return [
        {
          rig: RIG.id,
          scene,
          strippedWidgets,
          // A NARROWED RUN SAYS SO IN ITS OWN RECEIPT. A STEP 0 smoke and a
          // full leg produce the same file shape, and nothing downstream may
          // read a one-arm receipt as the leg.
          onlyArm: options.onlyArm ?? null,
          armsRequested: selected.length,
          armsInTable: armDialSets().length,
          arms,
          consoleErrors: [...consoleErrors],
        },
      ];
    })();
    let watchdogTimer;
    const watchdog = new Promise((_resolve, reject) => {
      watchdogTimer = setTimeout(
        () =>
          reject(
            new ProbeRefusal(
              "watchdog-timeout",
              `probe-cloud-march-mechanism exceeded its ${WATCHDOG_BUDGET_MS}ms machine-safety budget`,
              { budgetMs: WATCHDOG_BUDGET_MS },
            ),
          ),
        WATCHDOG_BUDGET_MS,
      );
    });
    try {
      return await Promise.race([work, watchdog]);
    } finally {
      clearTimeout(watchdogTimer);
    }
  },
  receipt(cells, context) {
    return {
      base: context.origin,
      rig: RIG.id,
      camera: RIG.camera,
      disc: RIG.disc,
      dials: RIG.dials,
      clock: RIG.clock,
      arms: MECHANISM_ARMS,
      farMultipliers: FAR_MULTIPLIERS,
      rawQualitySteps: RAW_QUALITY_STEPS,
      runs: cells,
    };
  },
  // NO VERDICTS, BY RULING. This leg is a look: the bands are scored
  // afterwards in Node with `lib/metrics/radial-banding.mjs` over the PNGs
  // banked above, and the numbers decide the branch. A probe that printed a
  // pass here would be deciding a mechanism from a picture.
  summary(receipt) {
    const lines = [
      "# Cloud march mechanism preflight",
      "",
      `Base: \`${receipt.base}\`  ·  rig: \`${receipt.rig}\``,
      "",
      "No verdict. Score the banked PNGs with `lib/metrics/radial-banding.mjs`",
      "and read the far sweep with `evaluateFarSweep` in",
      "`lib/cloud-march-mechanism.mjs`.",
      "",
      // `globe` and `terrain` are in the table because the restore is the part
      // of this leg a reader has to be able to check: an arm whose globe reads
      // false, or whose terrain is not the baseline's, is a confounded arm and
      // the receipt says so without anyone having to reason about ordering.
      // `applied` and `god ray` are in this table for the same reason `globe`
      // and `terrain` are: a reader has to be able to see that an arm's dial
      // TOOK, not merely that it was requested. The dial column is the
      // REQUEST; `applied` is the readback off the scene; `god ray` is
      // requested / cloud-aware / realised for the one arm whose effect
      // initialises lazily inside the post-process pipeline.
      "| arm | dial | applied | globe | terrain | near | far | cloud near/far | depth format | msaa | steps | god ray | png | png (clouds off) |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ];
    for (const run of receipt.runs) {
      for (const arm of run.arms) {
        const m = arm.measurement ?? {};
        const applied =
          m.dialsApplied === true
            ? "yes"
            : m.dialsApplied === false
              ? `NO (${(m.unappliedDials ?? []).join("; ")})`
              : "—";
        const godRay = m.godRay
          ? `${m.godRay.requested} / ${m.godRay.cloudAware} / ${m.godRay.realized ?? "—"}`
          : "—";
        lines.push(
          `| ${arm.label} | ${JSON.stringify(arm.dial)} | ${applied} | ${m.globe?.show ?? "—"} | ${
            m.globe?.terrainProvider ?? "—"
          } | ${m.frustum?.near ?? "—"} | ${
            m.frustum?.far ?? "—"
          } | ${m.cloudPlanes?.nearPlane ?? "—"} / ${m.cloudPlanes?.farPlane ?? "—"} | ${
            m.depthTexture?.format ?? "—"
          } | ${m.depthTexture?.msaaSamples ?? "—"} | ${
            m.realization?.primarySteps ?? "—"
          } | ${godRay} | ${arm.png ?? "(none)"} | ${arm.pngCloudsOff ?? "(none)"} |`,
        );
      }
    }
    lines.push("");
    return lines.join("\n");
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
