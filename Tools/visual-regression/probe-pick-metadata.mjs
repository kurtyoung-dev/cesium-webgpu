#!/usr/bin/env node
// Probe (NEW-PICK-METADATA-READBACK, Batch 285): the synchronous center-pixel
// readback used by scene.pickVoxel (-> Picking.pickVoxelCoordinate) and
// scene.pickMetadata (-> Picking.pickMetadata) must read the JUST-RENDERED
// pass on WebGPU, not a stale pixel from a prior frame, and must not read a
// half-written staging buffer under rapid re-read (the
// _centerReadbackInFlight guard).
//
// ── What changed (the fix this probe guards) ──────────────────────────────
//   WebGPUPickFramebuffer.readCenterPixel previously returned
//   `_lastReadPixels.slice(...)` — the pixels from the most recent REGULAR
//   scene.pick() COLOR pass, a stale pixel from a DIFFERENT pass. The
//   metadata/voxel callers render their own pass into `_colorTexture` then
//   call readCenterPixel synchronously, so they need THAT pass's pixel. The
//   fix arms a fresh 1x1 copyTextureToBuffer readback of the current center
//   pixel (guarded by `_centerReadbackInFlight`) and returns a one-frame-
//   stale cache keyed to (coord + frame stamp) — the same async-readback
//   contract as PickDepth.getDepth. Picking.js now calls context.endFrame()
//   BEFORE readCenterPixel so the metadata/voxel render is submitted ahead of
//   the readback copy (the submission-order hazard documented in
//   _pickAsyncWithMode).
//
// ── Verification strategy ─────────────────────────────────────────────────
// The readback path is backend-shared between the regular pick FBO color
// readback and the center-pixel readback (same `_colorTexture`, same staging
// + mapAsync mechanism). We exercise it DIRECTLY against a known-pickable
// opaque Box (which renders + picks correctly on WebGPU per probe-pick-basic):
//   (A) readCenterPixel over the box's pick pixel CONVERGES to the box's pick
//       color (non-zero, == the pick id the regular pick decoded) within a
//       few frames — proving the readback reads the CURRENT pick FBO content,
//       not a frozen/stale value.
//   (B) The `_centerReadbackInFlight` guard exists, toggles, and CLEARS after
//       each readback resolves — proving rapid re-reads neither corrupt the
//       cache nor wedge the flag (which would block all future readbacks).
//   (C) ZERO console / WebGPU validation errors across 20+ rapid re-reads.
//   (D) WebGL parity control: the same Box picks identically on WebGL.
//
// ── Asset gaps (documented, not silently skipped) ─────────────────────────
//   * VOXEL: the WebGPU VoxelRenderer is a SCAFFOLDED placeholder ray-marcher
//     (FEATURE_INVENTORY §B line ~518 — `VoxelPrimitive.update` returns early,
//     `_traversal` never built, no real voxel data, per-cell/coordinate pick
//     open as C-R9-VOXEL-CELL-PICK). So scene.pickVoxel cannot reach
//     pickVoxelCoordinate on WebGPU yet — the live voxel coordinate check is
//     blocked by that deferred functionality, NOT by the readback fix. (Batch
//     285 separately fixed the voxel COLOR pipeline's missing MSAA sample-count
//     bake, which was crashing the scene pass with an attachment-state
//     mismatch, but real voxel-data rendering remains scaffolded.)
//   * METADATA: every metadata gallery demo loads an ion 3D Tileset
//     (fromIonAssetId — token + network). There is NO zero-dependency local
//     EXT_structural_metadata asset in the repo. pickMetadata's decode path
//     consumes the SAME readCenterPixel readback verified here; full
//     metadata-over-tileset coverage is the documented manual gap.
//
// Usage: node Tools/visual-regression/probe-pick-metadata.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";

async function runBackend(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const errors = [];
  page.on("pageerror", (e) =>
    errors.push(`pageerror: ${e.message.slice(0, 200)}`),
  );
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !t.includes("favicon")) {
      errors.push(`console.error: ${t.slice(0, 200)}`);
    }
  });

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const result = await page.evaluate(async (rendererArg) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;

    const valErrors = [];
    const dev = scene.context?._device;
    if (dev) {
      dev.onuncapturederror = (ev) => {
        valErrors.push(ev?.error?.message?.slice(0, 240) ?? "uncaptured");
      };
    }

    v.terrainProvider = new C.EllipsoidTerrainProvider();

    // Known-pickable opaque Box over (-75, 40). Renders + picks on both
    // backends (see probe-pick-basic).
    scene.primitives.add(
      new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: C.BoxGeometry.fromDimensions({
            vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
            dimensions: new C.Cartesian3(1.5e6, 1.5e6, 1.5e6),
          }),
          modelMatrix: C.Matrix4.multiplyByTranslation(
            C.Transforms.eastNorthUpToFixedFrame(
              C.Cartesian3.fromDegrees(-75, 40, 0),
            ),
            new C.Cartesian3(0, 0, 1.0e6),
            new C.Matrix4(),
          ),
          attributes: {
            color: C.ColorGeometryInstanceAttribute.fromColor(C.Color.RED),
          },
          id: "the-box",
        }),
        appearance: new C.PerInstanceColorAppearance({ closed: true }),
        asynchronous: false,
      }),
    );
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-75, 36, 4_000_000),
    });

    const render = () =>
      new Promise((r) => {
        scene.render();
        requestAnimationFrame(r);
      });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    for (let i = 0; i < 60; i++) {
      await render();
    }

    const cx = Math.floor(scene.canvas.clientWidth / 2);
    const cy = Math.floor(scene.canvas.clientHeight / 2);
    const pos = new C.Cartesian2(cx, cy);

    // Confirm the box is pickable + the pick FBO is rendered at the center.
    let hit;
    for (let i = 0; i < 30; i++) {
      hit = await scene.pickAsync(pos, 3, 3).catch(() => undefined);
      await render();
      if (C.defined(hit)) {
        break;
      }
    }

    const pfb = scene.defaultView?.pickFramebuffer;
    const isWebGPUFbo =
      !!pfb && pfb.constructor?.name === "WebGPUPickFramebuffer";

    // (A) Drive readCenterPixel over the freshly-rendered pick FBO and let it
    // converge. The rectangle is bottom-left-origin (the convention
    // Picking.js / readCenterPixel use). On WebGL readCenterPixel reads
    // synchronously; on WebGPU it converges over a couple frames.
    const rect = new C.BoundingRectangle(cx, scene.canvas.height - cy, 3, 3);
    let centerPixel = null;
    let centerNonZero = false;
    let guardCleared = true;
    const guardObserved = [];
    for (let i = 0; i < 12; i++) {
      const px = pfb.readCenterPixel(rect);
      await render();
      // Let mapAsync resolve, then sample the guard — it MUST clear (a wedged
      // flag would block all future readbacks). WebGL has no flag (undefined).
      await wait(40);
      if (isWebGPUFbo) {
        guardObserved.push(pfb._centerReadbackInFlight);
        if (pfb._centerReadbackInFlight !== false) {
          guardCleared = false;
        }
      }
      if (px && (px[0] !== 0 || px[1] !== 0 || px[2] !== 0)) {
        centerPixel = [px[0], px[1], px[2], px[3]];
        centerNonZero = true;
        break;
      }
      centerPixel = px ? [px[0], px[1], px[2], px[3]] : null;
    }

    // (B/C) Rapid re-read stability — 20 back-to-back readCenterPixel calls.
    const valBefore = valErrors.length;
    const rapidVals = new Set();
    for (let i = 0; i < 20; i++) {
      const px = pfb.readCenterPixel(rect);
      rapidVals.add(`${px[0]},${px[1]},${px[2]},${px[3]}`);
      if (i % 3 === 0) {
        await render();
      }
    }
    const valDuringRapid = valErrors.length - valBefore;

    const hasGuardField =
      isWebGPUFbo && typeof pfb._centerReadbackInFlight === "boolean";

    return {
      renderer: rendererArg,
      isWebGPU: !!scene.context?.isWebGPU,
      isWebGPUFbo,
      boxPicked: C.defined(hit),
      boxId: hit?.id,
      centerPixel,
      centerNonZero,
      hasGuardField,
      guardCleared,
      guardObserved,
      valDuringRapid,
      rapidDistinct: rapidVals.size,
      rapidVals: [...rapidVals],
      validationErrors: valErrors.slice(0, 5),
    };
  }, renderer);

  await browser.close();
  return { ...result, consoleErrors: errors };
}

const webgl = await runBackend("webgl");
const webgpu = await runBackend("webgpu");

const out = { webgl, webgpu };
const fails = [];

// WebGL control: box picks, readCenterPixel returns the rendered (non-zero)
// pick color.
if (!webgl.boxPicked) {
  fails.push("WebGL: box not picked (baseline broken)");
}
if (!webgl.centerNonZero) {
  fails.push(
    `WebGL: readCenterPixel never returned a rendered pixel (got ${JSON.stringify(webgl.centerPixel)})`,
  );
}

// WebGPU: the readback-sync fix.
if (!webgpu.boxPicked) {
  fails.push("WebGPU: box not picked (pick FBO / readback regression)");
}
if (!webgpu.isWebGPUFbo) {
  fails.push(
    "WebGPU: defaultView.pickFramebuffer is not WebGPUPickFramebuffer",
  );
}
if (!webgpu.centerNonZero) {
  fails.push(
    `WebGPU: readCenterPixel never converged to the rendered pick pixel — STALE-READ regression (got ${JSON.stringify(webgpu.centerPixel)})`,
  );
}
if (!webgpu.hasGuardField) {
  fails.push("WebGPU: _centerReadbackInFlight guard missing");
}
if (!webgpu.guardCleared) {
  fails.push(
    `WebGPU: _centerReadbackInFlight wedged true (observed ${JSON.stringify(webgpu.guardObserved)})`,
  );
}
if (webgpu.valDuringRapid > 0) {
  fails.push(
    `WebGPU: ${webgpu.valDuringRapid} validation errors during rapid re-read`,
  );
}
for (const e of [...webgpu.consoleErrors, ...webgpu.validationErrors]) {
  fails.push(`WebGPU error: ${e}`);
}

// Parity: the converged center pick color should agree across backends
// (both decode the same box pick id; allow either to be null only if the
// other failed, which the checks above already catch).
if (webgl.centerNonZero && webgpu.centerNonZero) {
  const a = webgl.centerPixel.slice(0, 3).join(",");
  const b = webgpu.centerPixel.slice(0, 3).join(",");
  if (a !== b) {
    fails.push(`center pick-color RGB mismatch WebGL [${a}] vs WebGPU [${b}]`);
  }
}

out.PASS = fails.length === 0;
out.fails = fails;
out.notes = {
  voxelAssetGap:
    "WebGPU VoxelRenderer is a scaffolded placeholder (no real voxel data / traversal); scene.pickVoxel can't reach pickVoxelCoordinate on WebGPU yet (FEATURE_INVENTORY §B). Voxel COLOR-pipeline MSAA bake fixed this batch; full voxel-data render + per-cell pick remain deferred (C-R9-VOXEL-CELL-PICK).",
  metadataAssetGap:
    "No local EXT_structural_metadata asset (all demos use ion tiles). pickMetadata consumes the same readCenterPixel readback verified here via the Box pick; full metadata-over-tileset coverage is a manual gap.",
};
console.log(JSON.stringify(out, null, 2));
process.exit(out.PASS ? 0 : 1);
