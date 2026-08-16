// @purpose Dev build helper: converts WGSL then runs buildEngine/buildWidgets/buildCesium (development, unminified, sourcemapped) skipping tsc.
// @status ACTIVE

import {
  wgslToJavaScript,
  buildEngine,
  buildWidgets,
  buildCesium,
} from "./build.js";

console.log("Converting WGSL shaders...");
await wgslToJavaScript(false, "Build/minifyShaders.state", "engine");

const buildOptions = {
  development: true,
  iife: true,
  minify: false,
  removePragmas: false,
  sourcemap: true,
  node: true,
};

console.log("Building engine...");
await buildEngine(buildOptions);
console.log("Building widgets...");
await buildWidgets(buildOptions);
console.log("Building cesium...");
await buildCesium(buildOptions);
console.log("DONE");
