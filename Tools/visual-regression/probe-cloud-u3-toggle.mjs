#!/usr/bin/env node
/**
 * Probe (CLOUD-U3-PUBLISH-CONSUME-TOGGLE acceptance + STANDING regression guard):
 * slice 3 of the cloud-unification epic wires CloudCollection.update() to
 * PUBLISH a resolved CloudVolumetrics snapshot (via the backend-neutral
 * context.requestVolumetricClouds seam) when the collection is shown, its
 * renderMode is VOLUMETRIC, and volumetric.enabled is true — and to SUPPRESS
 * that collection's own billboards (exclusive toggle). The env-effects phase
 * CONSUMES the request and drives the PROCEDURAL_CLOUDS renderer for a single
 * primary deck (first VOLUMETRIC collection wins). globe.defaultCloudCollection.enableVolumetric
 * still works (removed in slice 4).
 *
 * This is a PERMANENT guard — do NOT delete any case. It covers ALL of:
 *  (a) WebGPU: a VOLUMETRIC CloudCollection renders a volumetric deck AND
 *      publishes exactly the resolved config (showProceduralClouds:true,
 *      enabled:true); its own billboards are suppressed.
 *  (b) WebGL: a VOLUMETRIC collection is billboards-only (volumetric no-op) —
 *      publishes NOTHING (requestVolumetricClouds never called; base no-op).
 *  (c) a BILLBOARD collection renders puffs and publishes NOTHING — byte-locked
 *      to the legacy path (the before/after HASH lines below prove byte-identity
 *      vs a HEAD build).
 *  (d) CRITICAL show=false: col.show=false while renderMode=VOLUMETRIC AND
 *      volumetric.enabled=true MUST publish nothing (reqCount===0) and draw no
 *      billboards — a hidden collection cedes the deck. This keeps the
 *      `this.show && publish` gate under permanent coverage: a regression that
 *      drops the `this.show` guard fails HERE.
 *
 * A spy wraps context.requestVolumetricClouds to count publishes per case.
 * Scene is globe/sky/sun/moon-off + solid black background so cloud pixels
 * dominate and the no-draw cases (empty / suppressed / hidden) hash identically.
 *
 * Usage:  node Tools/visual-regression/probe-cloud-u3-toggle.mjs
 * Env:    PROBE_BASE (default http://localhost:8080)
 *         U3_TAG     (label folded into PNG names + the HASH line, e.g. after/before)
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const TAG = process.env.U3_TAG || "after";

async function runBackend(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push("PAGEERR:" + e.message));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer,
      scene = v.scene;

    // Deterministic scene: no globe/sky/sun/moon, solid black background so the
    // no-draw cases are byte-identical and cloud pixels are unambiguous.
    scene.globe.show = false;
    if (scene.skyBox) scene.skyBox.show = false;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    scene.backgroundColor = C.Color.BLACK;

    // Camera above the cloud layer looking down so BOTH the billboard puffs
    // (at 3 km) and the planet-wide volumetric shell (1.5–4 km) are in view.
    // The static (no-draw / billboard) cases render byte-identically without a
    // clock freeze — nothing animates; the deck case only asserts presence
    // (cloudish), never byte-equality, so wind advection variance is harmless.
    scene.camera.setView({
      destination: C.Cartesian3.fromDegrees(-95.0, 39.0, 16000.0),
    });

    const ctx = scene.context;
    // ── Publish spy: count requestVolumetricClouds calls per case. ──
    const origReq = ctx.requestVolumetricClouds.bind(ctx);
    ctx._u3Count = 0;
    ctx._u3Last = null;
    ctx.requestVolumetricClouds = function (cfg) {
      ctx._u3Count++;
      ctx._u3Last = cfg;
      return origReq(cfg);
    };

    function fnv(str) {
      let hh = 0x811c9dc5;
      for (let i = 0; i < str.length; i++) {
        hh ^= str.charCodeAt(i);
        hh = Math.imul(hh, 0x01000193);
      }
      return hh >>> 0;
    }

    async function settle(n) {
      for (let i = 0; i < n; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    }

    function capture() {
      scene.render();
      const url = scene.canvas.toDataURL("image/png");
      const canvas = scene.canvas,
        w = canvas.width,
        h = canvas.height;
      const tmp = document.createElement("canvas");
      tmp.width = w;
      tmp.height = h;
      const cx = tmp.getContext("2d");
      cx.drawImage(canvas, 0, 0);
      const px = cx.getImageData(0, 0, w, h).data;
      let bright = 0,
        cloudish = 0;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i],
          gg = px[i + 1],
          b = px[i + 2];
        if (r + gg + b > 60) bright++;
        const mx = Math.max(r, gg, b),
          mn = Math.min(r, gg, b);
        const sat = mx > 0 ? (mx - mn) / mx : 0;
        if (mx > 120 && sat < 0.25) cloudish++;
      }
      return { hash: fnv(url), bright, cloudish, w, h, url };
    }

    function addPuffs(coll) {
      const pts = [
        [-95.02, 39.0],
        [-95.0, 39.0],
        [-94.98, 39.0],
        [-95.0, 39.02],
        [-95.0, 38.98],
      ];
      for (const [lon, lat] of pts) {
        coll.add({
          position: C.Cartesian3.fromDegrees(lon, lat, 3000.0),
          scale: new C.Cartesian2(2000.0, 1300.0),
          maximumSize: new C.Cartesian3(2000.0, 1300.0, 900.0),
          brightness: 1.0,
        });
      }
    }

    function configVolumetric(coll) {
      const vol = coll.volumetric;
      vol.cloudCoverage = 0.7;
      vol.cloudDensity = 0.85;
      vol.cloudLayerBottom = 1500.0;
      vol.cloudLayerTop = 4000.0;
      vol.cloudWindSpeed = 12.0;
    }

    async function runCase(buildFn, frames) {
      ctx._u3Count = 0;
      ctx._u3Last = null;
      const coll = buildFn();
      if (coll) {
        scene.primitives.add(coll);
      }
      await settle(frames);
      const cap = capture();
      cap.reqCount = ctx._u3Count;
      cap.reqEnabled = ctx._u3Last ? ctx._u3Last.enabled : null;
      cap.reqShowProc = ctx._u3Last ? ctx._u3Last.showProceduralClouds : null;
      if (coll) {
        scene.primitives.remove(coll);
      }
      await settle(3); // clear any pending deck state before the next baseline
      const url = cap.url;
      delete cap.url;
      return { cap, url };
    }

    // ── empty baseline (no cloud collection) ──
    const empty = await runCase(() => null, 8);

    // ── (c) BILLBOARD collection: puffs render, publishes nothing ──
    const billboard = await runCase(() => {
      const coll = new C.CloudCollection();
      addPuffs(coll);
      return coll;
    }, 24);

    // ── suppression / no-op: VOLUMETRIC + puffs but volumetric DISABLED ──
    //    WebGPU: billboards suppressed by the exclusive mode → hash === empty.
    //    WebGL:  no suppression (volumetric no-op) → billboards render.
    const suppressed = await runCase(() => {
      const coll = new C.CloudCollection({
        renderMode: C.CloudRenderMode.VOLUMETRIC,
      });
      addPuffs(coll);
      return coll;
    }, 24);

    // ── (d) CRITICAL show=false: VOLUMETRIC + enabled but hidden → cede deck ──
    const hidden = await runCase(() => {
      const coll = new C.CloudCollection({ enableVolumetric: true });
      coll.show = false;
      configVolumetric(coll);
      addPuffs(coll);
      return coll;
    }, 24);

    // ── (a)/(b) VOLUMETRIC deck: enabled + shown ──
    //    WebGPU: publishes + renders a volumetric deck, billboards suppressed.
    //    WebGL:  publishes nothing (base no-op), billboards render (no-op).
    const deck = await runCase(() => {
      const coll = new C.CloudCollection({ enableVolumetric: true });
      configVolumetric(coll);
      addPuffs(coll);
      return coll;
    }, 120);

    return {
      renderer: scene.context?.rendererType,
      empty: empty.cap,
      billboard: billboard.cap,
      suppressed: suppressed.cap,
      hidden: hidden.cap,
      deck: deck.cap,
      billboardUrl: billboard.url,
      deckUrl: deck.url,
    };
  });

  // Save the billboard + deck screenshots for human read.
  writeFileSync(
    `Tools/visual-regression/out-cloud-u3-${renderer}-billboard-${TAG}.png`,
    Buffer.from(result.billboardUrl.split(",")[1], "base64"),
  );
  writeFileSync(
    `Tools/visual-regression/out-cloud-u3-${renderer}-deck-${TAG}.png`,
    Buffer.from(result.deckUrl.split(",")[1], "base64"),
  );
  delete result.billboardUrl;
  delete result.deckUrl;

  await browser.close();
  return { renderer, errors, ...result };
}

const results = [];
for (const r of ["webgl", "webgpu"]) {
  results.push(await runBackend(r));
}

let ok = true;
for (const res of results) {
  const { empty, billboard, suppressed, hidden, deck } = res;
  const isGPU = res.renderer === "webgpu";
  const errFiltered = res.errors.filter(
    (e) => !/AtmosphereLUT|default layout/.test(e),
  );

  const checks = {
    // (c) BILLBOARD: puffs visible + NO publish (both backends).
    billboardPuffsVisible: billboard.bright > empty.bright + 50,
    billboardNoPublish: billboard.reqCount === 0,
    // (d) CRITICAL hidden: no publish + no billboards (both backends).
    hiddenNoPublish: hidden.reqCount === 0,
    hiddenNoDraw: hidden.hash === empty.hash,
    zeroErrors: errFiltered.length === 0,
  };

  if (isGPU) {
    // (a) WebGPU VOLUMETRIC deck: publishes the resolved config + renders a deck.
    checks.deckPublished = deck.reqCount >= 1;
    checks.deckReqEnabled = deck.reqEnabled === true;
    checks.deckReqShowProc = deck.reqShowProc === true;
    checks.deckRenders = deck.cloudish > empty.cloudish + 200;
    checks.deckDiffersFromEmpty = deck.hash !== empty.hash;
    // Exclusive suppression: VOLUMETRIC (disabled) + puffs draws NOTHING.
    checks.billboardsSuppressed = suppressed.hash === empty.hash;
    checks.suppressedNoPublish = suppressed.reqCount === 0; // enabled:false → no publish
  } else {
    // (b) WebGL VOLUMETRIC is billboards-only + publishes nothing (base no-op).
    checks.webglVolNoPublish = deck.reqCount === 0;
    checks.webglVolBillboardsOnly = deck.bright > empty.bright + 50;
    // WebGL has no suppression — the disabled VOLUMETRIC collection still draws
    // its billboards (documents the graceful no-op).
    checks.webglNoSuppression = suppressed.bright > empty.bright + 50;
    checks.webglSuppressedNoPublish = suppressed.reqCount === 0;
  }

  const failed = Object.entries(checks).filter(([, v]) => !v);
  if (failed.length) ok = false;

  console.log(`\n=== ${res.renderer.toUpperCase()} ===`);
  console.log(
    `  empty     hash=${empty.hash} bright=${empty.bright} cloudish=${empty.cloudish}`,
  );
  console.log(
    `  billboard hash=${billboard.hash} bright=${billboard.bright} req=${billboard.reqCount}`,
  );
  console.log(
    `  suppress  hash=${suppressed.hash} bright=${suppressed.bright} req=${suppressed.reqCount}`,
  );
  console.log(
    `  hidden    hash=${hidden.hash} bright=${hidden.bright} req=${hidden.reqCount}`,
  );
  console.log(
    `  deck      hash=${deck.hash} bright=${deck.bright} cloudish=${deck.cloudish} req=${deck.reqCount} enabled=${deck.reqEnabled} showProc=${deck.reqShowProc}`,
  );
  console.log(`  checks: ${JSON.stringify(checks)}`);
  if (failed.length) {
    console.log(`  FAILED: ${failed.map(([k]) => k).join(", ")}`);
  }
  if (errFiltered.length) {
    console.log(`  console errors: ${JSON.stringify(errFiltered.slice(0, 5))}`);
  }
  // Byte-identity anchor for the BILLBOARD path (compare across before/after builds).
  console.log(
    `U3_HASH ${TAG} ${res.renderer} billboard=${billboard.hash} empty=${empty.hash}`,
  );
}

console.log(`\n${ok ? "PASS" : "FAIL"} — CLOUD-U3-PUBLISH-CONSUME-TOGGLE`);
process.exit(ok ? 0 : 1);
