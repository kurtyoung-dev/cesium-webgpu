import {
  WebGPUCSMRenderer,
  computeFrustumCornersWorldSpace,
  fitBoundingSphere,
  computeCascadeVPMatrix,
  applyCameraTranslationToVP,
  computeCastClipPosition,
  snapToTexelGrid,
} from "../../../Source/Renderer/WebGPU/WebGPUCSMRenderer.js";
import {
  filterCSMCastCommandsConservatively,
  prepareCSMTerrainGlobals,
} from "../../../Source/Renderer/WebGPU/WebGPUCSMCastPass.js";

function makeClearOnlyEncoder() {
  const passDescriptors = [];
  const passes = [];
  return {
    passDescriptors,
    passes,
    beginRenderPass: function (descriptor) {
      passDescriptors.push(descriptor);
      const pass = {
        ended: false,
        end: function () {
          this.ended = true;
        },
      };
      passes.push(pass);
      return pass;
    },
  };
}

// Pure-CPU specs for the CSM math helpers. No GPU device required —
// these verify the math that `WebGPUCSMRenderer.computeCascadeVPs`
// invokes, isolated from the GPU resource allocation path.

describe("Renderer/WebGPU/WebGPUCSMRenderer", function () {
  describe("terrain shadow globals", function () {
    it("stamps the shared globals on quantized and uncompressed terrain", function () {
      const writeBuffer = jasmine.createSpy("writeBuffer");
      const rawTerrainBuffer = {};
      const terrainGlobals = {
        isDestroyed: false,
        buffer: rawTerrainBuffer,
      };
      const host = {
        _device: { queue: { writeBuffer: writeBuffer } },
        _terrainGlobalsUB: terrainGlobals,
        _terrainGlobalsData: new Float32Array(4),
      };
      const quantized = { _shadowCastLayout: "quantized12" };
      const uncompressed = { _shadowCastLayout: "terrainUncompressed" };
      const model = { _shadowCastLayout: "modelP12" };

      expect(
        prepareCSMTerrainGlobals(host, [quantized, uncompressed, model], {
          mode: 3,
          verticalExaggeration: 2.5,
          verticalExaggerationRelativeHeight: 125.0,
        }),
      ).toBe(true);

      expect(quantized._shadowCastTerrainGlobalsUB).toBe(terrainGlobals);
      expect(uncompressed._shadowCastTerrainGlobalsUB).toBe(terrainGlobals);
      expect(model._shadowCastTerrainGlobalsUB).toBeUndefined();
      expect(Array.from(host._terrainGlobalsData)).toEqual([
        2.5, 125.0, 3.0, 0.0,
      ]);
      expect(writeBuffer).toHaveBeenCalledOnceWith(
        rawTerrainBuffer,
        0,
        host._terrainGlobalsData.buffer,
        host._terrainGlobalsData.byteOffset,
        host._terrainGlobalsData.byteLength,
      );
    });
  });

  describe("stale cascade cull readback", function () {
    const cascade = {
      sphereCenter: new Float32Array([0.0, 0.0, 0.0]),
      sphereRadius: 10.0,
    };

    function command(x, y, z, radius) {
      return {
        boundingVolume: {
          center: { x: x, y: y, z: z },
          radius: radius,
        },
      };
    }

    it("does not let reordered stale flags suppress a current in-cascade caster", function () {
      const inside = command(0.0, 0.0, 0.0, 1.0);
      const outside = command(100.0, 0.0, 0.0, 1.0);
      const filtered = [];

      // This zero belonged to a different, outside command last frame. After
      // reordering it now indexes the inside caster and therefore must be
      // rejected by the current-sphere/current-cascade validation.
      filterCSMCastCommandsConservatively(
        [inside, outside],
        new Uint32Array([0, 1]),
        cascade,
        filtered,
      );
      expect(filtered).toEqual([inside, outside]);

      // A zero may still remove a command that is definitely outside NOW.
      filterCSMCastCommandsConservatively(
        [inside, outside],
        new Uint32Array([1, 0]),
        cascade,
        filtered,
      );
      expect(filtered).toEqual([inside]);
    });

    it("passes through invalid, non-f32, and non-positive spheres", function () {
      const invalid = [
        command(Number.NaN, 0.0, 0.0, 1.0),
        command(Number.MAX_VALUE, 0.0, 0.0, 1.0),
        command(100.0, 0.0, 0.0, 0.0),
        command(100.0, 0.0, 0.0, Number.MIN_VALUE),
        {},
      ];
      const filtered = [];

      filterCSMCastCommandsConservatively(
        invalid,
        new Uint32Array(invalid.length),
        cascade,
        filtered,
      );
      expect(filtered).toEqual(invalid);
    });
  });

  describe("resource cleanup", function () {
    it("destroys every raw cascade cast buffer and the terrain globals", function () {
      const renderer = new WebGPUCSMRenderer({ cascadeCount: 2 });
      const firstDestroy = jasmine.createSpy("firstDestroy");
      const secondDestroy = jasmine.createSpy("secondDestroy");
      const terrainDestroy = jasmine.createSpy("terrainDestroy");
      renderer["_cascadeCastBuffers"] = [
        { destroy: firstDestroy },
        { destroy: secondDestroy },
      ];
      renderer["_terrainGlobalsUB"] = {
        destroy: terrainDestroy,
      };

      renderer.destroy();

      expect(firstDestroy).toHaveBeenCalledTimes(1);
      expect(secondDestroy).toHaveBeenCalledTimes(1);
      expect(terrainDestroy).toHaveBeenCalledTimes(1);
      expect(renderer["_cascadeCastBuffers"]).toBeNull();
      expect(renderer["_terrainGlobalsUB"]).toBeNull();
    });
  });

  describe("empty caster transitions", function () {
    it("clears every cascade once and leaves settled empty frames pass-free", function () {
      const renderer = new WebGPUCSMRenderer({
        cascadeCount: 4,
        enabled: true,
      });
      const cascadeViews = [
        { label: "cascade-0" },
        { label: "cascade-1" },
        { label: "cascade-2" },
        { label: "cascade-3" },
      ];
      renderer["_device"] = {};
      renderer["_cascadeTexture"] = {};
      renderer["_cascadeViews"] = cascadeViews;
      renderer["_shadowContentState"] = "casters";
      const encoder = makeClearOnlyEncoder();

      renderer.renderCastPass(encoder, [], { x: 6378137.0, y: 0.0, z: 0.0 });

      expect(encoder.passDescriptors.length).toBe(4);
      expect(
        encoder.passDescriptors.map(
          (descriptor) => descriptor.depthStencilAttachment.view,
        ),
      ).toEqual(cascadeViews);
      expect(
        encoder.passDescriptors.every(
          (descriptor) =>
            descriptor.depthStencilAttachment.depthLoadOp === "clear",
        ),
      ).toBe(true);
      expect(encoder.passes.every((pass) => pass.ended)).toBe(true);
      expect(renderer["_shadowContentState"]).toBe("empty");
      expect(renderer["_castDispatches"]).toBe(0);

      renderer.renderCastPass(encoder, [], { x: 6378137.0, y: 0.0, z: 0.0 });
      expect(encoder.passDescriptors.length).toBe(4);
      expect(renderer["_castDispatches"]).toBe(0);
    });
  });

  describe("split distribution", function () {
    it("constructs with configurable cascade count + lambda", function () {
      const r = new WebGPUCSMRenderer({
        cascadeCount: 4,
        lambda: 0.7,
        maxShadowDistance: 1e6,
      });
      r.computeSplits(1, 1e6);
      const splits = r.cascades.map((c) => c.splitFar);
      // Four cascades → four non-decreasing split-far values.
      expect(splits.length).toBe(4);
      for (let i = 1; i < splits.length; i++) {
        expect(splits[i]).toBeGreaterThan(splits[i - 1]);
      }
      // Final cascade ends at maxShadowDistance.
      expect(splits[splits.length - 1]).toBeCloseTo(1e6, 0);
    });

    it("uses logarithmic bias when lambda → 1", function () {
      const logR = new WebGPUCSMRenderer({ cascadeCount: 4, lambda: 1.0 });
      const uniR = new WebGPUCSMRenderer({ cascadeCount: 4, lambda: 0.0 });
      logR.computeSplits(1, 1e6);
      uniR.computeSplits(1, 1e6);
      // Log split should be much closer to the camera than uniform at
      // intermediate cascades. Cascade 0 log-far is near powers of far/near^(1/N).
      expect(logR.cascades[0].splitFar).toBeLessThan(uniR.cascades[0].splitFar);
    });

    it("clamps against maxShadowDistance", function () {
      const r = new WebGPUCSMRenderer({
        cascadeCount: 4,
        lambda: 0.7,
        maxShadowDistance: 10000,
      });
      // Camera far far exceeds maxShadowDistance — last cascade should clamp.
      r.computeSplits(1, 1e8);
      expect(r.cascades[3].splitFar).toBeCloseTo(10000, -1);
    });
  });

  describe("computeFrustumCornersWorldSpace", function () {
    const camera = {
      positionWC: { x: 0, y: 0, z: 0 },
      directionWC: { x: 1, y: 0, z: 0 }, // looking +X
      upWC: { x: 0, y: 0, z: 1 }, // up = +Z
      rightWC: { x: 0, y: -1, z: 0 }, // right = -Y (RH system)
      frustum: { fovy: Math.PI / 2, aspectRatio: 1.0 },
    };

    it("returns 24 floats (8 corners × xyz)", function () {
      const corners = computeFrustumCornersWorldSpace(camera, 1, 10);
      expect(corners.length).toBe(24);
    });

    it("near corners are at `nearDist` along the view axis", function () {
      const corners = computeFrustumCornersWorldSpace(camera, 1, 10);
      // Corners 0-3 are near plane — their x-coordinate should be ~1.
      for (let i = 0; i < 4; i++) {
        expect(corners[i * 3 + 0]).toBeCloseTo(1.0, 4);
      }
    });

    it("far corners are at `farDist` along the view axis", function () {
      const corners = computeFrustumCornersWorldSpace(camera, 1, 10);
      // Corners 4-7 are far plane — x ≈ 10.
      for (let i = 4; i < 8; i++) {
        expect(corners[i * 3 + 0]).toBeCloseTo(10.0, 4);
      }
    });

    it("produces corners that are symmetric about the view axis", function () {
      const corners = computeFrustumCornersWorldSpace(camera, 1, 10);
      // With a square FOV (aspect 1.0) at near=1 with fovy 90°, the
      // near-plane half-extent should be ~1.0 in each direction.
      const nearTL_y = corners[0 * 3 + 1];
      const nearTR_y = corners[1 * 3 + 1];
      // TL/TR differ only on the right-axis, so their y-values are +/-
      // symmetric around the center.
      expect(nearTL_y + nearTR_y).toBeCloseTo(0, 4);
    });
  });

  describe("fitBoundingSphere", function () {
    it("fits a unit sphere around the 8 corners of a unit cube", function () {
      const pts = new Float64Array([
        -1, -1, -1, 1, -1, -1, -1, 1, -1, 1, 1, -1, -1, -1, 1, 1, -1, 1, -1, 1,
        1, 1, 1, 1,
      ]);
      const { center, radius } = fitBoundingSphere(pts);
      expect(center[0]).toBeCloseTo(0, 6);
      expect(center[1]).toBeCloseTo(0, 6);
      expect(center[2]).toBeCloseTo(0, 6);
      // Unit cube corners are at distance √3 from the center.
      expect(radius).toBeCloseTo(Math.sqrt(3), 4);
    });

    it("center-of-mass is the arithmetic mean of input points", function () {
      const pts = new Float64Array([10, 0, 0, 20, 0, 0, 30, 0, 0]);
      const { center } = fitBoundingSphere(pts);
      expect(center[0]).toBeCloseTo(20, 6); // mean of 10, 20, 30
    });
  });

  describe("computeCascadeVPMatrix", function () {
    it("returns a 16-entry column-major matrix", function () {
      const result = new Float64Array(16);
      computeCascadeVPMatrix(
        [0, 0, 0],
        10,
        { x: 0, y: 1, z: 0 }, // light straight up
        result,
      );
      expect(result.length).toBe(16);
      // Homogeneous row should have 0,0,0,1-ish values in the bottom row
      // (column-major, so positions 3/7/11/15). VP matrix bottom row is
      // all zero except m15 which is the ortho projection's pass-through.
      expect(result[15]).toBe(1); // ortho projection preserves w
    });

    it("is stable when called twice with identical inputs", function () {
      const a = new Float64Array(16);
      const b = new Float64Array(16);
      const center = [100, 200, 300];
      const lightDir = { x: 0, y: 1, z: 0 };
      computeCascadeVPMatrix(center, 50, lightDir, a);
      computeCascadeVPMatrix(center, 50, lightDir, b);
      for (let i = 0; i < 16; i++) {
        expect(a[i]).toBe(b[i]);
      }
    });

    it("applyCameraTranslationToVP leaves columns 0..2 unchanged", function () {
      const vp = new Float64Array(16);
      computeCascadeVPMatrix([100, 200, 300], 50, { x: 0, y: 1, z: 0 }, vp);
      const rte = new Float64Array(16);
      applyCameraTranslationToVP(vp, 6378137, 0, 0, rte);
      // Columns 0..2 (indices 0..11) carry the rotation/scale parts and
      // must be identical between VP_world and VP_RTE.
      for (let i = 0; i < 12; i++) {
        expect(rte[i]).toBe(vp[i]);
      }
    });

    it("applyCameraTranslationToVP produces VP_RTE such that VP_RTE * eyePos == VP_world * worldPos", function () {
      const vp = new Float64Array(16);
      computeCascadeVPMatrix([6378137, 0, 0], 50, { x: 0, y: 1, z: 0 }, vp);
      const rte = new Float64Array(16);
      const camX = 6378137,
        camY = 0,
        camZ = 0;
      applyCameraTranslationToVP(vp, camX, camY, camZ, rte);
      // Pick an eyePos (camera-relative) and its corresponding worldPos.
      const eyeX = 10,
        eyeY = 5,
        eyeZ = -3;
      const worldX = eyeX + camX;
      const worldY = eyeY + camY;
      const worldZ = eyeZ + camZ;
      const rteOut = [
        rte[0] * eyeX + rte[4] * eyeY + rte[8] * eyeZ + rte[12],
        rte[1] * eyeX + rte[5] * eyeY + rte[9] * eyeZ + rte[13],
        rte[2] * eyeX + rte[6] * eyeY + rte[10] * eyeZ + rte[14],
        rte[3] * eyeX + rte[7] * eyeY + rte[11] * eyeZ + rte[15],
      ];
      const worldOut = [
        vp[0] * worldX + vp[4] * worldY + vp[8] * worldZ + vp[12],
        vp[1] * worldX + vp[5] * worldY + vp[9] * worldZ + vp[13],
        vp[2] * worldX + vp[6] * worldY + vp[10] * worldZ + vp[14],
        vp[3] * worldX + vp[7] * worldY + vp[11] * worldZ + vp[15],
      ];
      // Equal to within double-precision rounding of the 6.4M-scale add.
      for (let i = 0; i < 4; i++) {
        expect(rteOut[i]).toBeCloseTo(worldOut[i], 4);
      }
    });

    // ─── Cast-VS math contract (Slice 2 prerequisite) ─────────────────
    //
    // `computeCastClipPosition` is the CPU reference for the `rte24`
    // shadow cast vertex shader in WebGPUShadowMapRenderer.js. If any
    // Slice 2 cast variant (p12 / quantized12 / model*) is added,
    // the RTE subtract + lightVP_RTE multiply MUST match this math.
    // Variant-specific vertex decompression happens BEFORE these steps.

    it("computeCastClipPosition at origin with identity VP is the input", function () {
      // Identity-rotation ortho-projection-like matrix (just the identity).
      const identity = new Float64Array([
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
      ]);
      const result = new Float64Array(4);
      computeCastClipPosition(
        [1, 2, 3], // posHigh
        [0, 0, 0], // posLow
        [0, 0, 0], // camHigh
        [0, 0, 0], // camLow
        identity,
        0.0, // no bias
        result,
      );
      expect(result[0]).toBe(1);
      expect(result[1]).toBe(2);
      expect(result[2]).toBe(3);
      expect(result[3]).toBe(1);
    });

    it("computeCastClipPosition subtracts camera RTE correctly at Earth scale", function () {
      // Camera at Earth radius; vertex 100m offset along +X from it.
      // After RTE subtract the effective eye-space position is (100,0,0).
      const identity = new Float64Array([
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
      ]);
      const result = new Float64Array(4);
      computeCastClipPosition(
        [6378137, 0, 0], // posHigh
        [100, 0, 0], // posLow (100m delta)
        [6378137, 0, 0], // camHigh = posHigh
        [0, 0, 0], // camLow
        identity,
        0.0,
        result,
      );
      // RTE: (6378137-6378137) + (100-0) = 100 along X; others zero.
      expect(result[0]).toBe(100);
      expect(result[1]).toBe(0);
      expect(result[2]).toBe(0);
      expect(result[3]).toBe(1);
    });

    it("computeCastClipPosition(pH,pL,camH,camL,VP_RTE) ≡ VP_world * worldPos at Earth scale", function () {
      // This is THE cast-side RTE identity. Locks in the Slice 1 fix
      // (Session 33) — every Slice 2 cast variant must produce output
      // that's bit-close (within FP32 ULP) to this reference.
      const vpWorld = new Float64Array(16);
      const center = [6378137, 1000, 0];
      computeCascadeVPMatrix(center, 500, { x: 0, y: 1, z: 0 }, vpWorld);

      const camX = 6378137;
      const camY = 1000;
      const camZ = 0;
      const vpRte = new Float64Array(16);
      applyCameraTranslationToVP(vpWorld, camX, camY, camZ, vpRte);

      // Vertex 50m from the camera along X and 3m along Z.
      const pHigh = [6378137, 1000, 0];
      const pLow = [50, 0, 3];
      const camHigh = [6378137, 1000, 0];
      const camLow = [0, 0, 0];
      const worldX = pHigh[0] + pLow[0];
      const worldY = pHigh[1] + pLow[1];
      const worldZ = pHigh[2] + pLow[2];

      const rteResult = new Float64Array(4);
      computeCastClipPosition(
        pHigh,
        pLow,
        camHigh,
        camLow,
        vpRte,
        0.0,
        rteResult,
      );

      const worldResult = [
        vpWorld[0] * worldX +
          vpWorld[4] * worldY +
          vpWorld[8] * worldZ +
          vpWorld[12],
        vpWorld[1] * worldX +
          vpWorld[5] * worldY +
          vpWorld[9] * worldZ +
          vpWorld[13],
        vpWorld[2] * worldX +
          vpWorld[6] * worldY +
          vpWorld[10] * worldZ +
          vpWorld[14],
        vpWorld[3] * worldX +
          vpWorld[7] * worldY +
          vpWorld[11] * worldZ +
          vpWorld[15],
      ];

      // The RTE path rounds the camera translation once (via
      // applyCameraTranslationToVP) and then does the multiply in FP64.
      // The world path multiplies 6.4M-scale worlds by a projection
      // whose translation column also carries the 6.4M cancellation.
      // Both paths should agree within double-precision rounding at
      // this scale.
      for (let i = 0; i < 4; i++) {
        expect(rteResult[i]).toBeCloseTo(worldResult[i], 4);
      }
    });

    it("computeCastClipPosition depth bias adds ONLY to clip.z", function () {
      const identity = new Float64Array([
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
      ]);
      const baseline = new Float64Array(4);
      const biased = new Float64Array(4);
      computeCastClipPosition(
        [10, 20, 30],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        identity,
        0.0,
        baseline,
      );
      computeCastClipPosition(
        [10, 20, 30],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        identity,
        0.001, // positive bias — matches WGSL `pos.z += u.depthBias`
        biased,
      );
      expect(biased[0]).toBe(baseline[0]);
      expect(biased[1]).toBe(baseline[1]);
      expect(biased[2]).toBeCloseTo(baseline[2] + 0.001, 10);
      expect(biased[3]).toBe(baseline[3]);
    });

    // ─── Texel-snap stabilization (Slice 2b) ──────────────────────────
    //
    // `snapToTexelGrid` quantizes the cascade sphere center to the
    // shadow-texel grid in light space. Without snapping, static edges
    // shimmer as the camera moves. The snap must be (a) idempotent on
    // an already-snapped center, (b) bounded by one texel of
    // displacement, and (c) preserve VP numerical stability.

    it("snapToTexelGrid on an already-snapped center is a no-op", function () {
      const resolution = 1024;
      const radius = 100;
      const lightDir = { x: 0, y: 0, z: 1 };
      const raw = [1000.5, 2000.3, 3000.7];
      const snap1 = new Float64Array(3);
      const snap2 = new Float64Array(3);
      snapToTexelGrid(raw, radius, lightDir, resolution, snap1);
      snapToTexelGrid(snap1, radius, lightDir, resolution, snap2);
      // Second snap should be a no-op up to floating-point rounding.
      for (let i = 0; i < 3; i++) {
        expect(snap2[i]).toBeCloseTo(snap1[i], 8);
      }
    });

    it("snapToTexelGrid moves the center by at most ~one texel (diagonal)", function () {
      const resolution = 1024;
      const radius = 100;
      const lightDir = { x: 0, y: 0, z: 1 };
      const raw = [1234.567, 8765.432, 2468.135];
      const snapped = new Float64Array(3);
      snapToTexelGrid(raw, radius, lightDir, resolution, snapped);
      const dx = snapped[0] - raw[0];
      const dy = snapped[1] - raw[1];
      const dz = snapped[2] - raw[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const texelWorld = (2 * radius) / resolution; // ~0.195m
      // Snap is in light-space XY, so max displacement is half-texel
      // along each axis → diagonal bound of texelWorld * sqrt(2) / 2.
      // Allow a small epsilon for basis rounding.
      expect(dist).toBeLessThanOrEqual(texelWorld * 0.71 + 1e-9);
    });

    it("snapToTexelGrid with zenith light keeps Z unchanged (light-space XY is world XY)", function () {
      // Zenith light: lightDir = +Z. Basis: forward = Z, side = cross(Z,Y) = X,
      // up' = cross(X, Z) = -Y. So light-space XY = world (X, -Y).
      // Snap affects X and Y but not Z.
      const resolution = 1024;
      const radius = 100;
      const lightDir = { x: 0, y: 0, z: 1 };
      const raw = [123.456, 789.012, 42.0];
      const snapped = new Float64Array(3);
      snapToTexelGrid(raw, radius, lightDir, resolution, snapped);
      // Z should not move (no basis axis aligns with world Z for snap).
      expect(snapped[2]).toBeCloseTo(raw[2], 6);
    });

    it("snapToTexelGrid does not change the bounding coverage (sphere is recentered within one texel)", function () {
      // After snap, the original raw point should still be inside the
      // sphere of radius r around the snapped center — just barely.
      const resolution = 1024;
      const radius = 500;
      const lightDir = { x: 1, y: 0, z: 0 };
      const raw = [10000, 20000, 30000];
      const snapped = new Float64Array(3);
      snapToTexelGrid(raw, radius, lightDir, resolution, snapped);
      const dx = snapped[0] - raw[0];
      const dy = snapped[1] - raw[1];
      const dz = snapped[2] - raw[2];
      const offset = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Raw point sits at distance `offset` from the snapped center —
      // must be less than the radius by a wide margin.
      expect(offset).toBeLessThan(radius);
    });

    it("snapToTexelGrid keeps VP numerical stability (snapped VP ≈ raw VP)", function () {
      const resolution = 1024;
      const radius = 100;
      const lightDir = { x: 0, y: 0, z: 1 };
      const raw = [1234.567, 8765.432, 2468.135];
      const snapped = new Float64Array(3);
      snapToTexelGrid(raw, radius, lightDir, resolution, snapped);
      const vpRaw = new Float64Array(16);
      const vpSnap = new Float64Array(16);
      computeCascadeVPMatrix(raw, radius, lightDir, vpRaw);
      computeCascadeVPMatrix(
        [snapped[0], snapped[1], snapped[2]],
        radius,
        lightDir,
        vpSnap,
      );
      // The two VPs differ only by the <1-texel translation component.
      // Columns 0..2 (rotation/scale) should be identical.
      for (let i = 0; i < 12; i++) {
        expect(vpSnap[i]).toBeCloseTo(vpRaw[i], 6);
      }
      // Column 3 (translation) may differ by a small, bounded amount.
      // Verify the difference is proportional to texelWorld, not a
      // catastrophically wrong matrix.
      const texelWorld = (2 * radius) / resolution;
      for (let j = 12; j < 15; j++) {
        expect(Math.abs(vpSnap[j] - vpRaw[j])).toBeLessThan(10 * texelWorld);
      }
    });

    it("maps the sphere center onto the near clip plane in light space", function () {
      const result = new Float64Array(16);
      const center = [0, 0, 0];
      const radius = 10;
      const lightDir = { x: 0, y: 1, z: 0 };
      computeCascadeVPMatrix(center, radius, lightDir, result);
      // Apply VP to the center point and check z ∈ [0,1] (WebGPU NDC).
      const cx = center[0],
        cy = center[1],
        cz = center[2];
      // column-major: result[col*4 + row]
      const wx = result[0] * cx + result[4] * cy + result[8] * cz + result[12];
      const wy = result[1] * cx + result[5] * cy + result[9] * cz + result[13];
      const wz = result[2] * cx + result[6] * cy + result[10] * cz + result[14];
      const ww = result[3] * cx + result[7] * cy + result[11] * cz + result[15];
      // Sphere center should project to the origin (x, y ≈ 0) and
      // depth ≈ 2/3 of the way into the ortho volume (near=0, far=3r,
      // center sits at distance 2r from eye → z/far = 2r/3r ≈ 0.667).
      expect(wx / ww).toBeCloseTo(0, 3);
      expect(wy / ww).toBeCloseTo(0, 3);
      expect(wz / ww).toBeCloseTo(2 / 3, 2);
    });
  });

  describe("CSMParams UBO pack — WGSL float offsets", function () {
    // Regression guard: `WebGPUCSMRenderer.computeCascadeVPs` writes
    // splits/blendBands/biases into `_cascadeParamsData` at the float
    // offsets the shader's natural WGSL layout expects. The struct is:
    //   4 × mat4x4<f32> (offsets 0..15, 16..31, 32..47, 48..63)
    //   vec4 cascadeSplits       @ 64..67
    //   vec4 blendBands          @ 68..71
    //   vec4 cascadeMinBias      @ 72..75
    //   vec4 cascadeMaxSlopeBias @ 76..79
    // If the JS packer drifts from these offsets, the shader reads
    // zeros and CSM silently degrades to single-cascade / no-bias mode.
    it("packs splits/blendBands/biases at WGSL-natural offsets (64/68/72/76)", function () {
      const r = new WebGPUCSMRenderer({
        cascadeCount: 4,
        lambda: 0.5,
        blendBand: 0.1,
        maxShadowDistance: 10000,
      });
      r.computeSplits(1, 10000);
      // Inject a fake sphereRadius per cascade so the bias scaling
      // produces non-zero, distinguishable values.
      const cascades = r.cascades;
      for (let c = 0; c < cascades.length; c++) {
        cascades[c].sphereRadius = 100 * (c + 1); // 100, 200, 300, 400
        cascades[c].viewProjection.fill(0);
        cascades[c].viewProjectionRTE.fill(0);
      }

      // Drive the pack via the private method. We only care about the
      // split / blend / bias offsets here — VPs are covered elsewhere.
      const camera = {
        positionWC: { x: 0, y: 0, z: 0 },
        directionWC: { x: 1, y: 0, z: 0 },
        upWC: { x: 0, y: 0, z: 1 },
        rightWC: { x: 0, y: -1, z: 0 },
        frustum: { fovy: Math.PI / 2, aspectRatio: 1.0 },
      };
      r.enabled = true;
      r.computeCascadeVPs(camera, { x: -1, y: 0, z: 0 });

      // Cast-through access — spec needs to inspect the private buffer.

      const data = r["_cascadeParamsData"];

      // cascadeSplits at floats 64..67 must match splitFar values.
      for (let c = 0; c < 4; c++) {
        expect(data[64 + c]).toBeCloseTo(cascades[c].splitFar, 3);
      }
      // blendBands at 68..71 should be non-zero (range * blendBand).
      for (let c = 0; c < 4; c++) {
        expect(data[68 + c]).toBeGreaterThan(0);
      }
      // cascadeMinBias at 72..75 should be BASE_MIN_BIAS × per-cascade scale.
      for (let c = 0; c < 4; c++) {
        expect(data[72 + c]).toBeGreaterThan(0);
      }
      // cascadeMaxSlopeBias at 76..79.
      for (let c = 0; c < 4; c++) {
        expect(data[76 + c]).toBeGreaterThan(0);
      }

      // Old positions (floats 256/260/264/268) MUST stay zero — that's
      // where the old buggy packer wrote. If anything there is non-zero,
      // the packer regressed to the pre-fix layout.
      for (let i = 256; i < 272; i++) {
        expect(data[i]).toBe(0);
      }
    });
  });
});
