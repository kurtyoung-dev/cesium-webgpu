#!/usr/bin/env node
// probe-csm-globe-receive-trace — NEW-CSM-GLOBE-RECEIVE-PROJECTION-MISS trace.
// @purpose Diagnostics-only trace of why globe-terrain CSM receive missed: projects a shadowed point via globe vs cast reconstructions.
// @status INVESTIGATION
//
// Localizes WHY the globe-terrain CSM receiver fails to darken under a
// caster's shadow while the appearance-primitive receiver self-shadows fine.
//
// Method (per the stage TRACE-THEN-FIX directive): pick a known ground point
// that sits UNDER the wall's cast shadow, then project that world point into
// each cascade TWO ways and compare against the cast pass's STORED depth:
//
//   (1) GLOBE reconstruction — eyePos = worldPos - (encodedCameraPositionMC
//       high+low), exactly what GlobeTerrain.wgsl feeds v_positionRTE.
//   (2) CAST reconstruction — eyePos = worldPos - EncodedCartesian3.from(
//       camera.positionWC) high+low, exactly what WebGPUCSMCastPass packs and
//       the cast shader subtracts.
//
// Both are multiplied by cascade.viewProjectionRTE → (uv, ndc.z). We then read
// the stored cast depth at each uv. If the two uvs differ → XY (spatial)
// misalignment. If the uvs match but globe ndc.z is far from the stored depth
// → Z/depth-space mismatch. If globe eyePos != cast eyePos in world units →
// camera-encoding divergence is the root cause.
//
// Output is pure diagnostics (no pass/fail gate) — it tells the fix where to
// aim. Run AFTER a build that includes the debugCascadeMatrices /
// debugReadCascadeDepth hooks on WebGPUCSMRenderer.

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const VIEW = { lon: -79.9959, lat: 40.4406 };
const FIXED_CLOCK_UTC = "2026-06-15T21:10:00Z";

(async () => {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--disable-cache",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const out = await page.evaluate(
    async ({ view, clockUTC }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const fixed = C.JulianDate.fromIso8601(clockUTC);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;

      v.terrainProvider = new C.EllipsoidTerrainProvider();
      v.imageryLayers.removeAll();
      v.scene.globe.baseColor = new C.Color(0.82, 0.8, 0.74, 1.0);
      v.scene.skyAtmosphere.show = false;
      v.scene.fog.enabled = false;
      v.scene.globe.showGroundAtmosphere = false;
      v.scene.globe.enableLighting = false;
      v.shadows = true;
      v.scene.shadowMap.enabled = true;
      v.scene.shadowMap.softShadows = false;
      v.scene.shadowMap.darkness = 0.3;
      v.scene.shadowMap.maximumDistance = 10000;
      v.scene.shadowMap.size = 2048;
      v.scene.useCascadedShadowMaps = true;
      v.scene.cascadedShadowMapSoftShadows = false;
      v.scene.cascadedShadowMapResolution = 1024;

      const wallCoords = C.Cartesian3.fromDegreesArray([
        view.lon - 0.0004,
        view.lat - 0.003,
        view.lon + 0.0004,
        view.lat - 0.003,
        view.lon + 0.0004,
        view.lat + 0.003,
        view.lon - 0.0004,
        view.lat + 0.003,
      ]);
      const wall = new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.PolygonGeometry({
            polygonHierarchy: new C.PolygonHierarchy(wallCoords),
            height: 0,
            extrudedHeight: 120,
            vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: {
            color: C.ColorGeometryInstanceAttribute.fromColor(
              new C.Color(0.6, 0.6, 0.62, 1.0),
            ),
          },
        }),
        appearance: new C.PerInstanceColorAppearance({
          translucent: false,
          flat: false,
        }),
        asynchronous: false,
        shadows: C.ShadowMode.ENABLED,
      });
      v.scene.primitives.add(wall);

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(
          view.lon + 0.0012,
          view.lat + 0.0012,
          1700.0,
        ),
        orientation: { heading: 0, pitch: C.Math.toRadians(-90), roll: 0 },
      });

      for (let i = 0; i < 1200; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 200) break;
      }
      for (let i = 0; i < 60; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      const csm = v.scene.context?.csmRenderer;
      if (!csm) return { error: "no csmRenderer" };
      const us = v.scene.context?.uniformState;

      // ── known ground points ──
      // P_shadow: on the ground a bit NE of the wall, where the SW sun throws
      // the wall's shadow (should be OCCLUDED → stored cast depth < ground
      // depth).  P_lit: well NE, clear of the shadow (should be LIT).
      // Sun is SW (sunDir ≈ (-0.675,-0.622,+0.396)) → shadow thrown to the NE.
      // Sample a sweep of GROUND points marching NE away from the wall's NE
      // edge (lon+0.0004, lat+0.0030). Points just past the edge are in the
      // wall's umbra; points far NE are lit. For each, the nearest occluder
      // along the light ray is the WALL, so stored depth should be << ground
      // ndcZ (ground is farther from the light than the wall it hides behind).
      const groundPoints = {
        umbra_near: C.Cartesian3.fromDegrees(
          view.lon + 0.0006,
          view.lat + 0.0034,
          0,
        ),
        umbra_mid: C.Cartesian3.fromDegrees(
          view.lon + 0.001,
          view.lat + 0.004,
          0,
        ),
        umbra_far: C.Cartesian3.fromDegrees(
          view.lon + 0.0014,
          view.lat + 0.0046,
          0,
        ),
        lit: C.Cartesian3.fromDegrees(view.lon + 0.004, view.lat + 0.008, 0),
        wallTop: C.Cartesian3.fromDegrees(view.lon, view.lat, 120),
      };

      // Camera-encoding compare. The globe receiver subtracts the MC-encoded
      // camera (us.encodedCameraPositionMCHigh/Low). The cast pass subtracts
      // EncodedCartesian3.fromCartesian(camera.positionWC). Capture both.
      const mcHigh = us.encodedCameraPositionMCHigh;
      const mcLow = us.encodedCameraPositionMCLow;
      const camWC = v.scene.frameState.camera.positionWC;
      const enc = new C.EncodedCartesian3();
      C.EncodedCartesian3.fromCartesian(camWC, enc);

      const globeCamSum = new C.Cartesian3(
        mcHigh.x + mcLow.x,
        mcHigh.y + mcLow.y,
        mcHigh.z + mcLow.z,
      );
      const castCamSum = new C.Cartesian3(
        enc.high.x + enc.low.x,
        enc.high.y + enc.low.y,
        enc.high.z + enc.low.z,
      );

      const mats = csm.debugCascadeMatrices();

      // Layer-content sanity: is there ANY non-cleared depth in each cascade?
      const layerScans = [];
      for (let ci = 0; ci < mats.length; ci++) {
        layerScans.push({
          cascade: ci,
          ...(await csm.debugScanCascadeLayer(ci)),
        });
      }

      // column-major mat4 * vec4
      const mulMat4Vec4 = (m, x, y, z, w) => ({
        x: m[0] * x + m[4] * y + m[8] * z + m[12] * w,
        y: m[1] * x + m[5] * y + m[9] * z + m[13] * w,
        z: m[2] * x + m[6] * y + m[10] * z + m[14] * w,
        w: m[3] * x + m[7] * y + m[11] * z + m[15] * w,
      });

      const projectThrough = (vpRTE, eye) => {
        const clip = mulMat4Vec4(vpRTE, eye.x, eye.y, eye.z, 1.0);
        if (clip.w === 0) return null;
        const ndc = {
          x: clip.x / clip.w,
          y: clip.y / clip.w,
          z: clip.z / clip.w,
        };
        const uv = { x: ndc.x * 0.5 + 0.5, y: 1.0 - (ndc.y * 0.5 + 0.5) };
        return { ndc, uv, w: clip.w };
      };

      // Project the wall's 8 ECEF corners (4 base + 4 top) into cascade 0 to
      // get its actual stored footprint, then sweep a 31×31 grid of GROUND
      // points (height 0) over a region NE of the wall and report which of
      // them project INTO the wall's uv footprint AND are correctly occluded
      // (ground ndcZ > wall stored at that uv). That tells us, independent of
      // hand-picked points, whether cross-object alignment works at all.
      const wallCornersWC = [
        ...C.Cartesian3.fromDegreesArrayHeights([
          view.lon - 0.0004,
          view.lat - 0.003,
          0,
          view.lon + 0.0004,
          view.lat - 0.003,
          0,
          view.lon + 0.0004,
          view.lat + 0.003,
          0,
          view.lon - 0.0004,
          view.lat + 0.003,
          0,
          view.lon - 0.0004,
          view.lat - 0.003,
          120,
          view.lon + 0.0004,
          view.lat - 0.003,
          120,
          view.lon + 0.0004,
          view.lat + 0.003,
          120,
          view.lon - 0.0004,
          view.lat + 0.003,
          120,
        ]),
      ];
      const globeCamSumC = globeCamSum;
      const projC0 = (wp) => {
        const eye = C.Cartesian3.subtract(wp, globeCamSumC, new C.Cartesian3());
        return projectThrough(mats[0].viewProjectionRTE, eye);
      };
      let wuMin = 1,
        wuMax = 0,
        wvMin = 1,
        wvMax = 0;
      for (const c of wallCornersWC) {
        const p = projC0(c);
        if (!p) continue;
        wuMin = Math.min(wuMin, p.uv.x);
        wuMax = Math.max(wuMax, p.uv.x);
        wvMin = Math.min(wvMin, p.uv.y);
        wvMax = Math.max(wvMax, p.uv.y);
      }
      const wallFootprint = {
        uMin: Number(wuMin.toFixed(4)),
        uMax: Number(wuMax.toFixed(4)),
        vMin: Number(wvMin.toFixed(4)),
        vMax: Number(wvMax.toFixed(4)),
      };

      // Sweep ground grid; count points landing in the wall footprint and
      // whether they read an occluding (stored < ndcZ) texel there.
      let inFootprint = 0,
        occludedInFootprint = 0,
        sweepTotal = 0;
      const sampleHits = [];
      for (let gi = 0; gi <= 30; gi++) {
        for (let gj = 0; gj <= 30; gj++) {
          const lon = view.lon - 0.001 + (gi / 30) * 0.004;
          const lat = view.lat - 0.001 + (gj / 30) * 0.006;
          const wp = C.Cartesian3.fromDegrees(lon, lat, 0);
          const p = projC0(wp);
          sweepTotal++;
          if (!p || p.uv.x < 0 || p.uv.x > 1 || p.uv.y < 0 || p.uv.y > 1)
            continue;
          const inFp =
            p.uv.x >= wuMin &&
            p.uv.x <= wuMax &&
            p.uv.y >= wvMin &&
            p.uv.y <= wvMax;
          if (inFp) {
            inFootprint++;
            const stored = await csm.debugReadCascadeDepth(0, p.uv.x, p.uv.y);
            const occ = stored !== null && p.ndc.z > stored + 1e-5;
            if (occ) occludedInFootprint++;
            if (sampleHits.length < 6) {
              sampleHits.push({
                lonOff: Number(((lon - view.lon) * 1e4).toFixed(2)),
                latOff: Number(((lat - view.lat) * 1e4).toFixed(2)),
                uv: [Number(p.uv.x.toFixed(4)), Number(p.uv.y.toFixed(4))],
                ndcZ: Number(p.ndc.z.toFixed(5)),
                stored: stored === null ? null : Number(stored.toFixed(5)),
                occluded: occ,
              });
            }
          }
        }
      }

      const results = {
        _wallFootprintC0: wallFootprint,
        _sweep: {
          total: sweepTotal,
          inFootprint,
          occludedInFootprint,
          sampleHits,
        },
      };
      for (const [name, wp] of Object.entries(groundPoints)) {
        const globeEye = C.Cartesian3.subtract(
          wp,
          globeCamSum,
          new C.Cartesian3(),
        );
        const castEye = C.Cartesian3.subtract(
          wp,
          castCamSum,
          new C.Cartesian3(),
        );
        const eyeDelta = C.Cartesian3.magnitude(
          C.Cartesian3.subtract(globeEye, castEye, new C.Cartesian3()),
        );

        const perCascade = [];
        for (let ci = 0; ci < mats.length; ci++) {
          const g = projectThrough(mats[ci].viewProjectionRTE, globeEye);
          const k = projectThrough(mats[ci].viewProjectionRTE, castEye);
          let storedGlobe = null;
          let storedCast = null;
          if (g && g.uv.x >= 0 && g.uv.x <= 1 && g.uv.y >= 0 && g.uv.y <= 1) {
            storedGlobe = await csm.debugReadCascadeDepth(ci, g.uv.x, g.uv.y);
          }
          if (k && k.uv.x >= 0 && k.uv.x <= 1 && k.uv.y >= 0 && k.uv.y <= 1) {
            storedCast = await csm.debugReadCascadeDepth(ci, k.uv.x, k.uv.y);
          }
          perCascade.push({
            cascade: ci,
            splitFar: mats[ci].splitFar,
            sphereRadius: mats[ci].sphereRadius,
            globe: g
              ? {
                  uv: [Number(g.uv.x.toFixed(5)), Number(g.uv.y.toFixed(5))],
                  ndcZ: Number(g.ndc.z.toFixed(6)),
                  stored:
                    storedGlobe === null
                      ? null
                      : Number(storedGlobe.toFixed(6)),
                  occluded:
                    storedGlobe !== null && g.ndc.z > storedGlobe + 1e-5,
                }
              : null,
            cast: k
              ? {
                  uv: [Number(k.uv.x.toFixed(5)), Number(k.uv.y.toFixed(5))],
                  ndcZ: Number(k.ndc.z.toFixed(6)),
                  stored:
                    storedCast === null ? null : Number(storedCast.toFixed(6)),
                  occluded: storedCast !== null && k.ndc.z > storedCast + 1e-5,
                }
              : null,
            uvDelta:
              g && k
                ? Number(
                    Math.hypot(g.uv.x - k.uv.x, g.uv.y - k.uv.y).toFixed(6),
                  )
                : null,
            ndcZDelta: g && k ? Number((g.ndc.z - k.ndc.z).toFixed(6)) : null,
          });
        }
        results[name] = {
          worldPos: [wp.x, wp.y, wp.z],
          eyeDeltaMeters: Number(eyeDelta.toFixed(6)),
          perCascade,
        };
      }

      return {
        camEncoding: {
          globeCamSum: [globeCamSum.x, globeCamSum.y, globeCamSum.z],
          castCamSum: [castCamSum.x, castCamSum.y, castCamSum.z],
          camWC: [camWC.x, camWC.y, camWC.z],
          globeVsCastMeters: Number(
            C.Cartesian3.magnitude(
              C.Cartesian3.subtract(
                globeCamSum,
                castCamSum,
                new C.Cartesian3(),
              ),
            ).toFixed(6),
          ),
          globeVsTrueMeters: Number(
            C.Cartesian3.magnitude(
              C.Cartesian3.subtract(globeCamSum, camWC, new C.Cartesian3()),
            ).toFixed(6),
          ),
        },
        sunDirectionWC: us.sunDirectionWC
          ? [us.sunDirectionWC.x, us.sunDirectionWC.y, us.sunDirectionWC.z]
          : null,
        cascadeSphereCenters: mats.map((m) => m.sphereCenter),
        castDispatches: csm.getStatistics().castDispatches,
        layerScans,
        results,
      };
    },
    { view: VIEW, clockUTC: FIXED_CLOCK_UTC },
  );

  await browser.close();

  console.log("[probe-csm-globe-receive-trace]\n");
  console.log(JSON.stringify(out, null, 2));
  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  if (errs.length) {
    console.log(`\n${errs.length} console errors:`);
    errs.slice(0, 6).forEach((e) => console.log("  " + e.text?.slice(0, 200)));
  }
})();
