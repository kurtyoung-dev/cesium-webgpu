/**
 * Build script for all CesiumJS Rust → WASM modules.
 *
 * Builds two sibling crates:
 *
 *   1. `packages/wasm/`        — cesium-wasm (SIMD culling + radix sort +
 *                                terrain tessellation + RTE + point-cloud).
 *                                Vendored into
 *                                `packages/engine/Source/ThirdParty/Workers/`.
 *
 *   2. `packages/wasm-naga/`   — cesium-naga-wasm (lazy GLSL / SPIR-V → WGSL
 *                                translation for the WebGL compatibility stub).
 *                                Runtime variant is vendored into
 *                                `packages/engine/Source/ThirdParty/naga-wasm/`.
 *                                An optional tooling variant (adds MSL / HLSL /
 *                                SPIR-V backends) is vendored into
 *                                `Tools/shader-pipeline/naga-wasm-tools/` when
 *                                `--include-naga-tooling` is passed.
 *
 * Usage:
 *   node scripts/buildWasm.js                       — build both crates (release)
 *   node scripts/buildWasm.js --debug                — build debug (faster compile, bigger output)
 *   node scripts/buildWasm.js --check                — only verify toolchain, don't build
 *   node scripts/buildWasm.js --clean                — remove all WASM output + vendored artifacts
 *   node scripts/buildWasm.js --skip-cesium-wasm     — skip the cesium-wasm crate
 *   node scripts/buildWasm.js --skip-naga            — skip the naga crate entirely
 *   node scripts/buildWasm.js --only-naga            — build ONLY the naga crate
 *   node scripts/buildWasm.js --include-naga-tooling — also build the naga tooling variant
 *                                                       (adds MSL/HLSL/SPIR-V output exports)
 *
 * Prerequisites:
 *   - Rust toolchain (rustup, cargo): https://rustup.rs/
 *   - wasm-pack: cargo install wasm-pack  (or: npm i -g wasm-pack)
 *   - wasm32-unknown-unknown target: rustup target add wasm32-unknown-unknown
 */

import { execSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  rmSync,
  statSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { resolve, join } from "path";

// ── Paths ────────────────────────────────────────────────────────────────────
const ROOT = resolve(import.meta.dirname, "..");

// ── CLI flags ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const isDebug = args.includes("--debug");
const isCheck = args.includes("--check");
const isClean = args.includes("--clean");
const skipCesium = args.includes("--skip-cesium-wasm");
const skipNaga = args.includes("--skip-naga");
const onlyNaga = args.includes("--only-naga");
const includeNagaTooling = args.includes("--include-naga-tooling");

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[buildWasm] ${msg}`);
}

function error(msg) {
  console.error(`[buildWasm] ❌ ${msg}`);
}

function success(msg) {
  console.log(`[buildWasm] ✅ ${msg}`);
}

/**
 * Run a shell command synchronously, inheriting stdio.
 * Returns true on success, false on failure.
 */
function run(cmd, cwd) {
  try {
    execSync(cmd, {
      cwd: cwd ?? ROOT,
      stdio: "inherit",
      env: { ...process.env },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a CLI tool is available.
 */
function hasCommand(name) {
  try {
    execSync(process.platform === "win32" ? `where ${name}` : `which ${name}`, {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Format file size in human-readable form.
 */
function fileSize(path) {
  try {
    const bytes = statSync(path).size;
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  } catch {
    return "?";
  }
}

/**
 * Copy a file if it exists, logging the source → dest mapping.
 */
function copyIfExists(src, dst, label) {
  if (!existsSync(src)) {
    return false;
  }
  copyFileSync(src, dst);
  log(
    `  ${label}: ${src} → ${dst}${existsSync(dst) ? ` (${fileSize(dst)})` : ""}`,
  );
  return true;
}

/**
 * Rewrite the `new URL("…_bg.wasm", import.meta.url)` reference inside a
 * wasm-pack JS glue file so it points at the vendored filename (which may
 * differ from the crate's `cesium_<crate>_wasm_bg.wasm` pattern). Also
 * rewrites the `@ts-self-types` header to match the renamed .d.ts.
 */
function renameWasmReferencesInGlue(glueFile, fromBase, toBase) {
  if (!existsSync(glueFile)) {
    return;
  }
  const original = readFileSync(glueFile, "utf8");
  const replaced = original
    .replaceAll(`${fromBase}_bg.wasm`, `${toBase}_bg.wasm`)
    .replaceAll(`${fromBase}.d.ts`, `${toBase}.d.ts`);
  if (replaced !== original) {
    writeFileSync(glueFile, replaced);
    log(`  patched: ${glueFile} (${fromBase} → ${toBase})`);
  }
}

// ── Build a single crate + vendor its outputs ────────────────────────────────
//
// Factored out of the original cesium-wasm flow so both crates share the
// same pipeline: (1) build via wasm-pack, (2) verify the expected artifacts
// landed, (3) copy them to the vendored location, (4) optionally rename +
// patch the JS glue's wasm URL reference.

/**
 * @typedef {object} CrateBuildSpec
 * @property {string}   name            Human-readable label for log lines
 * @property {string}   crateDir        Absolute path to the crate (has Cargo.toml)
 * @property {string}   pkgDir          wasm-pack output directory (inside crateDir)
 * @property {string}   artifactBase    Name of the crate's bindgen output files
 *                                      (e.g., "cesium_wasm" → cesium_wasm_bg.wasm,
 *                                      cesium_wasm.js, cesium_wasm.d.ts)
 * @property {string}   destDir         Absolute path where artifacts land
 * @property {string}   destBase        Name they get at the destination (may
 *                                      differ from artifactBase; glue file's
 *                                      internal WASM URL is patched to match)
 * @property {string[]} features        Cargo features to pass to wasm-pack
 * @property {boolean}  defaultFeatures Whether to keep Cargo's default features
 */

function buildAndVendorCrate(spec, mode) {
  const {
    name,
    crateDir,
    pkgDir,
    artifactBase,
    destDir,
    destBase,
    features,
    defaultFeatures,
  } = spec;

  log(`Building ${name} (${mode})…`);
  log(`  Crate: ${crateDir}`);

  const modeFlag = mode === "dev" ? "--dev" : "--release";
  const featuresFlag =
    features.length > 0 ? `--features ${features.join(",")}` : "";
  const defaultsFlag = defaultFeatures ? "" : "--no-default-features";
  const outDirFlag = pkgDir === "pkg" ? "" : `-d ${pkgDir}`;
  const cmd = [
    "wasm-pack build --target web",
    modeFlag,
    outDirFlag,
    defaultsFlag,
    featuresFlag,
  ]
    .filter(Boolean)
    .join(" ");

  if (!run(cmd, crateDir)) {
    error(`${name}: wasm-pack build failed.`);
    return false;
  }

  const pkgAbs = join(crateDir, pkgDir);
  const srcWasm = join(pkgAbs, `${artifactBase}_bg.wasm`);
  const srcJs = join(pkgAbs, `${artifactBase}.js`);
  const srcDts = join(pkgAbs, `${artifactBase}.d.ts`);

  if (!existsSync(srcWasm)) {
    error(`${name}: expected output missing: ${srcWasm}`);
    return false;
  }

  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  const dstWasm = join(destDir, `${destBase}_bg.wasm`);
  const dstJs = join(destDir, `${destBase}.js`);
  const dstDts = join(destDir, `${destBase}.d.ts`);

  copyIfExists(srcWasm, dstWasm, "wasm");
  copyIfExists(srcJs, dstJs, "js");
  copyIfExists(srcDts, dstDts, "dts");

  // If the destination base differs from the crate's artifact name, patch
  // the vendored JS glue so its internal `new URL("<name>_bg.wasm", …)`
  // reference points at the renamed file.
  if (artifactBase !== destBase) {
    renameWasmReferencesInGlue(dstJs, artifactBase, destBase);
  }

  // Drop an ESM-type marker so Node treats the vendored glue as an ES
  // module. Most vendored destinations live under a tree whose nearest
  // `package.json` already sets `"type": "module"` (e.g. `packages/
  // engine/`), so the marker is redundant there. But the tooling
  // artifacts live under `Tools/`, where the existing `package.json`
  // declares `"type": "commonjs"` — and Node's ESM loader refuses to
  // parse our glue without this override.  Writing it unconditionally
  // is simpler than probing for the parent override + cheaper than
  // the failure mode (which only surfaces at validation time).
  const typeMarker = join(destDir, "package.json");
  if (!existsSync(typeMarker)) {
    writeFileSync(typeMarker, '{\n  "type": "module"\n}\n');
    log(`  wrote ESM type marker: ${typeMarker}`);
  }

  success(`${name}: vendored to ${destDir} (wasm: ${fileSize(dstWasm)})`);
  return true;
}

// ── Crate specs ──────────────────────────────────────────────────────────────

/** @type {CrateBuildSpec} */
const CESIUM_WASM_SPEC = {
  name: "cesium-wasm",
  crateDir: join(ROOT, "packages", "wasm"),
  pkgDir: "pkg",
  artifactBase: "cesium_wasm",
  destDir: join(ROOT, "packages", "engine", "Source", "ThirdParty", "Workers"),
  destBase: "cesium_wasm",
  features: [],
  defaultFeatures: true,
};

/** @type {CrateBuildSpec} */
const NAGA_RUNTIME_SPEC = {
  name: "cesium-naga-wasm (runtime)",
  crateDir: join(ROOT, "packages", "wasm-naga"),
  pkgDir: "pkg",
  artifactBase: "cesium_naga_wasm",
  destDir: join(
    ROOT,
    "packages",
    "engine",
    "Source",
    "ThirdParty",
    "naga-wasm",
  ),
  destBase: "naga_wasm",
  features: ["runtime"],
  defaultFeatures: false,
};

/** @type {CrateBuildSpec} */
const NAGA_TOOLING_SPEC = {
  name: "cesium-naga-wasm (tooling)",
  crateDir: join(ROOT, "packages", "wasm-naga"),
  pkgDir: "pkg-tooling",
  artifactBase: "cesium_naga_wasm",
  destDir: join(ROOT, "Tools", "shader-pipeline", "naga-wasm-tools"),
  destBase: "naga_wasm_tools",
  features: ["tooling"],
  defaultFeatures: false,
};

// ── Clean ────────────────────────────────────────────────────────────────────

if (isClean) {
  log("Cleaning all WASM build output + vendored artifacts…");
  const paths = [
    // pkg/ directories inside each crate
    join(CESIUM_WASM_SPEC.crateDir, "pkg"),
    join(NAGA_RUNTIME_SPEC.crateDir, "pkg"),
    join(NAGA_RUNTIME_SPEC.crateDir, "pkg-tooling"),
    // vendored destinations — remove the .wasm + .js + .d.ts triplets
    // rather than the full directories so LICENSE files + README.md
    // survive a clean. The build will re-populate the other three.
    join(CESIUM_WASM_SPEC.destDir, `${CESIUM_WASM_SPEC.destBase}_bg.wasm`),
    join(CESIUM_WASM_SPEC.destDir, `${CESIUM_WASM_SPEC.destBase}.js`),
    join(CESIUM_WASM_SPEC.destDir, `${CESIUM_WASM_SPEC.destBase}.d.ts`),
    join(NAGA_RUNTIME_SPEC.destDir, `${NAGA_RUNTIME_SPEC.destBase}_bg.wasm`),
    join(NAGA_RUNTIME_SPEC.destDir, `${NAGA_RUNTIME_SPEC.destBase}.js`),
    join(NAGA_RUNTIME_SPEC.destDir, `${NAGA_RUNTIME_SPEC.destBase}.d.ts`),
    join(NAGA_TOOLING_SPEC.destDir, `${NAGA_TOOLING_SPEC.destBase}_bg.wasm`),
    join(NAGA_TOOLING_SPEC.destDir, `${NAGA_TOOLING_SPEC.destBase}.js`),
    join(NAGA_TOOLING_SPEC.destDir, `${NAGA_TOOLING_SPEC.destBase}.d.ts`),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
      log(`  removed ${p}`);
    }
  }
  success("Clean complete.");
  process.exit(0);
}

// ── Toolchain Check ──────────────────────────────────────────────────────────

log("Checking build prerequisites…");

const checks = [];

if (!hasCommand("rustc")) {
  error("Rust compiler (rustc) not found. Install from https://rustup.rs/");
  checks.push("rustc");
}

if (!hasCommand("cargo")) {
  error("Cargo not found. Install from https://rustup.rs/");
  checks.push("cargo");
}

if (!hasCommand("wasm-pack")) {
  error(
    "wasm-pack not found. Install with: cargo install wasm-pack\n" +
      "  Or: npm install -g wasm-pack",
  );
  checks.push("wasm-pack");
}

if (checks.length > 0) {
  error(`Missing prerequisites: ${checks.join(", ")}`);
  process.exit(1);
}

// Check wasm32 target is installed
try {
  const targets = execSync("rustup target list --installed", {
    stdio: "pipe",
  }).toString();
  if (!targets.includes("wasm32-unknown-unknown")) {
    log("Installing wasm32-unknown-unknown target…");
    if (!run("rustup target add wasm32-unknown-unknown")) {
      error("Failed to install wasm32-unknown-unknown target.");
      process.exit(1);
    }
  }
} catch {
  log("Warning: Could not check rustup targets (rustup may not be installed).");
}

success("All prerequisites found.");

if (isCheck) {
  log("Toolchain check complete (--check mode, skipping build).");
  process.exit(0);
}

// ── Build ────────────────────────────────────────────────────────────────────

const mode = isDebug ? "dev" : "release";
const buildCesium = !skipCesium && !onlyNaga;
const buildNagaRuntime = !skipNaga;
const buildNagaTooling = includeNagaTooling && !skipNaga;

let anyFailure = false;

if (buildCesium) {
  if (!buildAndVendorCrate(CESIUM_WASM_SPEC, mode)) {
    anyFailure = true;
  }
}

if (buildNagaRuntime) {
  if (!buildAndVendorCrate(NAGA_RUNTIME_SPEC, mode)) {
    anyFailure = true;
  }
}

if (buildNagaTooling) {
  if (!buildAndVendorCrate(NAGA_TOOLING_SPEC, mode)) {
    anyFailure = true;
  }
}

if (anyFailure) {
  error("One or more WASM builds failed. See output above.");
  process.exit(1);
}

success("All WASM modules built and deployed.");
log("");
log("Usage hints:");
if (buildCesium) {
  log(
    '  cesium-wasm:  import init from "../ThirdParty/Workers/cesium_wasm.js";',
  );
}
if (buildNagaRuntime) {
  log(
    "  naga runtime: auto-loaded by WebGPUNagaTranspiler.ts on first compileShader(GLSL)",
  );
}
if (buildNagaTooling) {
  log(
    `  naga tooling: see ${NAGA_TOOLING_SPEC.destDir}/naga_wasm_tools.d.ts for exports`,
  );
}
