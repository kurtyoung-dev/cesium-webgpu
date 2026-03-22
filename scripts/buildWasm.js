/**
 * Build script for the cesium-wasm-culling Rust → WASM module.
 *
 * Usage:
 *   node scripts/buildWasm.js              — build release + copy to engine
 *   node scripts/buildWasm.js --debug      — build debug (faster compile, bigger output)
 *   node scripts/buildWasm.js --check      — only verify toolchain, don't build
 *   node scripts/buildWasm.js --clean      — remove pkg/ output directory
 *
 * Prerequisites:
 *   - Rust toolchain (rustup, cargo): https://rustup.rs/
 *   - wasm-pack: cargo install wasm-pack  (or: npm i -g wasm-pack)
 *   - wasm32-unknown-unknown target: rustup target add wasm32-unknown-unknown
 *
 * Output:
 *   packages/wasm-culling/pkg/
 *     cesium_wasm_culling_bg.wasm   — WASM binary (~10-30 KB release)
 *     cesium_wasm_culling.js        — JS glue (wasm-bindgen)
 *     cesium_wasm_culling.d.ts      — TypeScript declarations
 *
 *   Copied to:
 *     packages/engine/Source/ThirdParty/Workers/cesium_wasm_culling_bg.wasm
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, copyFileSync, rmSync, statSync } from "fs";
import { resolve, join } from "path";

// ── Paths ────────────────────────────────────────────────────────────────────
const ROOT = resolve(import.meta.dirname, "..");
const CRATE_DIR = join(ROOT, "packages", "wasm-culling");
const PKG_DIR = join(CRATE_DIR, "pkg");
const WASM_FILE = join(PKG_DIR, "cesium_wasm_culling_bg.wasm");
const JS_GLUE = join(PKG_DIR, "cesium_wasm_culling.js");
const DTS_FILE = join(PKG_DIR, "cesium_wasm_culling.d.ts");
const DEST_DIR = join(
  ROOT,
  "packages",
  "engine",
  "Source",
  "ThirdParty",
  "Workers",
);
const DEST_WASM = join(DEST_DIR, "cesium_wasm_culling_bg.wasm");
const DEST_JS = join(DEST_DIR, "cesium_wasm_culling.js");
const DEST_DTS = join(DEST_DIR, "cesium_wasm_culling.d.ts");

// ── CLI flags ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const isDebug = args.includes("--debug");
const isCheck = args.includes("--check");
const isClean = args.includes("--clean");

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

// ── Clean ────────────────────────────────────────────────────────────────────

if (isClean) {
  log("Cleaning WASM build output...");
  if (existsSync(PKG_DIR)) {
    rmSync(PKG_DIR, { recursive: true, force: true });
    log(`Removed ${PKG_DIR}`);
  }
  if (existsSync(DEST_WASM)) {
    rmSync(DEST_WASM);
    log(`Removed ${DEST_WASM}`);
  }
  if (existsSync(DEST_JS)) {
    rmSync(DEST_JS);
    log(`Removed ${DEST_JS}`);
  }
  if (existsSync(DEST_DTS)) {
    rmSync(DEST_DTS);
    log(`Removed ${DEST_DTS}`);
  }
  success("Clean complete.");
  process.exit(0);
}

// ── Toolchain Check ──────────────────────────────────────────────────────────

log("Checking build prerequisites...");

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

if (!existsSync(join(CRATE_DIR, "Cargo.toml"))) {
  error(`Cargo.toml not found at ${CRATE_DIR}`);
  checks.push("Cargo.toml");
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
    log("Installing wasm32-unknown-unknown target...");
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
const modeFlag = isDebug ? "--dev" : "--release";

log(`Building cesium-wasm-culling (${mode} mode)...`);
log(`  Crate: ${CRATE_DIR}`);
log(`  Target: wasm32-unknown-unknown (SIMD128 enabled)`);

const buildCmd = `wasm-pack build --target web ${modeFlag} --out-dir pkg`;
if (!run(buildCmd, CRATE_DIR)) {
  error("wasm-pack build failed!");
  error("Common fixes:");
  error("  1. rustup target add wasm32-unknown-unknown");
  error("  2. cargo install wasm-pack");
  error("  3. Check Cargo.toml for syntax errors");
  process.exit(1);
}

// ── Verify Output ────────────────────────────────────────────────────────────

if (!existsSync(WASM_FILE)) {
  error(`Build succeeded but WASM file not found: ${WASM_FILE}`);
  process.exit(1);
}
if (!existsSync(JS_GLUE)) {
  error(`Build succeeded but JS glue not found: ${JS_GLUE}`);
  process.exit(1);
}

success(`Build complete. WASM size: ${fileSize(WASM_FILE)} (${mode})`);

// ── Copy to Engine ───────────────────────────────────────────────────────────

log("Copying build output to engine ThirdParty/Workers/...");

if (!existsSync(DEST_DIR)) {
  mkdirSync(DEST_DIR, { recursive: true });
}

copyFileSync(WASM_FILE, DEST_WASM);
log(`  ${WASM_FILE} → ${DEST_WASM} (${fileSize(DEST_WASM)})`);

copyFileSync(JS_GLUE, DEST_JS);
log(`  ${JS_GLUE} → ${DEST_JS}`);

if (existsSync(DTS_FILE)) {
  copyFileSync(DTS_FILE, DEST_DTS);
  log(`  ${DTS_FILE} → ${DEST_DTS}`);
}

success("WASM module built and deployed to engine.");
log("");
log("To use in the application:");
log('  import init from "../ThirdParty/Workers/cesium_wasm_culling.js";');
log("  const wasm = await init();");
log('  console.log("WASM version:", wasm.version());');
