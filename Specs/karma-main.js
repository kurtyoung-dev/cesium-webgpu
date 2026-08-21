/*global __karma__*/
import customizeJasmine from "./customizeJasmine.js";

let includeCategory = "";
let excludeCategory = "";
let webglValidation = false;
let webglStub = false;
let release = false;
let debugCanvasWidth;
let debugCanvasHeight;

let offline = false;
let webgpuDemanded = false;
let webgpuRequiredTier;

const WEBGPU_TIER_PREFIX = "--webgpu-tier=";

if (__karma__.config.args) {
  includeCategory = __karma__.config.args[0];
  excludeCategory = __karma__.config.args[1];
  webglValidation = __karma__.config.args[2];
  webglStub = __karma__.config.args[3];
  release = __karma__.config.args[4];
  debugCanvasWidth = __karma__.config.args[5];
  debugCanvasHeight = __karma__.config.args[6];
  // C11-134 — read by token, not position: the tail of this arg list is shared
  // with the jasmine adapter's own `--grep` pair, so a positional index here
  // would break the moment either side gains an argument.
  offline = __karma__.config.args.includes("--offline");
  // Same token discipline for the Scene-level WebGPU lane. `--webgpu` demands
  // that the lane execute — a run in which it is skipped fails instead of
  // reporting green, because a skipped suite is invisible under
  // `specReporter.suppressSkipped`.
  webgpuDemanded = __karma__.config.args.includes("--webgpu");
  const tierArgument = __karma__.config.args.find(
    (argument) =>
      typeof argument === "string" && argument.startsWith(WEBGPU_TIER_PREFIX),
  );
  webgpuRequiredTier = tierArgument
    ? tierArgument.slice(WEBGPU_TIER_PREFIX.length)
    : undefined;
}

if (release) {
  window.CESIUM_BASE_URL = "base/Build/Cesium";
} else {
  window.CESIUM_BASE_URL = "base/Build/CesiumUnminified";
}

jasmine.DEFAULT_TIMEOUT_INTERVAL = 30000;
customizeJasmine(
  jasmine.getEnv(),
  includeCategory,
  excludeCategory,
  webglValidation,
  webglStub,
  release,
  debugCanvasWidth,
  debugCanvasHeight,
  offline,
  webgpuDemanded,
  webgpuRequiredTier,
);
