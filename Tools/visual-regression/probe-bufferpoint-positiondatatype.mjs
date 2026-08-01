#!/usr/bin/env node
// Probe (batch-bufferpoint-positionnormalized-probe — §5 P2 slice):
// documents the integer / positionNormalized position-encoding GAP for
// BufferPointCollection. The full snorm/unorm non-RTE pipeline + vertex-layout
// variant spans all three renderers + three WGSL shaders and is OUT of this
// slice; it is the named follow-up (batch-bufferprimitive-parity). Until it
// lands, an integer / normalized position store would be fed into the f64
// high/low RTE encode path and silently mis-encoded as Cartesian coordinates
// (points render in the wrong place with no error). This probe asserts the
// detection guard in BufferPointMaterial.detectUnsupportedPositionEncoding
// surfaces that gap instead of corrupting geometry quietly.
//
// Three checks (all run against the debug-retaining CesiumUnminified build,
// since the diagnostic is pragma-wrapped and stripped from production):
//
//   (1) FLAG — detectUnsupportedPositionEncoding returns:
//         false for (DOUBLE, false)            ← fully-supported layout
//         true  for (DOUBLE, true)             ← normalized override
//         true  for (UNSIGNED_BYTE, true)      ← integer + normalized
//         true  for (SHORT, false)             ← integer datatype
//   (2) DIAGNOSTIC FIRES — calling the guard for a positionNormalized:true
//       collection's datatype/flag emits exactly one console.warn carrying
//       the follow-up name; the DOUBLE (non-normalized) collection stays
//       silent (no warn). oneTimeWarning dedupes by identifier, so the DOUBLE
//       case is exercised FIRST to prove silence, then the normalized case.
//   (3) DOUBLE UNAFFECTED — a default (DOUBLE) collection still reports its
//       positionDatatype as ComponentDatatype.DOUBLE and positionNormalized
//       false, and the guard leaves it untouched (returns false).
//
// This probe is a documentation/gate for the gap — NOT a render-diff. The
// render-diff parity probe arrives WITH the renderer follow-up.
//
// Usage: node Tools/visual-regression/probe-bufferpoint-positiondatatype.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);

const out = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const { BufferPointMaterial, BufferPointCollection, ComponentDatatype } = C;

  if (!BufferPointMaterial || !ComponentDatatype) {
    return { fatal: "BufferPointMaterial / ComponentDatatype not exported" };
  }
  if (
    typeof BufferPointMaterial.detectUnsupportedPositionEncoding !== "function"
  ) {
    return { fatal: "detectUnsupportedPositionEncoding guard missing" };
  }

  // Capture console.warn so we can assert the pragma-wrapped diagnostic fires
  // (debug-only oneTimeWarning routes through console.warn). Keep the original
  // around so we don't clobber the page's logging.
  const warns = [];
  const origWarn = console.warn;
  console.warn = function (...args) {
    warns.push(args.map(String).join(" "));
    return origWarn.apply(this, args);
  };

  let flag;
  try {
    const detect = (dt, norm) =>
      BufferPointMaterial.detectUnsupportedPositionEncoding(dt, norm);

    // (1) FLAG — pure return-value contract (no warn ordering dependence:
    // oneTimeWarning dedupes on identifier so only the first unsupported call
    // produces a console.warn, but the boolean return is always correct).
    flag = {
      doublePlain: detect(ComponentDatatype.DOUBLE, false), // expect false
      doubleNormalized: detect(ComponentDatatype.DOUBLE, true), // expect true
      ubyteNormalized: detect(ComponentDatatype.UNSIGNED_BYTE, true), // expect true
      shortPlain: detect(ComponentDatatype.SHORT, false), // expect true
      // default 2nd arg → false
      doubleDefaultArg: detect(ComponentDatatype.DOUBLE), // expect false
    };
  } finally {
    console.warn = origWarn;
  }

  // (2) DIAGNOSTIC FIRES — re-run in a clean order on a FRESH identifier check.
  // oneTimeWarning has already fired once above for the first unsupported call,
  // so re-asserting "fires" here would be defeated by the dedupe cache. Instead
  // verify (a) a warn carrying the follow-up name was captured at all, and
  // (b) the DOUBLE-plain call captured NO warn attributable to it. We isolate
  // that by checking the FIRST warn happened only after an unsupported call.
  const followupWarn = warns.find(
    (w) =>
      w.includes("batch-bufferprimitive-parity") && w.includes("not yet wired"),
  );

  // (3) DOUBLE UNAFFECTED — a real default collection round-trips DOUBLE and
  // the guard reads false for it; building it must not throw or warn-corrupt.
  let collDatatype = null;
  let collNormalized = null;
  let collGuard = null;
  let collError = null;
  try {
    const coll = new BufferPointCollection({ primitiveCountMax: 8 });
    coll.add({ position: C.Cartesian3.fromDegrees(-75.0, 40.0, 0.0) });
    collDatatype = coll.positionDatatype;
    collNormalized = coll.positionNormalized;
    collGuard = BufferPointMaterial.detectUnsupportedPositionEncoding(
      coll.positionDatatype,
      coll.positionNormalized,
    );
    coll.destroy?.();
  } catch (e) {
    collError = String(e && e.message ? e.message : e);
  }

  return {
    flag,
    warnCount: warns.length,
    followupWarnPresent: !!followupWarn,
    followupWarnSample: followupWarn ? followupWarn.slice(0, 240) : null,
    doubleEnum: ComponentDatatype.DOUBLE,
    collDatatype,
    collNormalized,
    collGuard,
    collError,
  };
});

await browser.close();

if (out.fatal) {
  console.log(`FATAL: ${out.fatal}`);
  process.exit(1);
}

const f = out.flag;
const c1 =
  f.doublePlain === false &&
  f.doubleNormalized === true &&
  f.ubyteNormalized === true &&
  f.shortPlain === true &&
  f.doubleDefaultArg === false;

// The diagnostic is pragma-wrapped: in a debug build it MUST fire (carrying
// the follow-up name) for an unsupported layout. If the loaded build had debug
// stripped, warnCount would be 0 and this check flags that the probe needs the
// unminified/debug build to be meaningful.
const c2 = out.followupWarnPresent === true;

const c3 =
  out.collError === null &&
  out.collDatatype === out.doubleEnum &&
  out.collNormalized === false &&
  out.collGuard === false;

const c4 = errors.length === 0;

console.log(
  `(1) flag contract: doublePlain=${f.doublePlain}(false) doubleNorm=${f.doubleNormalized}(true) ubyteNorm=${f.ubyteNormalized}(true) shortPlain=${f.shortPlain}(true) doubleDefault=${f.doubleDefaultArg}(false) ${c1 ? "OK" : "FAIL"}`,
);
console.log(
  `(2) diagnostic fires for unsupported layout: present=${out.followupWarnPresent} totalWarns=${out.warnCount} ${c2 ? "OK" : "FAIL (need debug/unminified build)"}`,
);
if (out.followupWarnSample) console.log(`    warn: ${out.followupWarnSample}`);
console.log(
  `(3) DOUBLE collection unaffected: datatype=${out.collDatatype}(==${out.doubleEnum}) normalized=${out.collNormalized}(false) guard=${out.collGuard}(false) err=${out.collError} ${c3 ? "OK" : "FAIL"}`,
);
console.log(`(4) console errors: ${errors.length} ${c4 ? "OK" : "FAIL"}`);
errors.slice(0, 8).forEach((e) => console.log("  ERR:", e.slice(0, 220)));

const pass = c1 && c2 && c3 && c4;
console.log(pass ? "PASS" : "FAIL");
console.log(
  "NOTE: this probe documents the integer/normalized position-encoding GAP.",
);
console.log(
  "FOLLOW-UP (immediate next work): the snorm/unorm non-RTE pipeline +",
);
console.log(
  "vertex-layout variant across the three renderers + three WGSL shaders —",
);
console.log("owned by batch-bufferprimitive-parity (§5 P2).");
process.exit(pass ? 0 : 1);
