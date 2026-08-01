/**
 * Naga compatibility test harness.
 *
 * Feeds real Cesium GLSL shaders through the `cesium-naga-wasm` runtime
 * build and reports which ones translate cleanly vs. fail.
 *
 * This answers the central risk from the Naga spike discussion: naga's
 * GLSL frontend is documented as supporting "GLSL 440+ and Vulkan
 * semantics only." Cesium's WebGL shaders are GLSL ES 3.00. How much
 * does that gap actually matter in practice? This script gives us the
 * concrete answer by running every .glsl file in Source/Shaders/ through
 * the translator and counting accept / reject / runtime-error outcomes.
 *
 * Usage:
 *   node test-compatibility.mjs                    # run all shaders
 *   node test-compatibility.mjs --fragments-only   # fragment stage only
 *   node test-compatibility.mjs --verbose          # print failure details
 */

import { readFile, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SHADER_ROOT = join(__dirname, "..", "engine", "Source", "Shaders");

const VERBOSE = process.argv.includes("--verbose");
const FRAGMENTS_ONLY = process.argv.includes("--fragments-only");

async function loadNaga() {
  // On Windows, Node's ESM loader rejects bare absolute paths like
  // `F:/Dev/...` — we need `file://` URLs. `pathToFileURL` handles the
  // cross-platform conversion.
  const modUrl = pathToFileURL(
    join(__dirname, "pkg", "cesium_naga_wasm.js"),
  ).href;
  const mod = await import(modUrl);
  // wasm-pack `--target web` expects a fetch-able URL. In Node we pass the
  // raw bytes so we don't need to stand up a server.
  const wasmBytes = await readFile(
    join(__dirname, "pkg", "cesium_naga_wasm_bg.wasm"),
  );
  await mod.default({ module_or_path: wasmBytes });
  return mod;
}

/**
 * Stage inference for Cesium's naming convention.
 * — `*VS.glsl`          → vertex
 * — `*FS.glsl` or `*FS_*.glsl` → fragment
 * — `*CS.glsl`          → compute (rare)
 * — Everything else      → skip (chunks / includes that aren't standalone)
 */
function inferStage(filename) {
  const base = basename(filename, ".glsl");
  if (/VS(_.*)?$/.test(base)) {
    return "vertex";
  }
  if (/FS(_.*)?$/.test(base)) {
    return "fragment";
  }
  if (/CS(_.*)?$/.test(base)) {
    return "compute";
  }
  return null; // not a standalone stage
}

async function* walkShaders(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) {
      // Skip the WebGPU subtree (.wgsl) — we're testing naga's GLSL input.
      if (e.name === "WebGPU" || e.name === "Generated") {
        continue;
      }
      yield* walkShaders(full);
    } else if (e.name.endsWith(".glsl")) {
      yield full;
    }
  }
}

function classifyError(msg) {
  // Categorise failure modes so we can report which kinds are fixable
  // via a preprocessor pass vs. which need real fixes.
  if (/precision\s+(highp|mediump|lowp)/i.test(msg)) {
    return "precision";
  }
  if (/version\s+\d{3}/i.test(msg)) {
    return "version";
  }
  if (/#extension/i.test(msg)) {
    return "extension";
  }
  if (/sampler(1D|2D|3D|Cube)Shadow/i.test(msg)) {
    return "shadow-sampler";
  }
  if (/\bvarying\b|\battribute\b/i.test(msg)) {
    return "webgl-keywords";
  }
  if (/layout.*std140|layout.*std430/i.test(msg)) {
    return "ubo-layout";
  }
  if (/cannot find|undeclared/i.test(msg)) {
    return "missing-symbol";
  }
  if (/ParseError|parse error/i.test(msg)) {
    return "parse-error";
  }
  if (/type.*mismatch|expected.*got/i.test(msg)) {
    return "type-error";
  }
  return "other";
}

async function main() {
  console.log("Loading naga-wasm…");
  const naga = await loadNaga();
  console.log(
    `  exports: ${Object.keys(naga)
      .filter((k) => typeof naga[k] === "function")
      .join(", ")}`,
  );
  console.log();

  const stats = {
    tested: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    byStage: { vertex: [0, 0], fragment: [0, 0], compute: [0, 0] },
    errorCategories: {},
    failedFiles: [],
  };

  for await (const file of walkShaders(SHADER_ROOT)) {
    const stage = inferStage(file);
    if (!stage) {
      stats.skipped++;
      continue;
    }
    if (FRAGMENTS_ONLY && stage !== "fragment") {
      continue;
    }

    stats.tested++;
    const source = await readFile(file, "utf8");
    const relPath = file.replace(SHADER_ROOT, ".");

    try {
      const wgsl = naga.glsl_to_wgsl(source, stage);
      if (wgsl && wgsl.length > 0) {
        stats.succeeded++;
        stats.byStage[stage][0]++;
        if (VERBOSE) {
          console.log(`✓ ${relPath} (${stage}) → ${wgsl.length}B WGSL`);
        }
      } else {
        stats.failed++;
        stats.byStage[stage][1]++;
        stats.failedFiles.push({ file: relPath, stage, error: "empty output" });
      }
    } catch (err) {
      stats.failed++;
      stats.byStage[stage][1]++;
      const msg = err.message ?? String(err);
      const category = classifyError(msg);
      stats.errorCategories[category] =
        (stats.errorCategories[category] ?? 0) + 1;
      stats.failedFiles.push({ file: relPath, stage, error: msg, category });
      if (VERBOSE) {
        console.log(`✗ ${relPath} (${stage}) [${category}]`);
        console.log(`  ${msg.slice(0, 300)}${msg.length > 300 ? "…" : ""}`);
      }
    }
  }

  console.log("\n─".repeat(60));
  console.log(`Total tested : ${stats.tested}`);
  console.log(
    `  Succeeded  : ${stats.succeeded}  (${((stats.succeeded / stats.tested) * 100).toFixed(1)}%)`,
  );
  console.log(`  Failed     : ${stats.failed}`);
  console.log(`  Skipped    : ${stats.skipped} (not a standalone stage)`);
  console.log();
  console.log(`By stage:`);
  for (const [stage, [ok, fail]] of Object.entries(stats.byStage)) {
    const total = ok + fail;
    if (total === 0) {
      continue;
    }
    console.log(
      `  ${stage.padEnd(10)} ${ok}/${total}  (${((ok / total) * 100).toFixed(1)}%)`,
    );
  }

  if (stats.failed > 0) {
    console.log();
    console.log(`Error categories:`);
    const sorted = Object.entries(stats.errorCategories).sort(
      (a, b) => b[1] - a[1],
    );
    for (const [cat, count] of sorted) {
      console.log(`  ${cat.padEnd(18)} ${count}`);
    }

    if (!VERBOSE) {
      console.log();
      console.log(`First 10 failures (use --verbose for full detail):`);
      for (const f of stats.failedFiles.slice(0, 10)) {
        console.log(`  ${f.file} (${f.stage}) [${f.category}]`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
