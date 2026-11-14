// landing-cloud-reconstruction-support.mjs - the stand-in page for the cloud reconstruction staging specs.
// @purpose Spec support for lib/landing-cloud-reconstruction.mjs: a modeled WebGPU page (viewer, scene, cloud cache, CPU renderer statistics) whose public cloudReconstruction method is the shipped body cut out of CesiumDebug.js, plus the engine's own define mask for the directional-lighting and deep-shadow family.
// @status ACTIVE
//
// Signed Brilthor. The page is READY by default: every field the readiness predicate reads holds the value the
// 1080p MEDIUM reconstruction rig expects. A spec varies exactly the one field a guard reads, through the `change`
// hook, and proves the refusal against that guard's own message.

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createFakeViewer } from "./landing-cell-stage-support.mjs";
import { ShaderDefineHi } from "../lib/wgsl-variant.mjs";

/** Bit 16 and bit 17 of the high define word, read from the engine's define table. */
export const FAMILY_DIRECTIONAL = ShaderDefineHi.CLOUD_DIRECTIONAL_LIGHTING;
export const FAMILY_DEEP_SHADOW = ShaderDefineHi.CLOUD_DEEP_SHADOW_CACHE;
export const FAMILY_MASK = FAMILY_DIRECTIONAL | FAMILY_DEEP_SHADOW;

/** The bytes the three owned 8-byte attachment targets take at 960x540. */
export const HALF_LIVE_BYTES = 960 * 540 * 24;

const GLOBAL_NAMES = [
  "viewer",
  "window",
  "devicePixelRatio",
  "CesiumDebug",
  "__cloudProbe",
  "requestAnimationFrame",
];

/**
 * Install the modeled page on `globalThis` and restore every global it touched
 * when `t` ends. `change(fixture)` runs last, so it may replace any of it.
 *
 * @param {{after: Function}} t The test context that owns the cleanup.
 * @param {(fixture: object) => void} [change] Varies one field.
 * @returns {{viewer: object, context: object, cache: object, stats: object,
 *   calls: unknown[][], frames: unknown[], renderStep: Function}}
 */
export function reconstructionPage(t, change = () => {}) {
  const saved = GLOBAL_NAMES.map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]);
  t.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const viewer = createFakeViewer();
  const calls = [],
    frames = [];
  const cache = {
    reconstructionEnabled: false,
    attachmentsEnabled: false,
    primaryReuseApplied: false,
    usingStartupPreview: false,
    selectedMarchDefinesHi: FAMILY_MASK,
  };
  const stats = {
    frames: 0,
    raymarch: {
      width: 960,
      height: 540,
      halfResActive: true,
      maxSteps: 48,
      lightSteps: 4,
      requestedPrimarySteps: 48,
      requestedLightSteps: 4,
      qualityFlags: 15,
      budgetRefused: false,
    },
    reconstruction: {
      resolveWidth: 960,
      resolveHeight: 540,
      attachments: {
        produced: true,
        width: 960,
        height: 540,
        targetCount: 4,
        liveBytes: HALF_LIVE_BYTES,
      },
      emission: {
        requested: false,
        emitted: true,
        consumed: true,
        producerTargets: 2,
      },
    },
    passes: {
      "ProceduralClouds half-res pass": 1,
      "CloudTemporalResolve pass": 1,
      "CloudUpscale composite pass": 1,
      "CloudPrimaryReuse march pass": 0,
    },
  };
  const context = viewer.scene.context;
  context._cloudCache = cache;
  context.getRendererStatistics = () => ({ volumetricClouds: stats });
  viewer.scene._context = context;
  viewer.scene.frameState = { frameNumber: 0 };
  viewer.scene.canvas = viewer.canvas = {
    width: 1920,
    height: 1080,
    clientWidth: 1920,
    clientHeight: 1080,
  };
  viewer.scene.drawingBufferWidth = 1920;
  viewer.scene.drawingBufferHeight = 1080;
  viewer.scene.globe.defaultCloudCollection.volumetric = {
    cloudVolumetricQuality: "medium",
  };
  viewer.useDefaultRenderLoop = false;
  viewer.clock.shouldAnimate = false;
  viewer.scene.requestRender = () => {};
  // One modeled frame: the frame counter advances and the emission request
  // follows the cache flag, as the engine does. A spec replaces `renderStep`
  // to change what a frame does and leaves `render` alone.
  const fixture = {
    viewer,
    context,
    cache,
    stats,
    calls,
    frames,
    renderStep() {
      viewer.scene.frameState.frameNumber++;
      stats.frames++;
      stats.reconstruction.emission.requested =
        cache.reconstructionEnabled === true;
    },
  };
  viewer.scene.render = (time) => {
    frames.push(time);
    fixture.renderStep(time);
  };
  const source = readFileSync(
    new URL(
      "../../../packages/engine/Source/Scene/CesiumDebug.js",
      import.meta.url,
    ),
    "utf8",
  );
  const start = source.indexOf("    cloudReconstruction(enabled) {");
  const end = source.indexOf("\n    },", start);
  if (!(start >= 0 && end > start)) {
    throw new Error("the committed public Debug method must be present");
  }
  const publicMethod = runInNewContext(
    "({" + source.slice(start, end + 7) + "})",
    {
      scene: viewer.scene,
      console: { log() {}, warn() {}, table() {} },
    },
  ).cloudReconstruction;
  globalThis.window = globalThis;
  globalThis.devicePixelRatio = 1;
  globalThis.viewer = viewer;
  globalThis.CesiumDebug = {
    cloudReconstruction(...args) {
      calls.push(args);
      return Reflect.apply(publicMethod, this, args);
    },
  };
  globalThis.__cloudProbe = { configure: () => ({ ok: true }) };
  globalThis.requestAnimationFrame = (callback) =>
    setTimeout(() => callback(performance.now()), 0);
  change(fixture);
  return fixture;
}

/** The run options every guard case uses: four renders, two stable reads. */
export const RECON_RUN = { deadlineMs: 1000, maxFrames: 4, settleReads: 2 };
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * The unready refusal prints the last observed record, so `fragment` (a piece
 * of that JSON) ties a refusal to the field the case varied.
 */
const notReady = (fragment) =>
  new RegExp(
    "cloud reconstruction: not ready after 4 renders; .*" +
      escapeRegExp(fragment),
  );

/**
 * One entry per guard of lib/landing-cloud-reconstruction.mjs. `cases()`
 * returns [name, change, matcher, options?] rows: `change(fixture)` varies the
 * one field the guard reads, `matcher` is the guard's own message (or, for the
 * unready refusals, the message plus the offending value), `options` replaces
 * RECON_RUN.
 */
export const reconstructionGuards = {
  defineFamily: {
    title:
      "the define family needs both the directional-lighting and the deep-shadow bits",
    cases: () => {
      const withMask = (mask) => (f) => {
        f.cache.selectedMarchDefinesHi = mask;
      };
      return [
        ["no define bit", withMask(0), notReady(`"selectedMarchDefinesHi":0`)],
        [
          "the directional-lighting bit alone",
          withMask(FAMILY_DIRECTIONAL),
          notReady(`"selectedMarchDefinesHi":${FAMILY_DIRECTIONAL}`),
        ],
        [
          "the deep-shadow bit alone",
          withMask(FAMILY_DEEP_SHADOW),
          notReady(`"selectedMarchDefinesHi":${FAMILY_DEEP_SHADOW}`),
        ],
        [
          "the neighbouring bits instead of the family",
          withMask((FAMILY_DIRECTIONAL >> 1) | (FAMILY_DEEP_SHADOW << 1)),
          notReady(
            `"selectedMarchDefinesHi":${(FAMILY_DIRECTIONAL >> 1) | (FAMILY_DEEP_SHADOW << 1)}`,
          ),
        ],
      ];
    },
  },
  liveBytes: {
    title:
      "the attachments' live bytes are the three owned half-resolution targets",
    cases: () => {
      const withBytes = (bytes) => (f) => {
        f.stats.reconstruction.attachments.liveBytes = bytes;
      };
      return [
        [
          "one byte short",
          withBytes(HALF_LIVE_BYTES - 1),
          notReady(`"liveBytes":${HALF_LIVE_BYTES - 1}`),
        ],
        [
          "two targets' bytes",
          withBytes((HALF_LIVE_BYTES / 3) * 2),
          notReady(`"liveBytes":${(HALF_LIVE_BYTES / 3) * 2}`),
        ],
        ["no bytes", withBytes(0), notReady(`"liveBytes":0`)],
      ];
    },
  },
  frameFreshness: {
    title: "each read must follow a fresh frame, counted as a safe integer",
    cases: () => {
      const stuck = (f) => {
        f.stats.frames = 7;
        f.renderStep = () => {
          f.stats.reconstruction.emission.requested =
            f.cache.reconstructionEnabled === true;
        };
      };
      const backwards = (f) => {
        f.stats.frames = 100;
        f.renderStep = () => {
          f.stats.frames--;
          f.stats.reconstruction.emission.requested =
            f.cache.reconstructionEnabled === true;
        };
      };
      const asText = (f) => {
        let count = 0;
        f.renderStep = () => {
          f.stats.frames = String(++count);
          f.stats.reconstruction.emission.requested =
            f.cache.reconstructionEnabled === true;
        };
      };
      return [
        [
          "a frame counter that does not advance",
          stuck,
          notReady(`"frames":7`),
        ],
        [
          "a frame counter that runs backwards",
          backwards,
          notReady(`"frames":96`),
        ],
        ["a frame counter that is text", asText, notReady(`"frames":"`)],
      ];
    },
  },
  reuseAndPreview: {
    title: "no primary reuse, no startup preview and no reuse pass",
    cases: () => {
      return [
        [
          "primary reuse applied",
          (f) => {
            f.cache.primaryReuseApplied = true;
          },
          notReady(`"primaryReuseApplied":true`),
        ],
        [
          "startup preview in use",
          (f) => {
            f.cache.usingStartupPreview = true;
          },
          notReady(`"preview":true`),
        ],
        [
          "one reuse march pass",
          (f) => {
            f.stats.passes["CloudPrimaryReuse march pass"] = 1;
          },
          notReady(`"reuse":1`),
        ],
      ];
    },
  },
  viewport: {
    title: "the viewport is 1920x1080 at a device-pixel ratio of 1",
    cases: () => {
      const viewport = (width, height) => (f) => {
        f.viewer.scene.drawingBufferWidth = width;
        f.viewer.scene.drawingBufferHeight = height;
      };
      return [
        [
          "1280x720",
          viewport(1280, 720),
          notReady(`"viewport":{"width":1280,"height":720,"dpr":1}`),
        ],
        [
          "a 1280 wide buffer",
          viewport(1280, 1080),
          notReady(`"viewport":{"width":1280,"height":1080,"dpr":1}`),
        ],
        [
          "a 720 high buffer",
          viewport(1920, 720),
          notReady(`"viewport":{"width":1920,"height":720,"dpr":1}`),
        ],
        [
          "a device-pixel ratio of 2",
          () => {
            globalThis.devicePixelRatio = 2;
          },
          notReady(`"viewport":{"width":1920,"height":1080,"dpr":2}`),
        ],
      ];
    },
  },
  frozenClock: {
    title:
      "the manual frozen clock stays the stage's, at every point of the run",
    cases: () => {
      const lost = /cloud reconstruction: manual frozen-clock ownership lost/;
      return [
        [
          "the default render loop was on from the start",
          (f) => {
            f.viewer.useDefaultRenderLoop = true;
          },
          lost,
        ],
        [
          "the clock was animating from the start",
          (f) => {
            f.viewer.clock.shouldAnimate = true;
          },
          lost,
        ],
        [
          "the clock starts running during the first frame",
          (f) => {
            const step = f.renderStep;
            f.renderStep = (time) => {
              step(time);
              f.viewer.clock.shouldAnimate = true;
            };
          },
          lost,
        ],
        [
          "the default render loop comes back during the public readback",
          (f) => {
            const read = globalThis.CesiumDebug.cloudReconstruction;
            globalThis.CesiumDebug.cloudReconstruction = (...args) => {
              const result = read(...args);
              if (args.length === 0) f.viewer.useDefaultRenderLoop = true;
              return result;
            };
          },
          lost,
        ],
      ];
    },
  },
  deadline: {
    title: "the readiness deadline is enforced between frames",
    cases: () => {
      return [
        [
          "a frame that outlasts the deadline",
          (f) => {
            const step = f.renderStep;
            f.renderStep = (time) => {
              step(time);
              const until = performance.now() + 20;
              while (performance.now() < until);
            };
          },
          /cloud reconstruction: readiness deadline/,
          { deadlineMs: 5, maxFrames: 4, settleReads: 2 },
        ],
      ];
    },
  },
  settleReads: {
    title:
      "readiness must hold on settleReads consecutive fresh reads, not on scattered ones",
    cases: () => {
      return [
        [
          "ready on alternate frames only",
          (f) => {
            const step = f.renderStep;
            f.renderStep = (time) => {
              step(time);
              f.stats.reconstruction.emission.emitted =
                f.stats.frames % 2 === 1;
            };
          },
          notReady(`"emitted":false`),
        ],
      ];
    },
  },
  activationApplied: {
    title: "a public activation that did not take is refused as such",
    cases: () => {
      const notApplied = /cloud reconstruction: public activation not applied/;
      // The public setter, with one part of its result or its effect removed.
      const setter = (alter) => () => {
        const real = globalThis.CesiumDebug.cloudReconstruction;
        globalThis.CesiumDebug.cloudReconstruction = (...args) =>
          args.length === 1 ? alter(real, args) : real(...args);
      };
      return [
        [
          "a setter that reports nothing and sets nothing",
          () => {
            globalThis.CesiumDebug.cloudReconstruction = () => ({
              requested: false,
            });
          },
          notApplied,
        ],
        [
          "a setter that sets both flags but returns nothing",
          setter((real, args) => {
            real(...args);
            return undefined;
          }),
          notApplied,
        ],
        [
          "a setter that leaves the reconstruction flag off",
          (f) => {
            const real = globalThis.CesiumDebug.cloudReconstruction;
            globalThis.CesiumDebug.cloudReconstruction = (...args) => {
              const result = real(...args);
              if (args.length === 1) f.cache.reconstructionEnabled = false;
              return result;
            };
          },
          notApplied,
        ],
        [
          "a setter that leaves the attachments flag off",
          (f) => {
            const real = globalThis.CesiumDebug.cloudReconstruction;
            globalThis.CesiumDebug.cloudReconstruction = (...args) => {
              const result = real(...args);
              if (args.length === 1) f.cache.attachmentsEnabled = false;
              return result;
            };
          },
          notApplied,
        ],
      ];
    },
  },
  requiredApi: {
    title:
      "a page without the WebGPU context or the Debug API is refused by name",
    cases: () => {
      const unavailable =
        /cloud reconstruction: required WebGPU\/Debug API unavailable/;
      return [
        [
          "no Debug object",
          () => {
            globalThis.CesiumDebug = undefined;
          },
          unavailable,
        ],
        [
          "a Debug object without cloudReconstruction",
          () => {
            globalThis.CesiumDebug = {};
          },
          unavailable,
        ],
        [
          "a WebGL context",
          (f) => {
            f.context.isWebGPU = false;
          },
          unavailable,
        ],
        [
          "no renderer statistics",
          (f) => {
            delete f.context.getRendererStatistics;
          },
          unavailable,
        ],
        [
          "no requestRender",
          (f) => {
            delete f.viewer.scene.requestRender;
          },
          unavailable,
        ],
        [
          "no render",
          (f) => {
            delete f.viewer.scene.render;
          },
          unavailable,
        ],
      ];
    },
  },
  readinessRecord: {
    title: "the rest of the readiness record, each field on its own",
    cases: () => {
      const field = (path, value) => (f) => {
        const keys = path.split(".");
        const last = keys.pop();
        keys.reduce((object, key) => object[key], f)[last] = value;
      };
      return [
        [
          "emission not requested",
          (f) => {
            f.renderStep = () => {
              f.stats.frames++;
              f.stats.reconstruction.emission.requested = false;
            };
          },
          notReady(`"requested":false`),
        ],
        [
          "emission not emitted",
          field("stats.reconstruction.emission.emitted", false),
          notReady(`"emitted":false`),
        ],
        [
          "emission not consumed",
          field("stats.reconstruction.emission.consumed", false),
          notReady(`"consumed":false`),
        ],
        [
          "one producer target",
          field("stats.reconstruction.emission.producerTargets", 1),
          notReady(`"producerTargets":1`),
        ],
        [
          "attachments not produced",
          field("stats.reconstruction.attachments.produced", false),
          notReady(`"produced":false`),
        ],
        [
          "full-resolution attachments",
          field("stats.reconstruction.attachments.width", 1920),
          notReady(`"width":1920,"height":540`),
        ],
        [
          "full-resolution march",
          field("stats.raymarch.height", 1080),
          notReady(`"width":960,"height":1080`),
        ],
        [
          "half resolution inactive",
          field("stats.raymarch.halfResActive", false),
          notReady(`"halfResActive":false`),
        ],
        [
          "a budget refusal",
          field("stats.raymarch.budgetRefused", true),
          notReady(`"budgetRefused":true`),
        ],
        [
          "quality flags without all four low bits",
          field("stats.raymarch.qualityFlags", 7),
          notReady(`"qualityFlags":7`),
        ],
        [
          "requested primary steps off the medium tier",
          field("stats.raymarch.requestedPrimarySteps", 90),
          notReady(`"requestedPrimarySteps":90`),
        ],
        [
          "requested light steps off the medium tier",
          field("stats.raymarch.requestedLightSteps", 8),
          notReady(`"requestedLightSteps":8`),
        ],
        [
          "no half-resolution pass",
          field("stats.passes.ProceduralClouds half-res pass", 0),
          notReady(`"half":0`),
        ],
        [
          "no temporal resolve pass",
          field("stats.passes.CloudTemporalResolve pass", 0),
          notReady(`"temporal":0`),
        ],
        [
          "no upscale composite pass",
          field("stats.passes.CloudUpscale composite pass", 0),
          notReady(`"upscale":0`),
        ],
        [
          "full-resolution attachment height",
          field("stats.reconstruction.attachments.height", 1080),
          notReady(`"height":1080,"liveBytes"`),
        ],
        [
          "reconstruction switched off in the cache after the activation",
          (f) => {
            f.renderStep = () => {
              f.stats.frames++;
              f.cache.reconstructionEnabled = false;
              f.stats.reconstruction.emission.requested = true;
            };
          },
          notReady(`"enabled":false`),
        ],
        [
          "attachments switched off in the cache after the activation",
          (f) => {
            f.renderStep = () => {
              f.stats.frames++;
              f.cache.attachmentsEnabled = false;
              f.stats.reconstruction.emission.requested = true;
            };
          },
          notReady(`"attachmentsEnabled":false`),
        ],
      ];
    },
  },
};
