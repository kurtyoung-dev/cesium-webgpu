#!/usr/bin/env node
// R-2b UNIFIED-FEATURE-ID-TEXTURE (Queue Q28) acceptance probe, extended for
// AR-751 (32-bit pick ids).
//
// @purpose Unified per-fragment feature-ID G-buffer resolvable in-shader: FeatureIdResolve.wgsl recolors two pick sources to distinct colors, and recolors ids above bit 23 to the hash of their FULL 32-bit key.
// @status ACTIVE
// @runtime lib/probe-runtime.mjs
//
// Proves that the WebGPU pick pass's unified, source-agnostic per-fragment
// feature-ID G-buffer (WebGPUPickFramebuffer._colorTexture) is resolvable
// INSIDE a shader / post-process pass — not just via CPU byte readback.
//
// ── CELL 1: cross-source (the original R-2b acceptance, unchanged) ──────────
//
// Scene: a billboard (source A) + a point (source B), two distinct pick source
// pipelines. A single wide pickAsync rasterizes BOTH sources' IDs into the
// shared pick target; then WebGPUPickFramebuffer.resolveFeatureIdRecolorAsync()
// runs FeatureIdResolve.wgsl over that target, decoding + hashing each ID to a
// color on the GPU.
//
//   (1) CPU picks confirm cross-source coverage.
//   (2) The GPU resolve produces a NON-BLACK color at BOTH pixels.
//   (3) Those two colors DIFFER.
//   (4) DETERMINISM — a second resolve yields byte-identical colors.
//   (5) The OFF-GATE holds and the standing record-into-encoder path matches.
//   (6) 0 device / WebGPU validation errors.
//
// ── CELL 2: key span (AR-751) ──────────────────────────────────────────────
//
// The pick key is a monotonic uint32 that `Color.fromRgba` packs across all
// FOUR bytes — alpha is the key's HIGH byte, not an opacity. The shader decode
// used to read r, g, b only, so:
//
//   * two ids differing ONLY above bit 23 recolored identically, and
//   * every id that is a multiple of 2^24 decoded to 0, which the shader paints
//     as background — the feature vanished from the recolor.
//
// This cell stages three ids across that boundary by advancing the REAL
// allocator (`context._nextPickColor`, a Uint32Array `createPickId`
// pre-increments) and then allocating through the REAL factory the renderer
// itself calls (`PointPrimitive.getPickId`), with nothing between a seed and
// its allocation. It then reads back the key each primitive ACTUALLY got from
// the real registry (`context._pickObjects`) rather than assuming the staging
// landed. If the staging did not land the cell REFUSES with the observed keys
// rather than reporting a red, because a staging miss is not a product failure.
//
// The staging deliberately does NOT drive allocation by picking each point.
// A pick RECTANGLE does not select which ids are materialized: on WebGPU any
// pick pass runs `buildPickInstanceData` over every point in every collection
// (WebGPUPointPrimitiveRenderer.js:263-303), so a warm pick anywhere allocates
// all of them. The 2026-09-05 Edge leg refused `alias-pair-not-staged` with
// 0x3 / 0x4 for exactly that reason. `KEY_SPAN_PLAN` below is the plan, and
// `webgpu-pick-id-32-bit.spec.mjs` group E drives it through the real
// allocator in Node so the precondition is checkable without a browser and the
// refusal is proven fireable.
//
// The assertion is the strongest form available: each staged primitive's
// recolor must equal the Knuth hash of its FULL key, computed on the CPU from
// the key the registry reports. Under the 24-bit decode the alias pair produced
// one color for two keys and the multiple of 2^24 produced black.
//
// ── WHAT THE SHARED RUNTIME OWNS (DX-02 residency) ─────────────────────────
//
// Argument parsing, the single-Edge-slot lock, the Edge launch, the
// served-build preflight, element capture with its sha256, receipt
// serialization and the exit-code table all live in `lib/probe-runtime.mjs`.
// This file keeps the two scenes, the recolor readback math and the verdicts.
// The migration also adds the machine-safety watchdog and the try/finally page
// close the fleet contract requires, which is why this probe's row leaves
// `lib/probe-fleet-contract-allowlist.mjs` in the same change.
//
// PRECONDITIONS
//   * `npx gulp build` has run, so `/Build/CesiumUnminified/` is current.
//   * `node server.js --port 8094 --serve-built` is running. Use `localhost`,
//     not `127.0.0.1` — the dev server binds IPv6.
//   * Edge, not Firefox: Playwright's bundled Firefox has no WebGPU.
//
// Run: node server.js --port 8094 --serve-built   (separate terminal, once)
//      node Tools/visual-regression/probe-feature-id-texture.mjs
// Out: Tools/visual-regression/output/feature-id/*.png + feature-id-report.json
//      + feature-id-runtime.json + feature-id-summary.md

import {
  ProbeRefusal,
  captureElement,
  isEntryPoint,
  runProbe,
} from "./lib/probe-runtime.mjs";

const VIEWPORT = { width: 1024, height: 768 };
// Machine safety: kill a hung Edge/device rather than wedge the box. Expressed
// as a ProbeRefusal so the runtime's finally closes the browser instead of the
// process being killed out from under it.
const WATCHDOG_BUDGET_MS = 5 * 60 * 1000;

// The Knuth multiplicative constant `FeatureIdResolve.wgsl` hashes with. The
// shader computes `id * 2654435761u`, which wraps mod 2^32; `Math.imul` is the
// JS operation with those exact semantics.
const KNUTH = 2654435761;

/**
 * The recolor `FeatureIdResolve.wgsl` must produce for a given pick key, from
 * the CPU side. This is the shader's contract restated over the FULL key: a
 * decode that drops the key's high byte cannot produce this triple for any id
 * whose high byte is set.
 *
 * The xorshift finalizer is part of that contract, not a flourish. The colour is
 * the LOW three bytes of the hash and multiplication mod 2^32 carries only
 * upward, so `id * KNUTH` alone has low 24 bits that depend solely on the low
 * 24 bits of `id` — under which the alias pair recolors identically and every
 * multiple of 2^24 recolors to black, whatever the decode width. Group F of
 * `webgpu-pick-id-32-bit.spec.mjs` pins this function against the real shader
 * text, so the twin cannot drift from the shader the way it did before AR-751's
 * first Edge leg.
 *
 * @param {number} key The 32-bit pick key.
 * @returns {Array<number>} The expected [r, g, b] bytes.
 */
export function expectedRecolor(key) {
  const id = key >>> 0;
  if (id === 0) {
    return [0, 0, 0];
  }
  const hashed = Math.imul(id, KNUTH) >>> 0;
  const h = (hashed ^ (hashed >>> 16)) >>> 0;
  return [h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff];
}

/**
 * Whether two keys differ ONLY in bits at or above bit 24.
 *
 * @param {number} a One key.
 * @param {number} b The other key.
 * @returns {boolean} True when the low 24 bits match and the high byte differs.
 */
export function differsOnlyAboveBit23(a, b) {
  const x = (a ^ b) >>> 0;
  return (x & 0x00ffffff) === 0 && x >>> 24 !== 0;
}

/**
 * The three keys the key-span cell stages, and the allocator value each one is
 * reached from. `GraphicsContext.createPickId` PRE-increments
 * `_nextPickColor` (GraphicsContext.ts:1641-1642), so the seed for key K is
 * K - 1. Exported because `webgpu-pick-id-32-bit.spec.mjs` drives this exact
 * plan through the REAL allocator in Node — the staging precondition is
 * checkable without a browser, and the spec's canary reproduces a staging miss.
 *
 * `alias0` and `alias1` share their low 24 bits and differ by one step above
 * bit 23; `multiple` is a non-zero multiple of 2^24. Those are exactly the
 * three shapes AR-751's acceptance names.
 */
export const KEY_SPAN_PLAN = Object.freeze({
  alias0: Object.freeze({ key: 0x00000301, seed: 0x00000300 }),
  alias1: Object.freeze({ key: 0x01000301, seed: 0x01000300 }),
  multiple: Object.freeze({ key: 0x03000000, seed: 0x02ffffff }),
});

/**
 * Builds the cross-source scene and returns the two probe pixels plus the CPU
 * pick verdicts.
 *
 * @param {object} page The Playwright page.
 * @returns {Promise<object>} The scene's measurements.
 */
async function buildCrossSourceScene(page) {
  return await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;
    const errors = [];
    const dev = scene.context?._device;
    if (dev) {
      dev.onuncapturederror = (ev) =>
        errors.push(String(ev?.error?.message).slice(0, 250));
    }

    // Deterministic scene: keep the globe, drop sky/atmosphere so a globe-only
    // pixel is unambiguous.
    if (scene.skyBox) {
      scene.skyBox.show = false;
    }
    if (scene.skyAtmosphere) {
      scene.skyAtmosphere.show = false;
    }
    if (scene.sun) {
      scene.sun.show = false;
    }
    if (scene.moon) {
      scene.moon.show = false;
    }
    scene.fog.enabled = false;

    // Cross-source: a Billboard (BillboardCollection renderer) and a Point
    // (PointPrimitiveCollection renderer) — two DIFFERENT source pipelines that
    // both rasterize their own object ID into the ONE shared pick target.
    const img = document.createElement("canvas");
    img.width = 64;
    img.height = 64;
    const g2d = img.getContext("2d");
    g2d.fillStyle = "#ffffff";
    g2d.fillRect(0, 0, 64, 64);
    const bbs = scene.primitives.add(new C.BillboardCollection());
    const bb = bbs.add({
      position: C.Cartesian3.fromDegrees(-75, 40, 1000.0),
      image: img,
      color: C.Color.MAGENTA,
      id: "probe-feature-id-bb",
    });

    const points = scene.primitives.add(new C.PointPrimitiveCollection());
    const pt = points.add({
      position: C.Cartesian3.fromDegrees(-74.9, 40, 1000.0),
      pixelSize: 60,
      color: C.Color.CYAN,
      id: "probe-feature-id-pt",
    });

    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-75, 40, 25000.0),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });

    const renderN = async (n) => {
      for (let i = 0; i < n; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    };
    await renderN(90);

    const W = scene.canvas.clientWidth || 1024;
    const H = scene.canvas.clientHeight || 768;
    const cx = Math.floor(W / 2);
    const cy = Math.floor(H / 2);
    const bbScreen = scene.cartesianToCanvasCoordinates(bb.position);
    const ptScreen = scene.cartesianToCanvasCoordinates(pt.position);
    const bbX = Math.round(bbScreen?.x ?? cx);
    const bbY = Math.round(bbScreen?.y ?? cy);
    const ptX = Math.round(ptScreen?.x ?? cx + 200);
    const ptY = Math.round(ptScreen?.y ?? cy);

    const doPick = async (x, y, w = 1, h = 1) =>
      scene.pickAsync
        ? scene.pickAsync(new C.Cartesian2(x, y), w, h)
        : scene.pick(new C.Cartesian2(x, y), w, h);

    window.__fid = { C, v, scene, bb, pt, errors };
    window.__fidRenderN = renderN;
    window.__fidPick = doPick;

    const describe = (hit) => {
      if (!hit) {
        return { found: false };
      }
      return {
        found: true,
        isBillboard: hit === bb || hit.primitive === bb,
        isPoint: hit === pt || hit.primitive === pt,
        id: typeof hit?.id === "string" ? hit.id : undefined,
        primitiveCtor: hit?.primitive?.constructor?.name,
      };
    };

    // Warm-up (pick pipelines materialize lazily on first pass).
    await doPick(bbX, bbY, 9, 9);
    await doPick(ptX, ptY, 9, 9);
    await renderN(12);

    const bbHit = describe(await doPick(bbX, bbY, 5, 5));
    const ptHit = describe(await doPick(ptX, ptY, 5, 5));

    // One wide pick covering BOTH sources so the shared ID target holds both.
    const midX = Math.round((bbX + ptX) / 2);
    const midY = Math.round((bbY + ptY) / 2);
    const spanW = Math.abs(bbX - ptX) + 200;
    const spanH = Math.abs(bbY - ptY) + 200;
    await doPick(midX, midY, spanW, spanH);
    await renderN(2);

    const pfb = scene.view.pickFramebuffer;
    // OFF-GATE: before any resolve/record call the standing resolve helper must
    // never have been constructed — untouched scenes allocate nothing.
    const offGate = {
      hasResolve: typeof pfb?.resolveFeatureIdRecolorAsync === "function",
      hasRecord: typeof pfb?.recordFeatureIdResolve === "function",
      viewNullBeforeResolve: pfb?.featureIdRecolorView === null,
      textureNullBeforeResolve: pfb?.featureIdRecolorTexture === null,
    };

    return {
      W,
      H,
      bbX,
      bbY,
      ptX,
      ptY,
      midX,
      midY,
      spanW,
      spanH,
      bbHit,
      ptHit,
      offGate,
    };
  });
}

/**
 * Runs the one-shot resolve, the standing record-into-encoder resolve, and
 * paints the recolor into a page canvas the runtime can capture.
 *
 * @param {object} page The Playwright page.
 * @param {object} scene The cross-source scene's measurements.
 * @returns {Promise<object>} The resolve results.
 */
async function resolveCrossSource(page, scene) {
  return await page.evaluate(async (s) => {
    const { scene: sc } = window.__fid;
    const pfb = sc.view.pickFramebuffer;
    const out = {};
    const at = (buf, width, height, x, y) => {
      const xi = Math.max(0, Math.min(width - 1, Math.floor(x)));
      const yi = Math.max(0, Math.min(height - 1, Math.floor(y)));
      const i = 4 * (yi * width + xi);
      return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
    };
    const eq = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
    const nonBlack = (c) => c[0] !== 0 || c[1] !== 0 || c[2] !== 0;

    const r1 = await pfb.resolveFeatureIdRecolorAsync();
    const r2 = await pfb.resolveFeatureIdRecolorAsync();
    if (!r1 || !r2) {
      return { resolved: false };
    }
    const { width, height, pixels } = r1;
    // The pick FBO / resolve output is stored TOP-DOWN (row 0 = top of frame),
    // matching the canvas client coords used above.
    const bbColor = at(pixels, width, height, s.bbX, s.bbY);
    const ptColor = at(pixels, width, height, s.ptX, s.ptY);
    out.resolved = true;
    out.width = width;
    out.height = height;
    out.bbColor = bbColor;
    out.ptColor = ptColor;
    out.bbNonBlack = nonBlack(bbColor);
    out.ptNonBlack = nonBlack(ptColor);
    out.distinct = !eq(bbColor, ptColor);
    out.deterministic =
      eq(bbColor, at(r2.pixels, width, height, s.bbX, s.bbY)) &&
      eq(ptColor, at(r2.pixels, width, height, s.ptX, s.ptY));

    // Paint the recolor for the runtime's element capture.
    let outCanvas = document.getElementById("featureIdRecolor");
    if (!outCanvas) {
      outCanvas = document.createElement("canvas");
      outCanvas.id = "featureIdRecolor";
      outCanvas.style.position = "fixed";
      outCanvas.style.left = "0";
      outCanvas.style.top = "0";
      outCanvas.style.zIndex = "99999";
      document.body.appendChild(outCanvas);
    }
    outCanvas.width = width;
    outCanvas.height = height;
    const octx = outCanvas.getContext("2d");
    const imgData = octx.createImageData(width, height);
    imgData.data.set(pixels);
    octx.putImageData(imgData, 0, 0);
    // Mark the two probe pixels with small crosshairs for the reviewer.
    octx.strokeStyle = "#00ff00";
    octx.strokeRect(s.bbX - 6, s.bbY - 6, 12, 12);
    octx.strokeStyle = "#ff8800";
    octx.strokeRect(s.ptX - 6, s.ptY - 6, 12, 12);

    // STANDING PER-FRAME PP WIRING (R-2b residual a): record the recolor into a
    // caller-created encoder and read its persistent output back in the SAME
    // submit — no separate submit, no per-call teardown.
    const device = sc.context?._device;
    const standing = {
      available: typeof pfb.recordFeatureIdResolve === "function",
    };
    if (standing.available && device) {
      await window.__fidPick(s.midX, s.midY, s.spanW, s.spanH);
      await window.__fidRenderN(1);
      const readStanding = async () => {
        const enc = device.createCommandEncoder({
          label: "probe-standing-fid",
        });
        const view = pfb.recordFeatureIdResolve(enc);
        const outTex = pfb.featureIdRecolorTexture;
        if (!view || !outTex) {
          return null;
        }
        const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
        const staging = device.createBuffer({
          size: bytesPerRow * height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        enc.copyTextureToBuffer(
          { texture: outTex },
          { buffer: staging, bytesPerRow, rowsPerImage: height },
          [width, height],
        );
        device.queue.submit([enc.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const mapped = new Uint8Array(staging.getMappedRange());
        const px = new Uint8Array(width * height * 4);
        for (let row = 0; row < height; row++) {
          px.set(
            mapped.subarray(row * bytesPerRow, row * bytesPerRow + width * 4),
            row * width * 4,
          );
        }
        staging.unmap();
        staging.destroy();
        return { tex: outTex, px };
      };
      const s1 = await readStanding();
      const s2 = await readStanding();
      if (s1 && s2) {
        const bbS = at(s1.px, width, height, s.bbX, s.bbY);
        const ptS = at(s1.px, width, height, s.ptX, s.ptY);
        standing.bbNonBlack = nonBlack(bbS);
        standing.ptNonBlack = nonBlack(ptS);
        standing.distinct = !eq(bbS, ptS);
        // Persistent output texture reused across records (no per-call realloc).
        standing.persistentTexture = s1.tex === s2.tex;
        standing.deterministic =
          eq(bbS, at(s2.px, width, height, s.bbX, s.bbY)) &&
          eq(ptS, at(s2.px, width, height, s.ptX, s.ptY));
        // Standing path matches the one-shot readback path bit-for-bit.
        standing.matchesOneShot = eq(bbS, bbColor) && eq(ptS, ptColor);
        standing.viewLiveAfterRecord = pfb.featureIdRecolorView !== null;
      }
    }
    out.standing = standing;
    return out;
  }, scene);
}

/**
 * Stages three pick ids across the 2^24 boundary — by seeding the real
 * allocator and immediately allocating through the real `getPickId` factory,
 * before any pick pass can materialize them — and reads back the key each
 * primitive ACTUALLY received from the real pick registry.
 *
 * @param {object} page The Playwright page.
 * @returns {Promise<object>} The staged keys, the plan, and screen positions.
 */
async function stageKeySpan(page) {
  return await page.evaluate(async (plan) => {
    const { C, scene } = window.__fid;
    const doPick = window.__fidPick;
    const renderN = window.__fidRenderN;
    const context = scene.context;

    // Three points, each in its own collection so each is its own pick target.
    const make = (dLon, colour) => {
      const collection = scene.primitives.add(new C.PointPrimitiveCollection());
      return collection.add({
        position: C.Cartesian3.fromDegrees(-75 + dLon, 39.94, 1000.0),
        pixelSize: 60,
        color: colour,
        id: `probe-feature-id-span-${dLon}`,
      });
    };
    const alias0 = make(-0.06, C.Color.YELLOW);
    const alias1 = make(0.0, C.Color.LIME);
    const multiple = make(0.06, C.Color.ORANGE);

    // The key a primitive actually got, read from the REAL registry rather than
    // assumed from the seed.
    const keyOf = (primitive) => {
      for (const [key, target] of context._pickObjects) {
        if (target === primitive || target?.primitive === primitive) {
          return key >>> 0;
        }
      }
      return null;
    };

    const screenOf = (primitive) => {
      const s = scene.cartesianToCanvasCoordinates(primitive.position);
      return { x: Math.round(s?.x ?? 0), y: Math.round(s?.y ?? 0) };
    };

    // Stage all three ids BEFORE any pick pass exists to consume them.
    //
    // The staging must NOT be driven by picking a rectangle over each point.
    // On WebGPU a pick id is not materialized by the pick RECTANGLE: the point
    // feature renderer's `buildPickInstanceData` walks EVERY point in the
    // collection and calls `point.getPickId(context)`
    // (WebGPUPointPrimitiveRenderer.js:263-303) whenever `frameState.passes.pick`
    // is set, and `Scene.pick` updates every primitive regardless of where the
    // rectangle falls. So ANY pick anywhere on the canvas allocates all three
    // staged points at once, in creation order — which is what happened on
    // 2026-09-05, when the warm pick materialized them as 0x3 / 0x4 / 0x5 and
    // the cell rightly REFUSED `alias-pair-not-staged`. Narrowing the warm
    // rectangle cannot fix that, because the rectangle was never what allocated.
    //
    // Instead seed the real allocator and allocate through the real factory the
    // renderer itself calls, with nothing between the seed and the allocation.
    // `PointPrimitive.getPickId` memoizes on `_pickId` (PointPrimitive.js:454-466),
    // so the renderer later finds the id already present and reuses it verbatim.
    // No pick, render or await separates a seed from its allocation, so no
    // neighbour can interleave.
    const stage = (primitive, step) => {
      context._nextPickColor[0] = step.seed;
      primitive.getPickId(context);
    };
    stage(alias0, plan.alias0);
    stage(alias1, plan.alias1);
    stage(multiple, plan.multiple);

    // Now settle the scene and take the screen positions.
    await renderN(30);
    const a0 = screenOf(alias0);
    const a1 = screenOf(alias1);
    const m = screenOf(multiple);

    // The full-canvas warm pick is KEPT, and now runs AFTER staging. It is the
    // very pass that used to steal the ids; running it here and still reading
    // the planned keys back is the demonstration that the staging no longer
    // depends on pick geometry. It also warms the pick pipeline and writes the
    // staged pick colors into the instance buffer the recolor reads.
    const warmX = Math.floor((scene.canvas.clientWidth || 1024) / 2);
    const warmY = Math.floor((scene.canvas.clientHeight || 768) / 2);
    await doPick(warmX, warmY, 900, 700);
    await renderN(4);
    await doPick(warmX, warmY, 900, 700);
    await renderN(4);

    // The keys are read back from the REAL registry, never from the plan. If a
    // future edit unstages the pair, these are what the cell refuses over.
    const alias0Key = keyOf(alias0);
    const alias1Key = keyOf(alias1);
    const multipleKey = keyOf(multiple);

    return {
      alias0: { key: alias0Key, ...a0 },
      alias1: { key: alias1Key, ...a1 },
      multiple: { key: multipleKey, ...m },
      planned: {
        alias0: plan.alias0.key,
        alias1: plan.alias1.key,
        multiple: plan.multiple.key,
      },
      nextPickColor: context._nextPickColor[0] >>> 0,
    };
  }, KEY_SPAN_PLAN);
}

/**
 * Resolves the recolor over the staged points and reports the color at each.
 *
 * @param {object} page The Playwright page.
 * @param {object} span The staged keys.
 * @returns {Promise<object>} The recolor at each staged pixel.
 */
async function resolveKeySpan(page, span) {
  return await page.evaluate(async (s) => {
    const { scene } = window.__fid;
    const doPick = window.__fidPick;
    const renderN = window.__fidRenderN;
    const pfb = scene.view.pickFramebuffer;
    const W = scene.canvas.clientWidth || 1024;
    const H = scene.canvas.clientHeight || 768;
    // One wide pick so all three staged points land in the shared target.
    await doPick(Math.floor(W / 2), Math.floor(H / 2), W - 2, H - 2);
    await renderN(2);
    const r = await pfb.resolveFeatureIdRecolorAsync();
    if (!r) {
      return { resolved: false };
    }
    const at = (x, y) => {
      const xi = Math.max(0, Math.min(r.width - 1, Math.floor(x)));
      const yi = Math.max(0, Math.min(r.height - 1, Math.floor(y)));
      const i = 4 * (yi * r.width + xi);
      return [r.pixels[i], r.pixels[i + 1], r.pixels[i + 2]];
    };
    return {
      resolved: true,
      width: r.width,
      height: r.height,
      alias0Color: at(s.alias0.x, s.alias0.y),
      alias1Color: at(s.alias1.x, s.alias1.y),
      multipleColor: at(s.multiple.x, s.multiple.y),
    };
  }, span);
}

/**
 * Turns the staged keys and their recolors into the AR-751 verdict inputs. A
 * staging miss REFUSES; only a real disagreement between the shader and the key
 * is a red.
 *
 * @param {object} span The staged keys.
 * @param {object} colors The recolor at each staged pixel.
 * @returns {object} The key-span cell.
 */
export function buildKeySpanCell(span, colors) {
  const { alias0, alias1, multiple } = span;
  if (alias0.key === null || alias1.key === null || multiple.key === null) {
    throw new ProbeRefusal(
      "staged-key-unregistered",
      "a staged point never appeared in the pick registry, so no key could be read back",
      { span },
    );
  }
  if (!differsOnlyAboveBit23(alias0.key, alias1.key)) {
    throw new ProbeRefusal(
      "alias-pair-not-staged",
      `the alias pair does not differ only above bit 23: 0x${alias0.key.toString(16)} vs 0x${alias1.key.toString(16)}`,
      { alias0: alias0.key, alias1: alias1.key, planned: span.planned ?? null },
    );
  }
  if ((multiple.key & 0x00ffffff) !== 0 || multiple.key >>> 24 === 0) {
    throw new ProbeRefusal(
      "multiple-not-staged",
      `the third key is not a non-zero multiple of 2^24: 0x${multiple.key.toString(16)}`,
      { multiple: multiple.key },
    );
  }
  if (!colors.resolved) {
    throw new ProbeRefusal(
      "resolve-declined",
      "resolveFeatureIdRecolorAsync returned nothing for the key-span scene",
      {},
    );
  }
  const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  const nonBlack = (c) => c[0] !== 0 || c[1] !== 0 || c[2] !== 0;
  const expected0 = expectedRecolor(alias0.key);
  const expected1 = expectedRecolor(alias1.key);
  const expectedMultiple = expectedRecolor(multiple.key);
  return {
    cell: "key-span",
    keys: { alias0: alias0.key, alias1: alias1.key, multiple: multiple.key },
    colors,
    expected: {
      alias0: expected0,
      alias1: expected1,
      multiple: expectedMultiple,
    },
    // The two ids differing only above bit 23 recolor differently.
    aliasPairDistinct: !same(colors.alias0Color, colors.alias1Color),
    // The multiple of 2^24 is not painted as background.
    multipleNonBlack: nonBlack(colors.multipleColor),
    // The strongest form: each recolor is the hash of the FULL key.
    alias0MatchesFullKey: same(colors.alias0Color, expected0),
    alias1MatchesFullKey: same(colors.alias1Color, expected1),
    multipleMatchesFullKey: same(colors.multipleColor, expectedMultiple),
  };
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "feature-id",
  title: "Unified feature-ID texture (R-2b) + 32-bit pick keys (AR-751)",
  outputSubdirectory: "feature-id",
  receiptEnvelope: "probe-owned",
  // FeatureIdResolve.wgsl and WebGPUPickFramebuffer are WebGPU-only; WebGL's
  // PickFramebuffer has no shader-samplable feature-ID G-buffer at all.
  args: { defaults: { renderers: ["webgpu"] } },
  async cells({ browser, origin, outputDirectory, options, captures }) {
    if (options.renderers.length !== 1 || options.renderers[0] !== "webgpu") {
      throw new ProbeRefusal(
        "renderer-not-webgpu",
        `probe-feature-id-texture only measures webgpu (WebGL has no shader-samplable feature-ID G-buffer); got --renderer ${options.renderers.join(",")}`,
        { renderers: options.renderers },
      );
    }
    const work = (async () => {
      const page = await browser.newPage({ viewport: VIEWPORT });
      try {
        await page.goto(
          `${origin}/Apps/CesiumViewer/index.html?renderer=webgpu`,
          { waitUntil: "networkidle", timeout: 90000 },
        );
        await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

        const scene = await buildCrossSourceScene(page);
        if (!scene.offGate.hasResolve) {
          throw new ProbeRefusal(
            "resolve-absent",
            "the served bundle has no resolveFeatureIdRecolorAsync — rebuild before running this probe",
            {},
          );
        }
        const resolved = await resolveCrossSource(page, scene);
        await captureElement({
          page,
          selector: "#featureIdRecolor",
          name: "feature-id-recolor",
          outputDirectory,
          captures,
        });

        const span = await stageKeySpan(page);
        const spanColors = await resolveKeySpan(page, span);
        const deviceErrors = await page.evaluate(
          () => window.__fid?.errors ?? [],
        );
        return [
          { cell: "cross-source", scene, resolved, deviceErrors },
          buildKeySpanCell(span, spanColors),
        ];
      } finally {
        await page.close();
      }
    })();
    // A watchdog loss leaves `work` running against a page the runtime is about
    // to close; that trailing rejection has no reader left.
    work.catch(() => {});
    let watchdogTimer;
    const watchdog = new Promise((_resolve, reject) => {
      watchdogTimer = setTimeout(
        () =>
          reject(
            new ProbeRefusal(
              "watchdog-timeout",
              `probe-feature-id-texture exceeded its ${WATCHDOG_BUDGET_MS}ms machine-safety budget`,
              { budgetMs: WATCHDOG_BUDGET_MS },
            ),
          ),
        WATCHDOG_BUDGET_MS,
      );
    });
    try {
      return await Promise.race([work, watchdog]);
    } finally {
      clearTimeout(watchdogTimer);
    }
  },
  verdicts(cells) {
    const verdicts = [];
    const cross = cells.find((c) => c.cell === "cross-source");
    if (cross) {
      const { scene, resolved, deviceErrors } = cross;
      const standing = resolved.standing ?? {};
      verdicts.push({
        id: "cross-source",
        claim:
          "R-2b — two distinct pick sources resolve to distinct non-black in-shader colors, deterministically, off-gated and reachable from a standing encoder",
        pass:
          scene.bbHit.found === true &&
          scene.bbHit.isBillboard === true &&
          scene.ptHit.found === true &&
          scene.ptHit.isPoint === true &&
          scene.offGate.hasRecord === true &&
          scene.offGate.viewNullBeforeResolve === true &&
          scene.offGate.textureNullBeforeResolve === true &&
          resolved.resolved === true &&
          resolved.bbNonBlack === true &&
          resolved.ptNonBlack === true &&
          resolved.distinct === true &&
          resolved.deterministic === true &&
          standing.available === true &&
          standing.bbNonBlack === true &&
          standing.ptNonBlack === true &&
          standing.distinct === true &&
          standing.deterministic === true &&
          standing.persistentTexture === true &&
          standing.matchesOneShot === true &&
          standing.viewLiveAfterRecord === true &&
          (deviceErrors?.length ?? 0) === 0,
      });
    }
    const span = cells.find((c) => c.cell === "key-span");
    if (span) {
      verdicts.push({
        id: "key-span",
        claim:
          "AR-751 — the recolor is the hash of the FULL 32-bit key: ids differing only above bit 23 stay distinct, and a multiple of 2^24 is not background",
        pass:
          span.aliasPairDistinct === true &&
          span.multipleNonBlack === true &&
          span.alias0MatchesFullKey === true &&
          span.alias1MatchesFullKey === true &&
          span.multipleMatchesFullKey === true,
      });
    }
    return verdicts;
  },
  receipt(cells, context) {
    return {
      base: context.origin,
      generatedAt: context.generatedAt,
      verdicts: context.verdicts,
      cells,
    };
  },
  summary(receipt) {
    const passed = receipt.verdicts.filter((v) => v.pass === true).length;
    const span = receipt.cells.find((c) => c.cell === "key-span");
    return [
      "# Unified feature-ID texture (R-2b) + 32-bit pick keys (AR-751)",
      "",
      `Base: \`${receipt.base}\``,
      "",
      `Verdicts: ${passed}/${receipt.verdicts.length} passed.`,
      "",
      span
        ? `Staged keys: alias pair 0x${span.keys.alias0.toString(16)} / 0x${span.keys.alias1.toString(16)}, multiple 0x${span.keys.multiple.toString(16)}.`
        : "No key-span cell was produced.",
      "",
    ].join("\n");
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
