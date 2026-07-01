#!/usr/bin/env node
// Static validation of the PostProcess `_f16.wgsl` shader variants
// (PARITY-F16-POSTPROCESS) through naga's wgsl-in frontend + validator
// (Tools/shader-pipeline/naga-wasm-tools). Anything naga rejects —
// including `enable f16;` semantic errors — fails the run.
//
// This is the compile-verification companion to
// probe-postprocess-f16.mjs for machines whose GPU does not grant the
// `shader-f16` device feature (e.g. NVIDIA Pascal), where the browser
// can never compile the f16 variants at runtime.
//
// Usage (from repo root): node Tools/visual-regression/validate-f16-wgsl.mjs
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import init, { validate_wgsl } from "../shader-pipeline/naga-wasm-tools/naga_wasm_tools.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
await init({
  module_or_path: readFileSync(
    join(here, "..", "shader-pipeline", "naga-wasm-tools", "naga_wasm_tools_bg.wasm"),
  ),
});

const dir = join(repoRoot, "packages/engine/Source/Shaders/WebGPU/PostProcess");
const files = readdirSync(dir).filter((f) => f.endsWith("_f16.wgsl"));
let fail = 0;
for (const f of files) {
  const src = readFileSync(join(dir, f), "utf8");
  try {
    validate_wgsl(src);
    console.log(`OK    ${f}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${f}: ${String(e).slice(0, 500)}`);
  }
}
console.log(fail === 0 ? "ALL VALID" : `${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
