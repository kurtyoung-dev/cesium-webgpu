#!/usr/bin/env node
// Probe (C10-09-VELOCITY-PREV-BUFFER-GPU-COPY, V-1 headline + mutation
// exactness). The TAA motion-vector path in the PointCloud / Gaussian-splat /
// Cloud renderers keeps a CPU mirror of the previous-frame instance buffer.
// For STATIC content (prev array === curr array) the OLD code re-uploaded the
// whole array via queue.writeBuffer EVERY frame TAA is on — even though the
// identical bytes already reside in the current-frame GPU instance buffer.
//
// The fix seeds prevInstanceBuffer ONCE via copyBufferToBuffer(instanceBuffer
// -> prevInstanceBuffer) then SKIPS while the data revision is unchanged.
//
// This probe instruments GPUQueue.writeBuffer and
// GPUCommandEncoder.copyBufferToBuffer (by destination buffer LABEL) and
// measures, over a window of SETTLED frames with TAA enabled:
//   - writeBuffer calls/bytes targeting the "prev" buffers  (PRE: >0/frame,
//     POST: 0/frame after seed)
//   - copyBufferToBuffer calls targeting the "prev" buffers (the seed count)
//
// Legs:
//   cloud       — synthetic CloudCollection (deterministic, no external asset)
//   pointcloud  — static single-frame local PNTS via TimeDynamicPointCloud
//
// Mutation exactness (cloud leg): after settle, edit one cloud's position ->
// exactly ONE re-upload (rebuild + identity re-seed) on the mutation frame,
// then settles back to 0.
//
// Usage: PROBE_BASE=http://localhost:8080 \
//        node Tools/visual-regression/probe-c10-09-prev-buffer-upload.mjs
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const PREV_RE = /prev/i;

function installCounters() {
  // Runs in-page before any app JS. Wraps the two upload entry points so we
  // can attribute uploads to destination buffers by label.
  window.__ul = {
    writes: {},
    copies: {},
    reset() {
      this.writes = {};
      this.copies = {};
    },
    bump(map, label, bytes) {
      const e = map[label] || (map[label] = { calls: 0, bytes: 0 });
      e.calls += 1;
      e.bytes += bytes || 0;
    },
  };
  const wbBytes = (data, dataOffset, size) => {
    const typed = data && data.BYTES_PER_ELEMENT;
    if (size != null) return typed ? size * data.BYTES_PER_ELEMENT : size;
    const bpe = typed ? data.BYTES_PER_ELEMENT : 1;
    const total = typed
      ? data.length
      : data && data.byteLength
        ? data.byteLength
        : 0;
    return (total - (dataOffset || 0)) * bpe;
  };
  const q = GPUQueue.prototype;
  const ow = q.writeBuffer;
  q.writeBuffer = function (buffer, bo, data, dOff, size) {
    try {
      const label = (buffer && buffer.label) || "(unlabeled)";
      window.__ul.bump(window.__ul.writes, label, wbBytes(data, dOff, size));
    } catch (e) {
      /* ignore */
    }
    return ow.apply(this, arguments);
  };
  const enc = GPUCommandEncoder.prototype;
  const oc = enc.copyBufferToBuffer;
  enc.copyBufferToBuffer = function (src, so, dst, dOff, size) {
    try {
      const label = (dst && dst.label) || "(unlabeled)";
      window.__ul.bump(window.__ul.copies, label, size || 0);
    } catch (e) {
      /* ignore */
    }
    return oc.apply(this, arguments);
  };
}

function sumPrev(map) {
  let calls = 0;
  let bytes = 0;
  const labels = {};
  for (const k of Object.keys(map)) {
    if (PREV_RE.test(k)) {
      calls += map[k].calls;
      bytes += map[k].bytes;
      labels[k] = map[k];
    }
  }
  return { calls, bytes, labels };
}

async function runCloudLeg() {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push("PAGEERR:" + e.message));
  await page.addInitScript(installCounters);
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const out = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer,
      scene = v.scene;
    scene.requestRenderMode = false;
    v.useDefaultRenderLoop = false; // drive render() manually — no widget loop
    v.clock.shouldAnimate = false;
    scene.globe.show = false;
    if (scene.skyBox) scene.skyBox.show = false;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    scene.backgroundColor = C.Color.BLACK;
    scene.morphTo3D(0);

    const LON = -75.0,
      LAT = 40.0;
    const clouds = scene.primitives.add(new C.CloudCollection());
    // Match the proven probe-cloud-property-edit setup: 2000x1300 m clouds at a
    // 15 km camera. Tight grid so all are in frustum. 225 * 68 B = 15.3 KB/frame
    // of prev upload under TAA when static.
    const N = 225;
    const items = [];
    for (let i = 0; i < N; i++) {
      const dl = ((i % 15) - 7) * 0.004;
      const dt = (Math.floor(i / 15) - 7) * 0.003;
      items.push(
        clouds.add({
          position: C.Cartesian3.fromDegrees(LON + dl, LAT + dt, 5000.0),
          scale: new C.Cartesian2(2000, 1300),
        }),
      );
    }
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(LON, LAT, 15000.0),
    });

    const onPost = () =>
      new Promise((r) => {
        scene.render();
        requestAnimationFrame(r);
      });

    const cacheOf = () => clouds._webgpuCache;

    // Warmup with TAA OFF (async pipeline resolution + first build).
    scene.taaEnabled = false;
    for (let i = 0; i < 60; i++) await onPost();
    const diag = {
      collectionLength: clouds.length,
      cloudsArrayLength: clouds._clouds ? clouds._clouds.length : "n/a",
      cacheExists: !!cacheOf(),
      cacheKeys: cacheOf() ? Object.keys(cacheOf()).slice(0, 40) : [],
    };
    const builtCount = cacheOf()?.instanceCount ?? -1;

    // TAA ON — let velocity pipeline resolve + seed fire.
    scene.taaEnabled = true;
    for (let i = 0; i < 40; i++) await onPost();

    // ── Measure a SETTLED window (no edits) ──
    window.__ul.reset();
    const WIN = 30;
    for (let i = 0; i < WIN; i++) await onPost();
    const settled = {
      writes: JSON.parse(JSON.stringify(window.__ul.writes)),
      copies: JSON.parse(JSON.stringify(window.__ul.copies)),
    };

    const cache = cacheOf();
    const info = {
      builtCountAfterWarmup: builtCount,
      instanceCount: cache?.instanceCount ?? -1,
      hasPrevBuffer: !!cache?.prevInstanceBuffer,
      instanceDataRevision: cache?.instanceDataRevision,
      prevBufferRevision: cache?.prevBufferRevision,
      isIdentity: cache ? cache.prevInstanceData === cache.instanceData : null,
      prevBufferLabel: cache?.prevInstanceBuffer?.label ?? null,
    };

    // ── Mutation exactness: edit ONE cloud position -> exactly one re-upload ──
    window.__ul.reset();
    items[0].position = C.Cartesian3.fromDegrees(
      LON + 0.05,
      LAT + 0.03,
      5000.0,
    );
    // Frame with the edit (rebuild -> identity re-seed via copyBufferToBuffer).
    await onPost();
    const mutFrame = {
      writes: JSON.parse(JSON.stringify(window.__ul.writes)),
      copies: JSON.parse(JSON.stringify(window.__ul.copies)),
    };
    // Settle frames after the edit — must return to 0.
    window.__ul.reset();
    for (let i = 0; i < 10; i++) await onPost();
    const postMut = {
      writes: JSON.parse(JSON.stringify(window.__ul.writes)),
      copies: JSON.parse(JSON.stringify(window.__ul.copies)),
    };

    // Sanity: clouds visible (non-trivial bright mask) in the settled frame.
    let brightCount = -1;
    await new Promise((resolve) => {
      const rm = scene.postRender.addEventListener(() => {
        rm();
        const cv = scene.canvas;
        const o = document.createElement("canvas");
        o.width = cv.width;
        o.height = cv.height;
        const cx = o.getContext("2d");
        cx.drawImage(cv, 0, 0);
        const d = cx.getImageData(0, 0, cv.width, cv.height).data;
        let cnt = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] + d[i + 1] + d[i + 2] > 90) cnt++;
        }
        brightCount = cnt;
        resolve();
      });
      scene.render();
    });

    return { settled, info, mutFrame, postMut, brightCount, WIN, diag };
  });

  await browser.close();
  return { out, errors };
}

async function runPointCloudLeg() {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push("PAGEERR:" + e.message));
  await page.addInitScript(installCounters);
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const out = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer,
      s = v.scene;
    s.requestRenderMode = false;
    v.useDefaultRenderLoop = false; // drive render() manually — no widget loop
    if (s.skyBox) s.skyBox.show = false;
    if (s.skyAtmosphere) s.skyAtmosphere.show = false;
    if (s.sun) s.sun.show = false;
    s.backgroundColor = C.Color.BLACK;
    s.globe.show = false;
    s.morphTo3D(0);

    const onPost = () =>
      new Promise((r) => {
        s.render();
        requestAnimationFrame(r);
      });

    // TimeDynamicPointCloud drives the WebGPUPointCloudRenderer (the legacy
    // PointCloud class). Animate briefly to LOAD a frame, then FREEZE the clock
    // so geometry is static (prevInstanceData === instanceData => identity).
    const dates = [
      "2018-07-19T15:18:00Z",
      "2018-07-19T15:18:00.5Z",
      "2018-07-19T15:18:01Z",
      "2018-07-19T15:18:01.5Z",
      "2018-07-19T15:18:02Z",
    ];
    const uris = [0, 1, 2, 3, 4].map(
      (i) =>
        `/Apps/SampleData/Cesium3DTiles/PointCloud/PointCloudTimeDynamic/${i}.pnts`,
    );
    const intervals = C.TimeIntervalCollection.fromIso8601DateArray({
      iso8601Dates: dates,
      dataCallback: (interval, index) => ({ uri: uris[index] }),
    });
    const start = C.JulianDate.fromIso8601(dates[0]);
    v.clock.startTime = start;
    v.clock.currentTime = start;
    v.clock.stopTime = C.JulianDate.fromIso8601(dates[dates.length - 1]);
    v.clock.clockRange = C.ClockRange.CLAMPED;
    v.clock.multiplier = 1.0;
    v.clock.shouldAnimate = true;
    const pc = new C.TimeDynamicPointCloud({
      intervals,
      clock: v.clock,
      style: new C.Cesium3DTileStyle({ pointSize: 8 }),
    });
    s.primitives.add(pc);

    // Load frame 0 + focus camera (clock advancing).
    let ready = false;
    for (let i = 0; i < 240; i++) {
      await onPost();
      if (pc.boundingSphere && isFinite(pc.boundingSphere.radius)) {
        if (!ready) {
          v.camera.viewBoundingSphere(
            pc.boundingSphere,
            new C.HeadingPitchRange(0, -0.4, pc.boundingSphere.radius * 3),
          );
          v.camera.lookAtTransform(C.Matrix4.IDENTITY);
        }
        ready = true;
      }
      if (ready && i > 30) break;
    }

    // FREEZE the clock — geometry settles to a single static frame.
    v.clock.shouldAnimate = false;

    // TAA ON, let velocity pipeline resolve + seed on the frozen frame.
    s.taaEnabled = true;
    for (let i = 0; i < 40; i++) await onPost();

    window.__ul.reset();
    const WIN = 30;
    for (let i = 0; i < WIN; i++) await onPost();
    const settled = {
      writes: JSON.parse(JSON.stringify(window.__ul.writes)),
      copies: JSON.parse(JSON.stringify(window.__ul.copies)),
    };

    return {
      ready,
      settled,
      WIN,
      totalMemory: pc.totalMemoryUsageInBytes,
    };
  });

  await browser.close();
  return { out, errors };
}

function report(name, leg) {
  const { out, errors } = leg;
  console.log(`\n===== ${name} leg =====`);
  if (out.ready === false) {
    console.log("  point cloud NEVER loaded (no boundingSphere) — leg SKIPPED");
    return { skipped: true, pass: true };
  }
  const s = sumPrev(out.settled.writes);
  const sc = sumPrev(out.settled.copies);
  const perFrameWrites = (s.calls / out.WIN).toFixed(3);
  const perFrameBytes = (s.bytes / out.WIN).toFixed(0);
  console.log(
    `  settled(${out.WIN}f): prev writeBuffer calls=${s.calls} (${perFrameWrites}/frame), ` +
      `bytes=${s.bytes} (${perFrameBytes}/frame); prev copyBufferToBuffer calls=${sc.calls}`,
  );
  console.log(`    prev write labels: ${JSON.stringify(s.labels)}`);
  console.log(`    prev copy  labels: ${JSON.stringify(sc.labels)}`);
  if (out.info) {
    console.log(`    cache: ${JSON.stringify(out.info)}`);
  }
  if (out.diag) {
    console.log(`    diag: ${JSON.stringify(out.diag)}`);
  }
  if (out.mutFrame) {
    const mw = sumPrev(out.mutFrame.writes);
    const mc = sumPrev(out.mutFrame.copies);
    const pw = sumPrev(out.postMut.writes);
    const pc2 = sumPrev(out.postMut.copies);
    console.log(
      `  mutation frame: prev writes=${mw.calls} copies=${mc.calls} ` +
        `(exactly one re-upload expected: writes+copies == 1)`,
    );
    console.log(
      `  post-mutation settle(10f): prev writes=${pw.calls} copies=${pc2.calls} (expect 0/0)`,
    );
    console.log(`  bright cloud pixels: ${out.brightCount}`);
  }
  if (out.totalMemory != null) {
    console.log(`  totalMemoryUsageInBytes=${out.totalMemory}`);
  }
  if (errors.length) {
    console.log(`  CONSOLE ERRORS (${errors.length}):`);
    errors.slice(0, 8).forEach((e) => console.log("    ERR:", e.slice(0, 240)));
  } else {
    console.log("  0 console errors");
  }
  return {
    skipped: false,
    settledWritesPerFrame: s.calls / out.WIN,
    settledCopies: sc.calls,
    errors: errors.length,
    brightCount: out.brightCount,
    mut: out.mutFrame
      ? {
          frameReuploads:
            sumPrev(out.mutFrame.writes).calls +
            sumPrev(out.mutFrame.copies).calls,
          postWrites: sumPrev(out.postMut.writes).calls,
          postCopies: sumPrev(out.postMut.copies).calls,
        }
      : null,
  };
}

const legName = process.env.LEG || "both";
const results = {};
if (legName === "cloud" || legName === "both") {
  results.cloud = report("CLOUD", await runCloudLeg());
}
if (legName === "pointcloud" || legName === "both") {
  results.pointcloud = report("POINTCLOUD", await runPointCloudLeg());
}

console.log(`\n===== SUMMARY =====`);
console.log(JSON.stringify(results, null, 2));
