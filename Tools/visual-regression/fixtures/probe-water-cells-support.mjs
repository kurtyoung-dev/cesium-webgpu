// probe-water-cells-support.mjs - shared fixtures for the probe-water-cells spec parts.
// @purpose Spec support for probe-water-cells: the per-run temp root, the rig registry lookup, the synthetic image and capture-store builders, the stub browser and Sandcastle 2 run frame, and the runE harness that more than one probe-water-cells spec part drives.
// @status ACTIVE
//
// Moved verbatim out of probe-water-cells.spec.mjs when that spec was split by subject (row
// DX-KIT-WATER-CELLS-SPEC-OVERSIZE). Each part runs in its own process, so each gets its own mkdtemp root from the
// TEMP_ROOT below and never shares a path with another part.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

import { encodeRgbaPng } from "../../lib/png-rgba.mjs";
import { stageLandingCellInPage } from "../lib/landing-cell-stage.mjs";
import { ProbeRefusal } from "../lib/probe-runtime.mjs";
import { loadRigs } from "../lib/rig-registry.mjs";
import { OriginRewriteRefusal } from "../lib/sandcastle2-origin-rewrite.mjs";
import { readRendererStateInPage } from "../lib/sandcastle2-renderer-gate.mjs";
import {
  WATER_CELLS,
  descriptor,
  summarizeWaterRecords,
  waterVerdicts,
} from "../probe-water-cells.mjs";

// One fresh directory per run: a fixed path would be shared by every clone
// running this runner at once, and one run's cleanup would delete another's.
export const TEMP_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "probe-water-cells-spec-"),
);

after(() => {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});

export const rigs = await loadRigs();
export const rigsById = new Map(rigs.map((rig) => [rig.id, rig]));
export const rigOf = (id) => {
  const rig = rigsById.get(id);
  assert.ok(rig, `rig ${id} is not in the registry`);
  return rig;
};

export const CLOCK = "2026-06-21T16:00:00Z";

export const SIZE = 100;
export const PIXELS = SIZE * SIZE;

/** A flat grey image whose first pixels carry per-channel deltas. */
export function image(spans = []) {
  const data = new Uint8ClampedArray(PIXELS * 4);
  for (let i = 0; i < PIXELS; i += 1) {
    data[i * 4] = 100;
    data[i * 4 + 1] = 100;
    data[i * 4 + 2] = 100;
    data[i * 4 + 3] = 255;
  }
  let cursor = 0;
  for (const { count, channel = 0, delta } of spans) {
    for (let i = 0; i < count; i += 1) {
      data[(cursor + i) * 4 + channel] += delta;
    }
    cursor += count;
  }
  return { width: SIZE, height: SIZE, data };
}

export function makeStore() {
  const files = new Map();
  return {
    put(name, img) {
      files.set(name, img);
      return { path: name, sha256: name };
    },
    loadImage: (file) => {
      assert.ok(files.has(file), `unexpected image load: ${file}`);
      return files.get(file);
    },
  };
}

export function record(store, cell, variant, renderer, run, img, extra = {}) {
  const base = {
    run,
    cell,
    kind: WATER_CELLS[cell].kind,
    variant,
    rig: `${cell}-${variant}`,
    renderer,
    notRun: null,
  };
  if (img !== null) {
    base.capture = store.put(`${cell}/${variant}/${renderer}/${run}`, img);
  }
  return { ...base, ...extra };
}

export const near = (actual, expected, label) =>
  assert.ok(
    typeof actual === "number" && Math.abs(actual - expected) < 1e-9,
    `${label}: expected ${expected}, got ${actual}`,
  );

export const cleanGate = {
  deviceLost: null,
  errorCount: 0,
  errors: [],
  armedDevices: 1,
  pageErrorCount: 0,
};

export const verdict = (verdicts, cell, suffix) =>
  verdicts.find((v) => v.id.startsWith(`${cell}:`) && v.id.endsWith(suffix));
export const verdictsWhere = (verdicts, cell, fragment) =>
  verdicts.filter(
    (v) => v.id.startsWith(`${cell}:`) && v.id.includes(fragment),
  );

export const flat = () => image();
export const moved = (count, delta = 17) => image([{ count, delta }]);

export const refusal = (reason) => (error) => {
  assert.ok(
    error instanceof ProbeRefusal,
    `expected a ProbeRefusal, got ${error}`,
  );
  assert.equal(error.reason, reason);
  return true;
};

/** A stub page's event listeners, so a spec can deliver a `pageerror`. */
export function makeListeners() {
  const listeners = new Map();
  return {
    on(event, fn) {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event).add(fn);
    },
    off(event, fn) {
      listeners.get(event)?.delete(fn);
    },
    emit(event, payload) {
      for (const fn of [...(listeners.get(event) ?? [])]) {
        fn(payload);
      }
    },
  };
}

export const STUB_PNG = Buffer.from(
  encodeRgbaPng(new Uint8Array(8 * 8 * 4), 8, 8),
);

export function stubLocator() {
  return {
    async count() {
      return 1;
    },
    nth: () => ({
      async screenshot() {
        return STUB_PNG;
      },
    }),
    async screenshot() {
      return STUB_PNG;
    },
  };
}

/**
 * A stub browser for leg-2 pages. The page learns its renderer from the URL
 * and its rig from the stage call; the error gate counts a device only after
 * the page's arming call on a WebGPU page, so a page that never arms reads
 * `armedDevices: 0`. Each hook answers per rig (and renderer for `gate`):
 * `notApplied`, `settle` (an override of the settle's answer), `leftovers`
 * (what the chrome strip left), `gate` ({errors, deviceLost}) and `pageError`
 * (a message delivered as a `pageerror` when the rig is staged).
 */
export function makeFakeBrowser(
  log,
  {
    notApplied = () => [],
    settle = () => null,
    leftovers = () => [],
    gate = () => null,
    pageError = () => null,
  } = {},
) {
  const makePage = () => {
    const events = makeListeners();
    const state = { renderer: null, rigId: null, armed: 0 };
    return {
      on: events.on,
      off: events.off,
      // The demo seam's opener delivers a page error on this page.
      emitForSpec: events.emit,
      async goto(url) {
        log.urls.push(String(url));
        state.renderer = new URL(String(url)).searchParams.get("renderer");
      },
      async waitForFunction() {},
      async evaluate(fn, arg) {
        if (fn === stageLandingCellInPage) {
          state.rigId = arg.rigId;
          const message = pageError(arg.rigId);
          if (message) {
            events.emit("pageerror", new Error(message));
          }
          return {
            rigId: arg.rigId,
            dials: {},
            notApplied: notApplied(arg.rigId),
          };
        }
        if (typeof fn === "string") {
          return { removed: 0, leftovers: leftovers(state.rigId) };
        }
        const src = String(fn);
        if (src.includes("_globalWaterMaskLoadPending")) {
          return (
            settle(state.rigId, arg) ?? {
              tilesSettled: true,
              tileFrames: 40,
              frames: arg.frames,
              tilesLoaded: true,
              datasetPending: false,
              elapsedMs: 5,
            }
          );
        }
        if (src.includes("__captureLiveness")) {
          return { gateArmed: true, deviceLost: null, frameNumber: 7 };
        }
        if (src.includes("__armWebGPUDevice")) {
          const armed = state.renderer === "webgpu" ? 1 : 0;
          state.armed += armed;
          return { armed, found: armed, total: state.armed };
        }
        if (src.includes("__webgpuGate")) {
          const answer = gate(state.rigId, state.renderer) ?? {};
          return {
            errors: answer.errors ?? [],
            deviceLost: answer.deviceLost ?? null,
            armedDevices: state.armed,
          };
        }
        throw new Error(`unstubbed evaluate: ${src.slice(0, 120)}`);
      },
      locator: stubLocator,
    };
  };
  return {
    async newContext() {
      log.contexts += 1;
      return {
        async addInitScript() {},
        async newPage() {
          return makePage();
        },
        async close() {},
      };
    },
  };
}

export const byVariant = (records, variant) =>
  records.find((r) => r.variant === variant);

/**
 * The demo-capture seam for cell 1f: an opener that hands the real piece a
 * stub run frame. The frame reports the requested renderer (or
 * `contextRenderer`), counts a device in its error gate only after the
 * piece's arming call on WebGPU, answers the gate with `gateErrors` /
 * `deviceLost`, and the settle with `settle` when given. `pageError` is
 * delivered on the top page while the demo opens; `originBreach` makes the
 * opener throw the origin guard's own refusal.
 */
export function makeDemoDependencies(log, scenario = {}) {
  return {
    async open(page, urlOptions) {
      log.opened.push(urlOptions);
      if (scenario.originBreach) {
        throw new OriginRewriteRefusal(
          "ORIGIN_MISMATCH",
          "the run frame settled on another origin",
        );
      }
      if (scenario.pageError) {
        page.emitForSpec("pageerror", new Error(scenario.pageError));
      }
      const state = { armed: 0 };
      const rendererType = scenario.contextRenderer ?? urlOptions.renderer;
      const frame = {
        async waitForFunction() {},
        // The run frame's iframe element on the top page, pinned to the viewport.
        async frameElement() {
          return {
            async evaluate() {
              return {
                width: 1280,
                height: 720,
                viewport: { width: 1280, height: 720 },
              };
            },
          };
        },
        async evaluate(fn, arg) {
          if (fn === readRendererStateInPage) {
            return {
              contexts: [{ id: "ctx-stub", rendererType }],
              frameNumbers: [900],
              note: "",
            };
          }
          if (typeof fn === "string") {
            // The viewer chrome strip: nothing is left over the canvas.
            return fn.includes("cesium-viewer-toolbar")
              ? { removed: 3, leftovers: [] }
              : undefined;
          }
          // The declared canvas size; read before the ion wait, whose argument
          // also carries timeoutMs.
          if (arg && arg.selector !== undefined) {
            return {
              found: true,
              cssWidth: arg.width,
              cssHeight: arg.height,
              matched: true,
              waitedMs: 0,
            };
          }
          // The demo shell's own chrome, removed by selector.
          if (arg && arg.selectors !== undefined) {
            return 1;
          }
          if (arg && arg.timeoutMs !== undefined) {
            return {
              tokenPresent: true,
              terrainResolved: true,
              terrainProvider: "CesiumTerrainProvider",
              hasWaterMask: true,
              waitedMs: 5,
            };
          }
          if (arg && arg.iso !== undefined) {
            return scenario.clockAnswer ?? { applied: true, observed: arg.iso };
          }
          if (arg && arg.frames !== undefined) {
            return (
              scenario.settle ?? {
                outcome: "done",
                frames: arg.frames,
                settledFrames: arg.frames,
                frameNumber: 900,
                tilesLoaded: true,
              }
            );
          }
          const src = String(fn);
          if (src.includes("__captureLiveness")) {
            return { gateArmed: true, deviceLost: null, frameNumber: 901 };
          }
          if (src.includes("__armWebGPUDevice")) {
            const armed = rendererType === "webgpu" ? 1 : 0;
            state.armed += armed;
            return { found: armed, armed, gateInstalled: true };
          }
          if (src.includes("__webgpuGate")) {
            return {
              errors: scenario.gateErrors ?? [],
              deviceLost: scenario.deviceLost ?? null,
              armedDevices: state.armed,
            };
          }
          throw new Error(`unstubbed frame evaluate: ${src.slice(0, 120)}`);
        },
        locator: stubLocator,
      };
      return {
        url: "http://localhost:8080/stub",
        finalUrl: "http://localhost:8080/stub",
        bucketFrame: frame,
        bucketFinalUrl: "http://localhost:8081/stub",
        assertNoOriginBreach() {},
      };
    },
  };
}

/**
 * Run `descriptor.cells` on the stub browser (and, for 1f, the stub run
 * frame), then summarise and judge the records as the runtime would.
 */
export async function runE({
  outName,
  cells,
  renderers = ["webgpu"],
  arm = "before",
  hooks = {},
  demo = {},
}) {
  const log = { urls: [], contexts: 0, opened: [] };
  const records = await descriptor.cells({
    browser: makeFakeBrowser(log, hooks),
    run: 0,
    options: { arm, cells, renderers },
    origin: "http://localhost:8080",
    outputDirectory: path.join(TEMP_ROOT, outName),
    captures: [],
    demoCaptureDependencies: makeDemoDependencies(log, demo),
  });
  const verdicts = waterVerdicts(
    records,
    summarizeWaterRecords(records),
    null,
    {
      arm,
    },
  );
  return { records, verdicts, log };
}

export const pageVerdict = (verdicts, rec, suffix) =>
  verdicts.find(
    (v) =>
      v.id ===
      `${rec.cell}:${rec.variant}:${rec.renderer}:run${rec.run}:${suffix}`,
  );
