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
);
