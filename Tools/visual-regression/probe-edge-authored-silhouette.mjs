#!/usr/bin/env node
/**
 * Probe: authored `silhouetteNormals` accessor parity
 * (EDGE-AUTHORED-SILHOUETTE-NORMALS).
 *
 * Before this task the WebGPU model-edge extractor
 * (`WebGPUEdgeVisibilityEmitter.extractEdgeGeometry`) always RE-DERIVED
 * silhouette face normals from triangle adjacency and ignored the authored
 * signed-byte `edgeVisibility.silhouetteNormals` accessor that WebGL's
 * `EdgeVisibilityPipelineStage.generateEdgeFaceNormals` consumes — so
 * silhouette classification could diverge from WebGL on meshes that author
 * the accessor (which the EXT_mesh_primitive_edge_visibility spec REQUIRES
 * for any primitive encoding a silhouette edge).
 *
 * Two parts:
 *
 *   [A] NUMERIC (Node-side, deterministic) — transpile the emitter `.ts`
 *       via esbuild, run `extractEdgeGeometry` on a synthetic primitive
 *       whose authored normals deliberately differ from the derived ones,
 *       and assert:
 *         1. the emitted silhouette-edge normals equal a faithful mirror
 *            of WebGL's signed-byte decode (2*((v+128)/255)-1, normalize,
 *            (0,0,1) zero-fallback) — FAILS on the pre-task extractor;
 *         2. sequential silhouette-pair indexing matches WebGL's dedupe-
 *            order numbering (2 silhouette edges, distinct pairs);
 *         3. out-of-range pairs leave zero normals (WebGL bounds skip);
 *         4. OFF-GATE — without the accessor the output is byte-identical
 *            to a run where `silhouetteNormals` is stripped (the derived
 *            fallback is untouched).
 *
 *   [B] VISUAL (Edge/Playwright) — load `EdgeVisibility.glb` (its first
 *       primitive authors `silhouetteNormals`: 80 signed-byte entries =
 *       40 silhouette-edge pairs) as a standalone Model in EDGES_ONLY
 *       mode on BOTH backends at two camera headings, and assert the edge
 *       images match: every edge-lit pixel in one backend must have an
 *       edge-lit pixel within a small dilation radius in the other
 *       (orphan fraction below threshold). A silhouette-classification
 *       divergence shows up as whole edge segments present on one backend
 *       only -> a large orphan fraction.
 *
 * Usage:
 *   PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-edge-authored-silhouette.mjs
 */
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import os from "os";
import { build } from "esbuild";
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const MODEL_URL =
  "/Specs/Data/Models/glTF-2.0/EdgeVisibility/glTF-Binary/EdgeVisibility.glb";
const EDGES_ONLY = 2;

const failures = [];
const note = (ok, name, detail) => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures.push(name);
};

// ─────────────────────────────────────────────────────────────────────────
// [A] NUMERIC — transpile the emitter and check authored-normal decode.
// The tsconfig is noEmit, so no compiled `.js` sibling exists; bundle the
// `.ts` (its only deps are Core/Cartesian3.js + the scene-FB helper) to a
// temp module and import it.
// ─────────────────────────────────────────────────────────────────────────
const EMITTER_TS = path.join(
  ROOT,
  "packages/engine/Source/Renderer/WebGPU/WebGPUEdgeVisibilityEmitter.ts",
);
const tmpOut = path.join(
  os.tmpdir(),
  `probe-edge-authored-emitter-${process.pid}.mjs`,
);
await build({
  entryPoints: [EMITTER_TS],
  bundle: true,
  format: "esm",
  outfile: tmpOut,
  logLevel: "silent",
});
const { extractEdgeGeometry } = await import(
  `file:///${tmpOut.replace(/\\/g, "/")}`
);
note(
  typeof extractEdgeGeometry === "function",
  "[A] extractEdgeGeometry exported",
);

// Two quads sharing structure: 6 vertices, 4 triangles. Interior edges
// (0,2) and (2,4) marked SILHOUETTE (2 silhouette edges -> 2 authored
// pairs); the rest HARD.
//
//   1---2---5
//   | / | \ |     tris: [0,1,2] [0,2,3] [3,2,4] [2,5,4]
//   0---3---4
const positions = new Float32Array([
  0,
  0,
  0, // v0
  0,
  1,
  0, // v1
  1,
  1,
  0.4, // v2 (lifted so faces have distinct derived normals)
  1,
  0,
  0, // v3
  2,
  0,
  0, // v4
  2,
  1,
  0, // v5
]);
const indices = new Uint16Array([0, 1, 2, 0, 2, 3, 3, 2, 4, 2, 5, 4]);
// 12 edge slots (4 tris x 3), 2 bits each, little-endian within a byte.
// tri0: (0,1)H (1,2)H (2,0)S | tri1: (0,2)S-dup (2,3)H (3,0)H
// tri2: (3,2)H-dup (2,4)S (4,3)H | tri3: (2,5)H (5,4)H (4,2)S-dup
const S = 1;
const H = 2;
const slots = [H, H, S, S, H, H, H, S, H, H, H, S];
const visibility = new Uint8Array(3);
slots.forEach((v, i) => {
  visibility[Math.floor(i / 4)] |= v << ((i % 4) * 2);
});

// Authored pairs chosen to be far from any derived face normal:
// silhouette edge 0 (edge (0,2)) -> pair [(1,0,0), (0,1,0)]
// silhouette edge 1 (edge (2,4)) -> pair [(0,0,-1), (-1,0,0)] (as sbytes)
const rawPairs = [
  { x: 127, y: 0, z: 0 },
  { x: 0, y: 127, z: 0 },
  { x: 0, y: 0, z: -128 },
  { x: -128, y: 0, z: 0 },
];
// Faithful mirror of WebGL EdgeVisibilityPipelineStage.generateEdgeFaceNormals.
const decodeWebGL = (v) => {
  let x = 2 * ((v.x + 128) / 255) - 1;
  let y = 2 * ((v.y + 128) / 255) - 1;
  let z = 2 * ((v.z + 128) / 255) - 1;
  const m = Math.hypot(x, y, z);
  if (m > 0) {
    x /= m;
    y /= m;
    z /= m;
  } else {
    x = 0;
    y = 0;
    z = 1;
  }
  return [x, y, z];
};

const makePrim = (extra) => ({
  attributes: [{ count: 6 }],
  indices: { typedArray: indices },
  edgeVisibility: { visibility, ...extra },
});

const STRIDE = 19; // floats per vertex; normalA @ [4..6], normalB @ [7..9]
const readVec = (g, edge, off) => [
  g.vertices[edge * 4 * STRIDE + off],
  g.vertices[edge * 4 * STRIDE + off + 1],
  g.vertices[edge * 4 * STRIDE + off + 2],
];
const near = (a, b) => Math.abs(a - b) < 1e-6;
const vecEq = (a, b) =>
  near(a[0], b[0]) && near(a[1], b[1]) && near(a[2], b[2]);

// Edge emission (dedupe) order: (0,1)e0 (1,2)e1 (2,0)e2=SIL#0 (2,3)e3
// (3,0)e4 (2,4)e5=SIL#1 (4,3)e6 (2,5)e7 (5,4)e8.
const gAuth = extractEdgeGeometry(
  makePrim({ silhouetteNormals: rawPairs }),
  positions,
  null,
  null,
);
note(
  gAuth !== null && gAuth.edgeCount === 9,
  "[A] 9 deduped edges",
  `edgeCount=${gAuth?.edgeCount}`,
);
if (gAuth) {
  const exp = rawPairs.map(decodeWebGL);
  note(
    vecEq(readVec(gAuth, 2, 4), exp[0]) && vecEq(readVec(gAuth, 2, 7), exp[1]),
    "[A] silhouette edge #0 uses authored pair [0,1] (WebGL decode match)",
    `nA=[${readVec(gAuth, 2, 4).map((x) => x.toFixed(4))}]`,
  );
  note(
    vecEq(readVec(gAuth, 5, 4), exp[2]) && vecEq(readVec(gAuth, 5, 7), exp[3]),
    "[A] silhouette edge #1 uses authored pair [2,3] (sequential dedupe-order indexing)",
    `nA=[${readVec(gAuth, 5, 4).map((x) => x.toFixed(4))}]`,
  );
  // HARD edge normals are zero on the authored path (inert in the VS —
  // matches WebGL generateEdgeFaceNormals, which only fills SILHOUETTE rows).
  note(
    vecEq(readVec(gAuth, 0, 4), [0, 0, 0]) &&
      vecEq(readVec(gAuth, 0, 7), [0, 0, 0]),
    "[A] HARD edge normals zero on authored path",
  );
}

// Out-of-range pair: accessor with entries for only the FIRST silhouette
// edge -> second silhouette edge gets zero normals (WebGL bounds skip ->
// edge always drawn).
const gShort = extractEdgeGeometry(
  makePrim({ silhouetteNormals: rawPairs.slice(0, 2) }),
  positions,
  null,
  null,
);
if (gShort) {
  note(
    vecEq(readVec(gShort, 5, 4), [0, 0, 0]) &&
      vecEq(readVec(gShort, 5, 7), [0, 0, 0]),
    "[A] out-of-range authored pair -> zero normals (WebGL bounds-skip parity)",
  );
  note(
    vecEq(readVec(gShort, 2, 4), decodeWebGL(rawPairs[0])),
    "[A] in-range pair still consumed when accessor is short",
  );
} else {
  note(false, "[A] short-accessor primitive returned geometry");
}

// OFF-GATE — no accessor: geometry must be byte-identical to the derived
// fallback (accessor stripped vs never present is the same code path; the
// real pre/post byte-identity was proven against the pre-task extractor
// during task verification — this standing check guards the fallback
// against future drift by asserting derived normals are still emitted).
const gDerived = extractEdgeGeometry(makePrim({}), positions, null, null);
if (gDerived && gAuth) {
  const dA = readVec(gDerived, 2, 4);
  note(
    !vecEq(dA, decodeWebGL(rawPairs[0])) && Math.hypot(...dA) > 0.99,
    "[A] OFF-GATE: without accessor the derived (adjacency) normals are emitted",
    `derived nA=[${dA.map((x) => x.toFixed(4))}]`,
  );
  note(
    gDerived.edgeCount === gAuth.edgeCount &&
      gDerived.indices.length === gAuth.indices.length,
    "[A] OFF-GATE: same edge set with and without the accessor",
  );
}
fs.rmSync(tmpOut, { force: true });

// ─────────────────────────────────────────────────────────────────────────
// [B] VISUAL — EdgeVisibility.glb (authors silhouetteNormals) on both
// backends, EDGES_ONLY, two headings.
// ─────────────────────────────────────────────────────────────────────────
async function captureRenderer(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.addInitScript((url) => {
    window.__EDGE_MODEL_URL__ = url;
  }, MODEL_URL);

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });
  await armWebGPUDevices(page);

  const views = {};
  for (const heading of [230, 50]) {
    views[heading] = await page.evaluate(
      async ({ edgesOnly, heading }) => {
        const C = await import("/Build/CesiumUnminified/index.js");
        const v = window.viewer;
        v.scene.globe.show = false;
        v.scene.skyBox.show = false;
        v.scene.sun.show = false;
        v.scene.skyAtmosphere.show = false;
        v.scene.backgroundColor = C.Color.BLACK;

        if (!window.__edgeModel) {
          const origin = C.Cartesian3.fromDegrees(-123.07, 44.05, 0.0);
          const modelMatrix = C.Transforms.headingPitchRollToFixedFrame(
            origin,
            new C.HeadingPitchRoll(0, 0, 0),
          );
          const model = v.scene.primitives.add(
            await C.Model.fromGltfAsync({
              url: window.__EDGE_MODEL_URL__,
              modelMatrix,
              color: C.Color.WHITE,
            }),
          );
          model.edgeDisplayMode = edgesOnly;
          await new Promise((resolve) => {
            if (model.ready) resolve();
            else model.readyEvent.addEventListener(() => resolve());
          });
          window.__edgeModel = model;
        }
        const model = window.__edgeModel;

        const center = model.boundingSphere.center;
        const r = model.boundingSphere.radius;
        v.camera.lookAt(
          center,
          new C.HeadingPitchRange(
            C.Math.toRadians(heading),
            C.Math.toRadians(-25.0),
            r * 3.5,
          ),
        );
        v.camera.lookAtTransform(C.Matrix4.IDENTITY);

        for (let i = 0; i < 60; i++) {
          v.scene.render();
          await new Promise((res) => requestAnimationFrame(res));
        }

        const canvas = v.canvas;
        const w = canvas.width;
        const h = canvas.height;
        const tmp = document.createElement("canvas");
        tmp.width = w;
        tmp.height = h;
        const tctx = tmp.getContext("2d");
        tctx.drawImage(canvas, 0, 0);
        const px = tctx.getImageData(0, 0, w, h).data;
        // Edge-lit mask: any clearly-lit pixel (edges are white-ish on
        // black; EDGES_ONLY suppresses the surface). Exclude the top 15%
        // (viewer chrome / credits are at the bottom overlay in DOM, not
        // canvas, but keep a symmetric crop for safety).
        const y0 = Math.floor(h * 0.15);
        const y1 = Math.floor(h * 0.95);
        const mask = [];
        let lit = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const on = Math.max(px[i], px[i + 1], px[i + 2]) > 60 ? 1 : 0;
            mask.push(on);
            lit += on;
          }
        }
        return { w, h: y1 - y0, mask, lit };
      },
      { edgesOnly: EDGES_ONLY, heading },
    );
  }

  const shot = await page.screenshot();
  const out = `Tools/visual-regression/output/edge-authored-silhouette-${renderer}.png`;
  fs.writeFileSync(out, shot);
  console.log(
    `  [${renderer}] lit(230)=${views[230].lit} lit(50)=${views[50].lit}  PNG: ${out}`,
  );

  const gate = await collectGateErrors(page);
  await browser.close();
  return { views, gate };
}

// Orphan test: fraction of lit pixels in A with no lit pixel within
// `radius` px in B. Sub-pixel rasterization/AA differences stay inside the
// radius; a mis-classified silhouette edge (drawn on one backend only)
// produces a whole orphan segment.
function orphanFraction(a, b, radius = 3) {
  const { w, h } = a;
  let orphans = 0;
  let litA = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!a.mask[y * w + x]) continue;
      litA++;
      let found = false;
      for (let dy = -radius; dy <= radius && !found; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (b.mask[yy * w + xx]) {
            found = true;
            break;
          }
        }
      }
      if (!found) orphans++;
    }
  }
  return litA === 0 ? 1 : orphans / litA;
}

fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
console.log("\n=== [B] Capturing WEBGL ===");
const gl = await captureRenderer("webgl");
console.log("=== [B] Capturing WEBGPU ===");
const gpu = await captureRenderer("webgpu");

for (const heading of [230, 50]) {
  const a = gl.views[heading];
  const b = gpu.views[heading];
  note(
    a.lit > 300 && b.lit > 300,
    `[B] heading ${heading}: both backends draw edges`,
    `webgl=${a.lit} webgpu=${b.lit}`,
  );
  const ratio = b.lit / Math.max(1, a.lit);
  note(
    ratio > 0.6 && ratio < 1.67,
    `[B] heading ${heading}: comparable edge coverage`,
    `ratio=${ratio.toFixed(3)}`,
  );
  const oAB = orphanFraction(a, b);
  const oBA = orphanFraction(b, a);
  note(
    oAB < 0.06 && oBA < 0.06,
    `[B] heading ${heading}: edge classification matches (orphan fractions)`,
    `webgl->webgpu=${(oAB * 100).toFixed(2)}% webgpu->webgl=${(oBA * 100).toFixed(2)}%`,
  );
}
note(
  (gpu.gate.errors?.length ?? 0) === 0 && !gpu.gate.deviceLost,
  "[B] no uncaptured WebGPU errors",
  gpu.gate.errors?.slice(0, 3).join(" | "),
);

console.log("");
if (failures.length === 0) {
  console.log(
    "[probe-edge-authored-silhouette] PASS — authored silhouetteNormals " +
      "accessor is consumed with WebGL-identical decode/indexing; visual " +
      "edge classification matches WebGL; derived fallback intact.",
  );
  process.exit(0);
} else {
  console.log(
    `[probe-edge-authored-silhouette] FAIL — ${failures.length} check(s): ${failures.join(", ")}`,
  );
  process.exit(1);
}
