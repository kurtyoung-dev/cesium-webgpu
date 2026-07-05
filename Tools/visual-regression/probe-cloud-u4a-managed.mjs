#!/usr/bin/env node
/**
 * Probe (CLOUD-U4A-SCENE-DEFAULT-COLLECTION acceptance + STANDING regression guard).
 *
 * Slice 4A of the cloud-unification epic adds a Scene/Globe-owned MANAGED
 * default volumetric-capable CloudCollection (`scene.globe.defaultCloudCollection`)
 * and RE-HOMES the four config producers onto its `.volumetric` CloudVolumetrics:
 *   (1) scene.globe.atmosphericConditions.clouds.*  (the user cloud facade)
 *   (2) AtmosphericEffects genus bias -> collection.cloudType
 *   (3) weather ingest -> collection.volumetric.weatherProvider
 *   (4) scene.godRayCloudAware gate -> collection.renderMode === VOLUMETRIC
 *
 * Assertions (per backend):
 *   A. DEFAULT scene renders + a stable hash is emitted (DEFAULT_HASH line) so a
 *      before/after build comparison proves the OFF path is byte-identical. The
 *      managed collection defaults to BILLBOARD / volumetric.enabled=false, so it
 *      publishes nothing and the env-effects falls back to the globe path.
 *   B. The managed collection exists, defaults to BILLBOARD, and its `.volumetric`
 *      defaults equal the historical globe.cloud* defaults (0.5 / 1500 / 4000 /
 *      0.3 / 15 / 64).
 *   C. Re-home (1): setting atmosphericConditions.clouds.enableProcedural=true flips
 *      the managed collection to VOLUMETRIC + volumetric.enabled, and the dials
 *      proxy onto collection.volumetric. On WebGPU a volumetric deck then renders
 *      (cloudish pixels increase); on WebGL it is a documented no-op.
 *   D. Re-home (3): a weatherProvider attached via the facade lands on
 *      collection.volumetric.weatherProvider.
 *   E. Re-home (2): atmosphericConditions.clouds.cloudType writes the collection genus.
 *   F. globe.defaultCloudCollection.enableVolumetric default stays false (producers no longer write it).
 *
 * Usage:  node Tools/visual-regression/probe-cloud-u4a-managed.mjs
 * Env:    PROBE_BASE (default http://localhost:8080)
 *         U4A_TAG    (label folded into the DEFAULT_HASH line, e.g. after/before)
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const TAG = process.env.U4A_TAG || "after";

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

    // Deterministic default scene: fixed time + fixed camera so the DEFAULT_HASH
    // is reproducible across builds (globe + sky + sun ON — the real default).
    v.clock.shouldAnimate = false;
    v.clock.currentTime = C.JulianDate.fromIso8601("2023-06-21T18:00:00Z");
    scene.camera.setView({
      destination: C.Cartesian3.fromDegrees(-95.0, 39.0, 12_000_000.0),
    });

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
      return { hash: fnv(url), bright, cloudish, url };
    }

    // ── A. DEFAULT scene (managed collection inert) ──
    await settle(30);
    const def = capture();

    // ── B. managed collection existence + defaults ──
    const coll = scene.globe.defaultCloudCollection;
    const vol = coll.volumetric;
    const defaults = {
      exists: !!coll,
      renderModeBillboard: coll.renderMode === C.CloudRenderMode.BILLBOARD,
      volEnabledFalse: vol.enabled === false,
      coverage: vol.cloudCoverage,
      layerBottom: vol.cloudLayerBottom,
      layerTop: vol.cloudLayerTop,
      density: vol.cloudDensity,
      windSpeed: vol.cloudWindSpeed,
      quality: vol.cloudQuality,
      showProcDefaultFalse: scene.globe.defaultCloudCollection.enableVolumetric === false,
    };

    // ── F/E/D re-home writes land on the collection (before enabling) ──
    const clouds = scene.globe.atmosphericConditions.clouds;
    clouds.proceduralCoverage = 0.77;
    clouds.density = 0.9;
    clouds.cloudType = C.CloudType.STRATUS;
    const fakeProvider = {
      version: 3,
      getPackedTexture() {
        return null;
      },
      getPresentWeather() {
        return { ww: 61, visibilityKm: 4 };
      },
    };
    clouds.weatherProvider = fakeProvider;
    const rehome = {
      coverageProxied: vol.cloudCoverage === 0.77,
      densityProxied: vol.cloudDensity === 0.9,
      cloudTypeProxied: coll.cloudType === C.CloudType.STRATUS,
      weatherProviderProxied: vol.weatherProvider === fakeProvider,
    };

    // ── C. enableProcedural flips the collection to VOLUMETRIC + renders a deck ──
    // Move to a low altitude so the volumetric shell (1.5–4 km) is in frame.
    scene.camera.setView({
      destination: C.Cartesian3.fromDegrees(-95.0, 39.0, 16000.0),
    });
    clouds.enableProcedural = true;
    const gateAfterEnable = {
      renderModeVolumetric: coll.renderMode === C.CloudRenderMode.VOLUMETRIC,
      volEnabledTrue: coll.volumetric.enabled === true,
      facadeReadsTrue: clouds.enableProcedural === true,
    };
    await settle(120);
    const deck = capture();

    // Disable again → back to BILLBOARD, deck ceded.
    clouds.enableProcedural = false;
    const gateAfterDisable = {
      renderModeBillboard: coll.renderMode === C.CloudRenderMode.BILLBOARD,
      facadeReadsFalse: clouds.enableProcedural === false,
    };
    await settle(20);
    const offAgain = capture();

    // ── G. COMPOSITE FIDELITY (regression guard for the snapshot-copy gate) ──
    // The facade path (managed collection VOLUMETRIC) and the legacy
    // globe.defaultCloudCollection.enableVolumetric path must composite the cloud deck against the
    // SAME color base — the post-process scene-color snapshot copied each frame in
    // WebGPUSceneRendererPostFrustumChain. That snapshot is a PERSISTENT texture;
    // when the snapshot-copy gate skips a frame it retains STALE contents. If the
    // gate misses the facade path (defaultCloudCollection.renderMode===VOLUMETRIC
    // not OR'd into `_anyEnvEffectEnabled`), the facade deck composites its clouds
    // against a stale snapshot instead of the current view. A same-view diff can't
    // see this (the stale snapshot ≈ the current view), so we deliberately POISON
    // the snapshot from a DIFFERENT camera first: the legacy reference is rendered
    // at view A (which copies the snapshot every frame), then the facade deck is
    // rendered at view B. With the gate correct the snapshot is recopied at view B
    // (facade composite ≈ a legacy composite also at view B). With the gate broken
    // the snapshot is frozen at view A and the facade cloud shading samples the
    // wrong-view color base → the facade/legacy composites at view B diverge. Dials
    // are matched + wind 0 (frozen) so the deck itself is otherwise identical.
    const collVol = scene.globe.defaultCloudCollection.volumetric;
    collVol.cloudCoverage = 0.6;
    collVol.cloudDensity = 0.45;
    collVol.cloudWindSpeed = 0;
    scene.globe.defaultCloudCollection.volumetric.cloudCoverage = 0.6;
    scene.globe.defaultCloudCollection.volumetric.cloudDensity = 0.45;
    scene.globe.defaultCloudCollection.volumetric.cloudWindSpeed = 0;

    const viewA = C.Cartesian3.fromDegrees(-105.0, 44.0, 16000.0);
    const viewB = C.Cartesian3.fromDegrees(-95.0, 39.0, 16000.0);

    function capturePixels() {
      scene.render();
      const canvas = scene.canvas,
        w = canvas.width,
        h = canvas.height;
      const tmp = document.createElement("canvas");
      tmp.width = w;
      tmp.height = h;
      const cx = tmp.getContext("2d");
      cx.drawImage(canvas, 0, 0);
      const data = cx.getImageData(0, 0, w, h).data;
      return { data, url: tmp.toDataURL("image/png") };
    }

    // Poison the persistent snapshot at view A via the legacy path (copies every
    // frame while showProceduralClouds is on).
    clouds.enableProcedural = false;
    scene.globe.defaultCloudCollection.enableVolumetric = true;
    scene.camera.setView({ destination: viewA });
    await settle(120);

    // Facade deck at view B. A correct gate recopies the snapshot at view B; a
    // broken gate leaves it frozen at view A.
    scene.globe.defaultCloudCollection.enableVolumetric = false;
    clouds.enableProcedural = true;
    scene.camera.setView({ destination: viewB });
    await settle(120);
    const facadePix = capturePixels();

    // Legacy reference at the SAME view B (snapshot recopied → always correct).
    clouds.enableProcedural = false;
    scene.globe.defaultCloudCollection.enableVolumetric = true;
    await settle(120);
    const legacyPix = capturePixels();
    scene.globe.defaultCloudCollection.enableVolumetric = false;

    // Whole-frame mismatch: fraction of pixels whose RGB L1 distance > 30.
    let mism = 0;
    const a = legacyPix.data,
      b = facadePix.data,
      npx = a.length / 4;
    for (let i = 0; i < a.length; i += 4) {
      if (
        Math.abs(a[i] - b[i]) +
          Math.abs(a[i + 1] - b[i + 1]) +
          Math.abs(a[i + 2] - b[i + 2]) >
        30
      )
        mism++;
    }
    const fidelity = {
      mismatchPct: (mism / npx) * 100,
      legacyUrl: legacyPix.url,
      facadeUrl: facadePix.url,
    };

    return {
      renderer: scene.context?.rendererType,
      def,
      defaults,
      rehome,
      gateAfterEnable,
      gateAfterDisable,
      deck,
      offAgain,
      fidelity,
    };
  });

  writeFileSync(
    `Tools/visual-regression/out-cloud-u4a-${renderer}-default-${TAG}.png`,
    Buffer.from(result.def.url.split(",")[1], "base64"),
  );
  writeFileSync(
    `Tools/visual-regression/out-cloud-u4a-${renderer}-deck-${TAG}.png`,
    Buffer.from(result.deck.url.split(",")[1], "base64"),
  );
  writeFileSync(
    `Tools/visual-regression/out-cloud-u4a-${renderer}-fidelity-legacy-${TAG}.png`,
    Buffer.from(result.fidelity.legacyUrl.split(",")[1], "base64"),
  );
  writeFileSync(
    `Tools/visual-regression/out-cloud-u4a-${renderer}-fidelity-facade-${TAG}.png`,
    Buffer.from(result.fidelity.facadeUrl.split(",")[1], "base64"),
  );
  delete result.def.url;
  delete result.deck.url;
  delete result.offAgain.url;
  delete result.fidelity.legacyUrl;
  delete result.fidelity.facadeUrl;

  await browser.close();
  return { renderer, errors, ...result };
}

const results = [];
for (const r of ["webgl", "webgpu"]) {
  results.push(await runBackend(r));
}

let ok = true;
for (const res of results) {
  const { def, defaults, rehome, gateAfterEnable, gateAfterDisable, deck, fidelity } =
    res;
  const isGPU = res.renderer === "webgpu";
  const errFiltered = res.errors.filter(
    (e) => !/AtmosphereLUT|default layout/.test(e),
  );

  const checks = {
    defaultRenders: def.bright > 500,
    collectionExists: defaults.exists,
    defaultBillboard: defaults.renderModeBillboard,
    defaultVolDisabled: defaults.volEnabledFalse,
    defaultsMatchGlobe:
      defaults.coverage === 0.5 &&
      defaults.layerBottom === 1500 &&
      defaults.layerTop === 4000 &&
      defaults.density === 0.3 &&
      defaults.windSpeed === 15 &&
      defaults.quality === 64,
    showProcStaysFalse: defaults.showProcDefaultFalse,
    rehomeCoverage: rehome.coverageProxied,
    rehomeDensity: rehome.densityProxied,
    rehomeCloudType: rehome.cloudTypeProxied,
    rehomeWeatherProvider: rehome.weatherProviderProxied,
    enableFlipsVolumetric: gateAfterEnable.renderModeVolumetric,
    enableSetsVolEnabled: gateAfterEnable.volEnabledTrue,
    facadeReadsTrue: gateAfterEnable.facadeReadsTrue,
    disableFlipsBillboard: gateAfterDisable.renderModeBillboard,
    facadeReadsFalse: gateAfterDisable.facadeReadsFalse,
    zeroErrors: errFiltered.length === 0,
  };
  if (isGPU) {
    // WebGPU: the volumetric deck must actually render more cloud pixels.
    checks.deckRenders = deck.cloudish > def.cloudish + 200;
    // WebGPU: facade-path and legacy-path composites must match (same color
    // base). Measured separation: a missed snapshot-copy gate freezes the base at
    // the poison view → ~71% whole-frame mismatch; the correct gate leaves only
    // ~3.8% cloud-wisp render nondeterminism. 15% sits well above the noise floor
    // and far below the regression, so the guard bites cleanly.
    checks.compositeFidelity = fidelity.mismatchPct < 15;
  }

  const failed = Object.entries(checks).filter(([, v]) => !v);
  if (failed.length) ok = false;

  console.log(`\n=== ${res.renderer.toUpperCase()} ===`);
  console.log(
    `  default hash=${def.hash} bright=${def.bright} cloudish=${def.cloudish}`,
  );
  console.log(
    `  deck    hash=${deck.hash} bright=${deck.bright} cloudish=${deck.cloudish}`,
  );
  console.log(
    `  fidelity mismatchPct=${fidelity.mismatchPct.toFixed(3)} (facade vs legacy composite)`,
  );
  console.log(`  defaults: ${JSON.stringify(defaults)}`);
  console.log(`  checks: ${JSON.stringify(checks)}`);
  if (failed.length) console.log(`  FAILED: ${failed.map(([k]) => k).join(", ")}`);
  if (errFiltered.length)
    console.log(`  console errors: ${JSON.stringify(errFiltered.slice(0, 4))}`);
  // Byte-identity anchor for the DEFAULT scene (compare across before/after builds).
  console.log(`DEFAULT_HASH ${TAG} ${res.renderer} default=${def.hash}`);
}

console.log(`\n${ok ? "PASS" : "FAIL"} — CLOUD-U4A-SCENE-DEFAULT-COLLECTION`);
process.exit(ok ? 0 : 1);
