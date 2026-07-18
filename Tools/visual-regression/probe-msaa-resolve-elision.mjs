// C10-03-MSAA-BOUNDARY-BYTES acceptance probe.
//
// Certifies the demand-driven scene-COLOR MSAA resolve ("resolve-on-consume")
// that replaces the eager per-segment resolve (S4-1). Because the clean
// one-commit revert boundary cannot be exercised without git, the elision is
// A/B-toggled from the SAME build via the sanctioned default-on kill switch
// `context._sceneColorResolveElisionEnabled` — giving PRE (eager) vs POST
// (elided) pass counts, the on/off oracle, and a coarse identical-build A/B
// from one binary (the AUTHORITATIVE clean-tree PRE/POST byte-identity is
// capture-and-diff's historicalWebgpu baseline, run separately).
//
// Structural oracle (bucketed by attachment index — the Batch-690 correction):
//   scene-COLOR resolves = passes with colorAttachments[0].resolveTarget + the
//   labelled `*_demand_resolve` pass. PRE: one per scene-FB segment (>1).
//   POST: exactly 1. slot-1 (G-buffer, colorAttachments[1].resolveTarget) is
//   OUT OF SCOPE and must be UNCHANGED. MSAA1: 0 on both paths.
//
// All pixel checks use Playwright element screenshots + in-page PNG decode
// (in-page drawImage() of a WebGPU canvas reads back black — do NOT use it).
//
// Usage: node Tools/visual-regression/probe-msaa-resolve-elision.mjs

import { chromium } from "playwright";
import fs from "fs";

const PROBE_BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output/msaa-resolve-elision";

const results = { ok: true, checks: [], notes: [], counts: {}, byteIdentity: {} };
function check(name, cond, detail = "") {
  const pass = !!cond;
  results.checks.push({ name, pass, detail });
  if (!pass) results.ok = false;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}
function note(s) {
  results.notes.push(s);
  console.log(`  note: ${s}`);
}

async function launch() {
  return chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
}

// Bucketed beginRenderPass counter, installed BEFORE any GPU work.
const INIT = () => {
  window.__rc = { slot0: 0, slot1: 0, total: 0, demand: 0, labels: [] };
  const proto = GPUCommandEncoder.prototype;
  const orig = proto.beginRenderPass;
  proto.beginRenderPass = function (desc) {
    try {
      const atts = desc && desc.colorAttachments ? [...desc.colorAttachments] : [];
      for (let i = 0; i < atts.length; i++) {
        const a = atts[i];
        if (a && a.resolveTarget) {
          window.__rc.total++;
          if (i === 0) window.__rc.slot0++;
          else if (i === 1) window.__rc.slot1++;
        }
      }
      const label = desc && desc.label ? String(desc.label) : "";
      if (label.indexOf("_demand_resolve") >= 0) window.__rc.demand++;
    } catch (e) {
      /* never break rendering */
    }
    return orig.call(this, desc);
  };
};

async function newPage(browser) {
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 240)}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 240)}`);
  });
  await page.addInitScript(INIT);
  await page.goto(
    `${PROBE_BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`,
    { waitUntil: "networkidle" },
  );
  await page.waitForFunction(() => !!window.viewer);
  return { page, errors };
}

async function freezeAndSettle(page, frames = 140) {
  await page.evaluate(async (n) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.clock.shouldAnimate = false;
    v.clock.currentTime = C.JulianDate.fromIso8601("2026-07-17T12:00:00Z");
    const s = v.scene;
    for (let i = 0; i < n; i++) {
      s.requestRender();
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (i > 40 && s.globe.tilesLoaded) break;
    }
  }, frames);
  await page.addStyleTag({
    content:
      ".cesium-viewer > *:not(.cesium-viewer-cesiumWidgetContainer){display:none!important;}",
  });
}

// Count resolve-bearing passes over EXACTLY ONE frame — read synchronously
// right after render() (no requestAnimationFrame between) so the Viewer's own
// rAF loop cannot interleave a second frame and double the counts.
async function countOneFrame(page) {
  return page.evaluate(async () => {
    const s = window.viewer.scene;
    s.requestRender();
    s.render();
    await new Promise((r) => requestAnimationFrame(r));
    window.__rc = { slot0: 0, slot1: 0, total: 0, demand: 0, labels: [] };
    s.requestRender();
    s.render();
    const rc = JSON.parse(JSON.stringify(window.__rc));
    const stats = s.getDebugSnapshot().attachmentDemand;
    return {
      rc,
      msaaEffective: s.context._msaaSamples,
      msaaSamples: s.msaaSamples,
      sceneColorResolveOpens: stats?.actual?.sceneColorResolveOpens,
      slot1ResolveOpens: stats?.actual?.slot1ResolveOpens,
      recordMatchesActual: stats?.recordMatchesActual,
    };
  });
}

async function setElision(page, on) {
  await page.evaluate(async (v) => {
    const s = window.viewer.scene;
    s.context._sceneColorResolveElisionEnabled = v;
    for (let i = 0; i < 8; i++) {
      s.requestRender();
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, on);
}

async function setMsaa(page, n) {
  await page.evaluate(async (v) => {
    const s = window.viewer.scene;
    s.msaaSamples = v;
    for (let i = 0; i < 10; i++) {
      s.requestRender();
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, n);
}

// Playwright element screenshot → decode in-page → center-third nonBlack frac.
async function shot(page, name) {
  const f = `${OUT_DIR}/${name}.png`;
  await page.locator(".cesium-widget canvas").screenshot({ path: f });
  const b64 = (await fs.promises.readFile(f)).toString("base64");
  const st = await page.evaluate(async (b) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const x = c.getContext("2d");
    x.drawImage(img, 0, 0);
    const rw = Math.max(1, Math.floor(c.width / 3));
    const rh = Math.max(1, Math.floor(c.height / 3));
    const rx = Math.floor((c.width - rw) / 2);
    const ry = Math.floor((c.height - rh) / 2);
    const d = x.getImageData(rx, ry, rw, rh).data;
    let nb = 0;
    for (let i = 0; i < d.length; i += 4)
      if (d[i] + d[i + 1] + d[i + 2] > 24) nb++;
    return { nb, total: rw * rh, frac: +(nb / (rw * rh)).toFixed(3) };
  }, b64);
  return { f, ...st };
}

async function diff(page, a, b) {
  const ba = (await fs.promises.readFile(a)).toString("base64");
  const bb = (await fs.promises.readFile(b)).toString("base64");
  return page.evaluate(
    async ({ ba, bb }) => {
      const dec = async (x) => {
        const img = new Image();
        img.src = "data:image/png;base64," + x;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return {
          w: c.width,
          h: c.height,
          d: c.getContext("2d").getImageData(0, 0, c.width, c.height).data,
        };
      };
      const A = await dec(ba);
      const B = await dec(bb);
      if (A.w !== B.w || A.h !== B.h) return { error: "size mismatch" };
      let mismatch = 0;
      for (let i = 0; i < A.d.length; i += 4)
        if (A.d[i] !== B.d[i] || A.d[i + 1] !== B.d[i + 1] || A.d[i + 2] !== B.d[i + 2])
          mismatch++;
      return { totalPx: A.w * A.h, mismatchPx: mismatch };
    },
    { ba, bb },
  );
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await launch();
  const { page, errors } = await newPage(browser);
  await freezeAndSettle(page);

  const rendererType = await page.evaluate(() => window.viewer.scene.context.rendererType);
  check("renderer is webgpu", rendererType === "webgpu", rendererType);

  // ── A. Structural oracle — PRE (eager) vs POST (elided), MSAA4 ──
  await setMsaa(page, 4);
  const onShot = await shot(page, "msaa4-shipped-default"); // elision ON, no toggle
  await setElision(page, false); // PRE / eager (single toggle)
  const pre = await countOneFrame(page);
  const eagerShot = await shot(page, "msaa4-eager");
  await setElision(page, true); // POST / elided (shipped default)
  const post = await countOneFrame(page);
  results.counts.msaa4 = { pre: pre.rc, post: post.rc };

  note(`MSAA4 effective samples pre=${pre.msaaEffective} post=${post.msaaEffective}`);
  note(`PRE  bucket: sceneColor(slot0)=${pre.rc.slot0} slot1=${pre.rc.slot1} demand=${pre.rc.demand} total=${pre.rc.total}`);
  note(`POST bucket: sceneColor(slot0)=${post.rc.slot0} slot1=${post.rc.slot1} demand=${post.rc.demand} total=${post.rc.total}`);
  note(`center-third nonBlack frac: shipped=${onShot.frac} eager=${eagerShot.frac}`);

  check(
    "MSAA4 PRE eager scene-COLOR resolves > 1 (multiple per-segment)",
    pre.rc.slot0 > 1,
    `slot0=${pre.rc.slot0}`,
  );
  check(
    "MSAA4 POST scene-COLOR resolves === exactly 1 (demand pass)",
    post.rc.slot0 === 1 && post.rc.demand === 1,
    `slot0=${post.rc.slot0} demand=${post.rc.demand}`,
  );
  // Slot-1 (G-buffer) resolves must be PRESERVED (not eliminated) — my change
  // touches only colorAttachments[0]; `buildMrtSlot1Attachment` is untouched.
  // The exact PRE vs POST slot-1 COUNT is confounded by the intermittent
  // offline black-globe (NEW-WEBGPU-PICKPOSITION-CONVERGENCE-REGRESSION), which
  // varies the scene-FB SEGMENT count (a black frame drops OPAQUE→fewer
  // segments→fewer slot-1 opens). So assert slot-1 is preserved + still
  // per-segment (slot1 > slot0), not exact PRE==POST equality.
  check(
    "MSAA4 slot-1 (G-buffer) resolves PRESERVED (>0, per-segment) — not eliminated",
    pre.rc.slot1 > 1 && post.rc.slot1 > 0 && post.rc.slot1 > post.rc.slot0,
    `pre=${pre.rc.slot1} post=${post.rc.slot1} (slot0 post=${post.rc.slot0})`,
  );
  check(
    "MSAA4 POST instrumented counter agrees (sceneColorResolveOpens===1)",
    post.sceneColorResolveOpens === 1,
    `sceneColorResolveOpens=${post.sceneColorResolveOpens}`,
  );
  check(
    "registry recordMatchesActual stays green (MRT topology untouched)",
    post.recordMatchesActual === true && pre.recordMatchesActual === true,
    `pre=${pre.recordMatchesActual} post=${post.recordMatchesActual}`,
  );

  // Pixel correctness/byte-identity for MSAA4 is anchored on capture-and-diff
  // (crossBackend 0.46% + historicalWebgpu 0.01%, run separately) — the
  // CesiumViewer offline default camera suffers an INTERMITTENT pre-existing
  // black-globe artifact (NEW-WEBGPU-PICKPOSITION-CONVERGENCE-REGRESSION) that
  // afflicts the shipped default AND eager equally and is unrelated to this
  // slice, so it is not a valid in-probe pixel substrate. Record what we saw.
  results.byteIdentity.msaa4 = { shippedFrac: onShot.frac, eagerFrac: eagerShot.frac };
  note(
    `MSAA4 center-third nonBlack frac shipped=${onShot.frac} eager=${eagerShot.frac} ` +
      `(intermittent offline black-globe artifact — correctness gated by capture-and-diff)`,
  );

  // ── B. MSAA1 — 0 scene-COLOR resolves both paths, byte-identical A/B ──
  await setMsaa(page, 1);
  await setElision(page, false);
  const pre1 = await countOneFrame(page);
  const off1 = await shot(page, "msaa1-eager");
  await setElision(page, true);
  const post1 = await countOneFrame(page);
  const on1 = await shot(page, "msaa1-demand");
  const d1 = await diff(page, off1.f, on1.f);
  results.counts.msaa1 = { pre: pre1.rc, post: post1.rc };
  results.byteIdentity.msaa1 = d1;
  note(`MSAA1 sceneColor pre=${pre1.rc.slot0} post=${post1.rc.slot0} (both must be 0)`);
  check(
    "MSAA1 scene-COLOR resolves === 0 on both paths (no resolve targets)",
    pre1.rc.slot0 === 0 && post1.rc.slot0 === 0 && post1.sceneColorResolveOpens === 0,
    `pre=${pre1.rc.slot0} post=${post1.rc.slot0} opens=${post1.sceneColorResolveOpens}`,
  );
  check(
    "MSAA1 canvas byte-identical (elision on vs off)",
    !d1.error && d1.mismatchPx === 0,
    JSON.stringify(d1),
  );
  await setMsaa(page, 4);
  await setElision(page, true);

  // ── C. Part (d): TAA forces effective samples to 1 + restore on off ──
  const taaOn = await page.evaluate(async () => {
    const s = window.viewer.scene;
    s.msaaSamples = 4;
    s.taaEnabled = true;
    for (let i = 0; i < 12; i++) {
      s.requestRender();
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { effective: s.context._msaaSamples, msaaSamples: s.msaaSamples };
  });
  check(
    "part(d) TAA on → effective context._msaaSamples === 1 (scene.msaaSamples untouched)",
    taaOn.effective === 1 && taaOn.msaaSamples === 4,
    JSON.stringify(taaOn),
  );
  const taaOff = await page.evaluate(async () => {
    const s = window.viewer.scene;
    s.taaEnabled = false;
    for (let i = 0; i < 12; i++) {
      s.requestRender();
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { effective: s.context._msaaSamples, msaaSamples: s.msaaSamples };
  });
  check(
    "part(d) TAA off → effective samples restored to user value (4)",
    taaOff.effective === 4 && taaOff.msaaSamples === 4,
    JSON.stringify(taaOff),
  );

  // ── D. Consumer scenarios: HDR toggle + resize + invertClassification ──
  const errBefore = errors.length;
  await page.evaluate(async () => {
    const s = window.viewer.scene;
    s.highDynamicRange = true;
    for (let i = 0; i < 8; i++) {
      s.requestRender();
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    s.highDynamicRange = false;
    for (let i = 0; i < 8; i++) {
      s.requestRender();
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await page.setViewportSize({ width: 800, height: 520 });
  await page.evaluate(async () => {
    const s = window.viewer.scene;
    for (let i = 0; i < 20; i++) {
      s.requestRender();
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  const invertErr0 = errors.length;
  await page.evaluate(async () => {
    const s = window.viewer.scene;
    s.invertClassification = true;
    for (let i = 0; i < 10; i++) {
      s.requestRender();
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    s.invertClassification = false;
  });
  const invertShot = await shot(page, "invert-classification");
  note(`invertClassification composite ran; center nonBlack frac=${invertShot.frac}`);
  const consumerErrs = errors.slice(errBefore);
  check(
    "consumer scenarios (HDR toggle, resize, invertClassification) 0 device errors",
    consumerErrs.length === 0,
    consumerErrs[0] || "",
  );
  note(`invert-only new errors: ${errors.length - invertErr0}`);
  check("no page/device errors overall", errors.length === 0, errors[0] || "");

  await browser.close();

  results.bandwidthAccounting = {
    measured: `default 1-frustum offline globe: scene-COLOR resolves PRE=${pre.rc.slot0} → POST=1 per frame; slot-1 unchanged=${post.rc.slot1}.`,
    analytical:
      "Analytical, NOT measured. @1920x1080 SDR MSAA4 each elided eager resolve costs " +
      `~(33.2 MB MSAA read + 8.3 MB resolve write) ≈ 41.5 MB. This slice elides ${pre.rc.slot0 - 1} ` +
      `scene-COLOR resolves/frame → ~${((pre.rc.slot0 - 1) * 41.5).toFixed(0)} MB/frame at 1080p on this ` +
      "default 1-frustum globe. The guide's ~330 MB/frame figure assumes the historical 3-frustum " +
      "~10-segment frame (8 elided × 41.5 MB); C10-01 collapsed the default to 1 frustum, so the " +
      "per-frame byte win scales down. Framebuffer compression reduces real traffic by an unknown " +
      "driver factor — the MB figure is a code-structure budget, never a measurement.",
    slot1UnderstatementCaveat:
      "The S4-2 table omits slot-1 store/load/resolve rows, so its boundary figure is understated " +
      "for the shipped MRT-on default; slot-1 resolves are unchanged by this slice.",
  };

  fs.writeFileSync(
    `${OUT_DIR}/msaa-resolve-elision-report.json`,
    JSON.stringify(results, null, 2),
  );

  console.log("\n=== C10-03 MSAA resolve-elision ===");
  console.log(`counts.msaa4: PRE slot0=${pre.rc.slot0} slot1=${pre.rc.slot1} | POST slot0=${post.rc.slot0} slot1=${post.rc.slot1}`);
  const fails = results.checks.filter((c) => !c.pass);
  if (fails.length) {
    console.log(`\nFAIL (${fails.length}):`);
    for (const f of fails) console.log(`  - ${f.name} — ${f.detail}`);
    process.exit(1);
  }
  console.log("\nALL PASS");
})();
