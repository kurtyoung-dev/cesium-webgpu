#!/usr/bin/env node
// Probe (Batch 234 — NEW-COLLECTIONS-TAA-GATE-DORMANT): the Batch-143/144
// velocity-emission gates in the billboard / point renderers read a
// canonical `frameState.taaEnabled` flag published by
// `Scene.updateFrameState` (the old `frameState.scene?.taaEnabled`
// spelling read a property that never existed, so velocity commands had
// NEVER emitted). This probe drives the full OFF -> ON -> OFF cycle with
// MOVING billboards + points and asserts:
// @purpose Billboard/point velocity-emission OFF-ON-OFF: velocity commands attach with dual vertex streams, rg16float texture allocates, then detach.
// @status ACTIVE
//
//   (a) TAA OFF  — billboard + point color commands carry NO
//       velocityCommand; the scene-FB velocity texture is unallocated.
//   (b) TAA ON   — after the async velocity pipelines resolve, both
//       commands carry a velocityCommand wired with TWO vertex streams
//       (current + prev resident-instance buffer), the velocity texture
//       allocates (proof `_runVelocityPass` found commands and began the
//       rg16float pass), and 60 frames of moving primitives render with
//       ZERO console / WebGPU-validation errors. This is the first time
//       the collection velocity pipelines ever execute — the Batch 234
//       TAA->MSAA=1 coupling in `prepareFrame` is what keeps the velocity
//       pass's single-sample attachments valid against the scene depth.
//   (c) TAA OFF again — velocity commands detach within a few frames.
//
// Determinism: requestRenderMode is disabled (continuous loop) and all
// movement is an exact function of the probe-side frame counter. Command
// introspection happens INSIDE scene.postRender so the commandList is
// complete for the inspected frame.
//
// Usage: node Tools/visual-regression/probe-taa-velocity-emission.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);

// ── Setup + helpers (persist on window across evaluate calls) ──────────
await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;

  // CesiumViewer runs requestRenderMode=true — keep the widget loop
  // rendering every frame so postRender keeps firing.
  scene.requestRenderMode = false;
  v.clock.shouldAnimate = false;
  scene.morphTo3D(0);

  // Billboard image: 16x16 solid canvas (atlas upload resolves during
  // the OFF warmup frames).
  const img = document.createElement("canvas");
  img.width = 16;
  img.height = 16;
  const ictx = img.getContext("2d");
  ictx.fillStyle = "#ff00ff";
  ictx.fillRect(0, 0, 16, 16);

  const bb = scene.primitives.add(new C.BillboardCollection({ scene }));
  const pts = scene.primitives.add(new C.PointPrimitiveCollection());
  const N = 40;
  const bbItems = [];
  const ptItems = [];
  for (let i = 0; i < N; i++) {
    const lon = -0.5 + (i % 8) * 0.125;
    const lat = -0.3 + Math.floor(i / 8) * 0.125;
    bbItems.push(
      bb.add({
        image: img,
        position: C.Cartesian3.fromDegrees(lon, lat, 120000.0),
      }),
    );
    ptItems.push(
      pts.add({
        position: C.Cartesian3.fromDegrees(lon + 0.06, lat, 120000.0),
        color: C.Color.CYAN,
        pixelSize: 8,
      }),
    );
  }

  // Camera high above the grid, default top-down view — everything in
  // frustum so the velocity pass actually EXECUTES the commands (a
  // velocityCommand outside the frustum lists would never reach the GPU
  // and validation bugs would stay hidden).
  v.camera.setView({ destination: C.Cartesian3.fromDegrees(0.0, 0.0, 2.0e6) });

  const oncePostRender = () =>
    new Promise((resolve) => {
      const remove = scene.postRender.addEventListener(() => {
        remove();
        resolve();
      });
    });

  let frame = 0;
  // Move every primitive every frame (exact function of the frame
  // counter) so the dirty lists are non-empty and the prev-mirror path
  // in the resident-instance manager is exercised.
  const moveAll = () => {
    for (let i = 0; i < N; i++) {
      const lon = -0.5 + (i % 8) * 0.125 + 0.02 * Math.sin(frame * 0.13 + i);
      const lat =
        -0.3 + Math.floor(i / 8) * 0.125 + 0.02 * Math.cos(frame * 0.11 + i);
      bbItems[i].position = C.Cartesian3.fromDegrees(lon, lat, 120000.0);
      ptItems[i].position = C.Cartesian3.fromDegrees(lon + 0.06, lat, 120000.0);
    }
    frame++;
  };

  // Inspect INSIDE postRender — commandList is complete for the frame.
  const inspect = () =>
    new Promise((resolve) => {
      const remove = scene.postRender.addEventListener(() => {
        remove();
        const list = scene.frameState.commandList;
        const find = (owner) => list.find((c) => c && c.owner === owner);
        const desc = (cmd) => {
          if (!cmd) return { found: false };
          const vel = cmd.velocityCommand;
          return {
            found: true,
            hasVelocity: !!vel,
            velocityStreams: vel?.vertexBuffers?.length ?? 0,
            prevBufferWired: !!(vel?.vertexBuffers && vel.vertexBuffers[1]),
            velocityInstances: vel?.instanceCount ?? 0,
          };
        };
        resolve({
          billboard: desc(find(window.__probe.bb)),
          point: desc(find(window.__probe.pts)),
          velocityTextureAllocated: !!(
            scene._alternateSceneRenderer?._sceneFramebuffer?.velocityView ??
            null
          ),
          msaaSamples: scene.context?._msaaSamples ?? -1,
          commandCount: list.length,
        });
      });
    });

  window.__probe = {
    C,
    scene,
    bb,
    pts,
    runFrames: async (n) => {
      for (let f = 0; f < n; f++) {
        moveAll();
        await oncePostRender();
      }
      return inspect();
    },
  };
});

// ── Phase (a): TAA OFF — warmup (atlas + pipelines), no velocity ───────
const a = await page.evaluate(async () => {
  window.__probe.scene.taaEnabled = false;
  return window.__probe.runFrames(25);
});
const errsAfterA = errors.length;

// ── Phase (b): TAA ON — 60 moving frames, velocity must emit clean ─────
const b = await page.evaluate(async () => {
  window.__probe.scene.taaEnabled = true;
  return window.__probe.runFrames(60);
});
const errsAfterB = errors.length;

// ── Phase (c): TAA OFF again — velocity must detach ────────────────────
const c = await page.evaluate(async () => {
  window.__probe.scene.taaEnabled = false;
  return window.__probe.runFrames(10);
});
const errsAfterC = errors.length;

const aOK =
  a.billboard.found &&
  a.point.found &&
  !a.billboard.hasVelocity &&
  !a.point.hasVelocity &&
  !a.velocityTextureAllocated;
const bOK =
  b.billboard.found &&
  b.point.found &&
  b.billboard.hasVelocity &&
  b.point.hasVelocity &&
  b.billboard.velocityStreams === 2 &&
  b.point.velocityStreams === 2 &&
  b.billboard.prevBufferWired &&
  b.point.prevBufferWired &&
  b.velocityTextureAllocated &&
  b.msaaSamples === 1;
const cOK =
  c.billboard.found && !c.billboard.hasVelocity && !c.point.hasVelocity;
const eOK = errsAfterC === 0;

const fmt = (s) =>
  `bb{found:${s.billboard.found} vel:${s.billboard.hasVelocity} streams:${s.billboard.velocityStreams} prev:${s.billboard.prevBufferWired} inst:${s.billboard.velocityInstances}} ` +
  `pt{found:${s.point.found} vel:${s.point.hasVelocity} streams:${s.point.velocityStreams} prev:${s.point.prevBufferWired} inst:${s.point.velocityInstances}} ` +
  `velTex:${s.velocityTextureAllocated} msaa:${s.msaaSamples}`;

console.log(`(a) TAA OFF 25f: ${fmt(a)} -> ${aOK ? "OK" : "FAIL"}`);
console.log(`(b) TAA ON  60f: ${fmt(b)} -> ${bOK ? "OK" : "FAIL"}`);
console.log(`(c) TAA OFF 10f: ${fmt(c)} -> ${cOK ? "OK" : "FAIL"}`);
console.log(
  `(e) console errors: a=${errsAfterA} b=${errsAfterB - errsAfterA} c=${errsAfterC - errsAfterB} total=${errsAfterC} -> ${eOK ? "OK" : "FAIL"}`,
);
errors.slice(0, 10).forEach((e) => console.log("  ERR:", e.slice(0, 300)));

const pass = aOK && bOK && cOK && eOK;
console.log(pass ? "PASS" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
