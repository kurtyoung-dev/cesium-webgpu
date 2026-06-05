import WebGPUUniformGroupManager, {
  UniformFrequency,
  PER_FRAME_LAYOUT,
  PER_MATERIAL_LAYOUT,
  PER_OBJECT_LAYOUT,
} from "../../../Source/Renderer/WebGPU/WebGPUUniformGroupManager.js";

// ── Scope ───────────────────────────────────────────────────────────
//
// WebGPUUniformGroupManager's GPU paths (initialize, flushPerFrame, and
// the private _create*Layout / _createPerFrameBuffer helpers) call
// device.createBuffer / device.createBindGroup / device.queue.writeBuffer,
// which all need a live GPUDevice. The constructor itself only stores the
// device reference and allocates a CPU-side Float32Array — it never
// touches the device — so a bare stub ({}) is safe for everything below.
//
// These specs cover the parts that DON'T need a device:
//   - the three exported layout constants (group index, byte offsets,
//     sizes, wgslType, total bufferSize, hasTextures flag) — a contract
//     between the JS packer and the consuming WGSL structs
//   - UniformFrequency enum values
//   - constructor: CPU Float32Array sizing + null bind-group/layout getters
//   - static generateWGSL() string generation (pure)
//   - updatePerFrame() CPU packing into _perFrameData at the documented
//     float offsets (no device call; the debug RTE round-trip assertion is
//     avoided by omitting uniformState.cameraPosition)
//   - beginFrame() object-pool-index reset (pure)
//   - destroy() on a never-initialized manager (null-safe, no device call)
//
// SKIPPED (device-bound — require a real GPUDevice/queue): initialize(),
// flushPerFrame(), and the private layout/buffer creation helpers.

// A stub device — never invoked by any path exercised here.
function makeManager() {
  return new WebGPUUniformGroupManager(/** @type {any} */ ({}));
}

// A vec3-ish stub mirroring Cartesian3's { x, y, z } shape that
// updatePerFrame reads off the UniformState.
function vec3(x, y, z) {
  return { x: x, y: y, z: z };
}

describe("Renderer/WebGPU/WebGPUUniformGroupManager", function () {
  describe("UniformFrequency enum", function () {
    it("numbers the three groups 0/1/2 by update frequency", function () {
      expect(UniformFrequency.PER_FRAME).toBe(0);
      expect(UniformFrequency.PER_MATERIAL).toBe(1);
      expect(UniformFrequency.PER_OBJECT).toBe(2);
    });
  });

  describe("PER_FRAME_LAYOUT (Group 0)", function () {
    it("targets group 0, is 256 bytes, and has no textures", function () {
      expect(PER_FRAME_LAYOUT.group).toBe(UniformFrequency.PER_FRAME);
      expect(PER_FRAME_LAYOUT.bufferSize).toBe(256);
      expect(PER_FRAME_LAYOUT.hasTextures).toBe(false);
    });

    it("lists eight entries in the documented order", function () {
      expect(PER_FRAME_LAYOUT.entries.length).toBe(8);
      expect(PER_FRAME_LAYOUT.entries.map((e) => e.name)).toEqual([
        "mvpRelativeToEye",
        "modelViewRelativeToEye",
        "normalMatrix",
        "encodedCameraHigh",
        "encodedCameraLow",
        "lightDirection",
        "viewportSize",
        "frameNumber",
      ]);
    });

    it("packs the three mat4 matrices at offsets 0/64/128 (64 bytes each)", function () {
      const byName = {};
      for (const e of PER_FRAME_LAYOUT.entries) {
        byName[e.name] = e;
      }
      expect(byName.mvpRelativeToEye.offset).toBe(0);
      expect(byName.mvpRelativeToEye.size).toBe(64);
      expect(byName.mvpRelativeToEye.wgslType).toBe("mat4x4<f32>");

      expect(byName.modelViewRelativeToEye.offset).toBe(64);
      expect(byName.modelViewRelativeToEye.size).toBe(64);

      expect(byName.normalMatrix.offset).toBe(128);
      expect(byName.normalMatrix.size).toBe(64);
    });

    it("packs the camera/light vec4s and viewport/frame tail at 192..248", function () {
      const byName = {};
      for (const e of PER_FRAME_LAYOUT.entries) {
        byName[e.name] = e;
      }
      expect(byName.encodedCameraHigh.offset).toBe(192);
      expect(byName.encodedCameraHigh.size).toBe(16);
      expect(byName.encodedCameraHigh.wgslType).toBe("vec4<f32>");

      expect(byName.encodedCameraLow.offset).toBe(208);
      expect(byName.lightDirection.offset).toBe(224);

      expect(byName.viewportSize.offset).toBe(240);
      expect(byName.viewportSize.size).toBe(8);
      expect(byName.viewportSize.wgslType).toBe("vec2<f32>");

      expect(byName.frameNumber.offset).toBe(248);
      expect(byName.frameNumber.size).toBe(4);
      expect(byName.frameNumber.wgslType).toBe("f32");
    });

    it("has every entry contained within bufferSize (no overflow)", function () {
      for (const e of PER_FRAME_LAYOUT.entries) {
        expect(e.offset + e.size).toBeLessThanOrEqual(
          PER_FRAME_LAYOUT.bufferSize,
        );
      }
    });
  });

  describe("PER_MATERIAL_LAYOUT (Group 1)", function () {
    it("targets group 1, is 256 bytes, and includes textures", function () {
      expect(PER_MATERIAL_LAYOUT.group).toBe(UniformFrequency.PER_MATERIAL);
      expect(PER_MATERIAL_LAYOUT.bufferSize).toBe(256);
      expect(PER_MATERIAL_LAYOUT.hasTextures).toBe(true);
    });

    it("packs baseColor/emissive vec4s then the four f32 PBR scalars", function () {
      const byName = {};
      for (const e of PER_MATERIAL_LAYOUT.entries) {
        byName[e.name] = e;
      }
      expect(PER_MATERIAL_LAYOUT.entries.length).toBe(6);

      expect(byName.baseColor.offset).toBe(0);
      expect(byName.baseColor.size).toBe(16);
      expect(byName.baseColor.wgslType).toBe("vec4<f32>");

      expect(byName.emissiveFactor.offset).toBe(16);
      expect(byName.emissiveFactor.size).toBe(16);

      expect(byName.metallicFactor.offset).toBe(32);
      expect(byName.metallicFactor.size).toBe(4);
      expect(byName.metallicFactor.wgslType).toBe("f32");

      expect(byName.roughnessFactor.offset).toBe(36);
      expect(byName.alphaCutoff.offset).toBe(40);
      expect(byName.doubleSided.offset).toBe(44);
      expect(byName.doubleSided.wgslType).toBe("f32");
    });
  });

  describe("PER_OBJECT_LAYOUT (Group 2)", function () {
    it("targets group 2, is 256 bytes, and has no textures", function () {
      expect(PER_OBJECT_LAYOUT.group).toBe(UniformFrequency.PER_OBJECT);
      expect(PER_OBJECT_LAYOUT.bufferSize).toBe(256);
      expect(PER_OBJECT_LAYOUT.hasTextures).toBe(false);
    });

    it("packs modelMatrix, pickColor, then a u32 objectId", function () {
      const byName = {};
      for (const e of PER_OBJECT_LAYOUT.entries) {
        byName[e.name] = e;
      }
      expect(PER_OBJECT_LAYOUT.entries.length).toBe(3);

      expect(byName.modelMatrix.offset).toBe(0);
      expect(byName.modelMatrix.size).toBe(64);
      expect(byName.modelMatrix.wgslType).toBe("mat4x4<f32>");

      expect(byName.pickColor.offset).toBe(64);
      expect(byName.pickColor.size).toBe(16);
      expect(byName.pickColor.wgslType).toBe("vec4<f32>");

      expect(byName.objectId.offset).toBe(80);
      expect(byName.objectId.size).toBe(4);
      expect(byName.objectId.wgslType).toBe("u32");
    });
  });

  describe("constructor", function () {
    it("is defined and constructs from a stub device without touching it", function () {
      expect(WebGPUUniformGroupManager).toBeDefined();
      expect(() => makeManager()).not.toThrow();
    });

    it("allocates a CPU-side per-frame Float32Array of bufferSize/4 floats", function () {
      const mgr = makeManager();
      // _perFrameData = new Float32Array(PER_FRAME_LAYOUT.bufferSize / 4).
      expect(mgr._perFrameData instanceof Float32Array).toBe(true);
      expect(mgr._perFrameData.length).toBe(PER_FRAME_LAYOUT.bufferSize / 4);
      expect(mgr._perFrameData.length).toBe(64);
    });

    it("exposes null bind groups + layouts before initialize()", function () {
      const mgr = makeManager();
      expect(mgr.perFrameBindGroup).toBeNull();
      expect(mgr.perFrameBindGroupLayout).toBeNull();
      expect(mgr.materialBindGroupLayout).toBeNull();
      expect(mgr.objectBindGroupLayout).toBeNull();
    });
  });

  describe("generateWGSL()", function () {
    it("emits a struct + group/binding declaration for PER_OBJECT_LAYOUT", function () {
      const wgsl = WebGPUUniformGroupManager.generateWGSL(
        PER_OBJECT_LAYOUT,
        "PerObject",
      );
      expect(wgsl).toContain("struct PerObject {");
      expect(wgsl).toContain("  modelMatrix: mat4x4<f32>,");
      expect(wgsl).toContain("  pickColor: vec4<f32>,");
      expect(wgsl).toContain("  objectId: u32,");
      // group index comes from layout.group; binding is fixed at 0; the
      // var name is the lower-cased struct name.
      expect(wgsl).toContain(
        "@group(2) @binding(0) var<uniform> perobject: PerObject;",
      );
    });

    it("uses the layout.group index in the @group attribute", function () {
      const wgsl = WebGPUUniformGroupManager.generateWGSL(
        PER_FRAME_LAYOUT,
        "PerFrame",
      );
      expect(wgsl).toContain("@group(0) @binding(0)");
      expect(wgsl).toContain("var<uniform> perframe: PerFrame;");
    });

    it("emits one struct member line per layout entry", function () {
      const wgsl = WebGPUUniformGroupManager.generateWGSL(
        PER_MATERIAL_LAYOUT,
        "PerMaterial",
      );
      // One member line ("  name: type,") per entry.
      const memberLines = wgsl
        .split("\n")
        .filter((line) => /^ {2}\w+: .+,$/.test(line));
      expect(memberLines.length).toBe(PER_MATERIAL_LAYOUT.entries.length);
    });
  });

  describe("updatePerFrame()", function () {
    it("packs matrices/vectors at the documented float offsets (no device call)", function () {
      const mgr = makeManager();
      const mvp = new Float32Array(16);
      const mv = new Float32Array(16);
      for (let i = 0; i < 16; i++) {
        mvp[i] = i + 1; // 1..16
        mv[i] = 100 + i; // 100..115
      }
      // 3x3 normal matrix (mat3 → expanded to mat4 layout).
      const normal = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);

      mgr.updatePerFrame(
        /** @type {any} */ ({
          modelViewProjectionRelativeToEye: mvp,
          modelViewRelativeToEye: mv,
          normal: normal,
          encodedCameraPositionMCHigh: vec3(11, 12, 13),
          encodedCameraPositionMCLow: vec3(21, 22, 23),
          // cameraPosition deliberately omitted so the debug RTE
          // round-trip assertion path is not entered.
          sunDirectionWC: vec3(0, 0, 1),
          viewport: { width: 800, height: 600 },
          frameState: { frameNumber: 42 },
        }),
      );

      const d = mgr._perFrameData;

      // mvp at floats 0..15.
      for (let i = 0; i < 16; i++) {
        expect(d[i]).toBe(i + 1);
      }
      // modelView at floats 16..31.
      for (let i = 0; i < 16; i++) {
        expect(d[16 + i]).toBe(100 + i);
      }

      // normalMatrix mat3 → mat4 expansion at floats 32..47.
      expect(d[32]).toBe(1);
      expect(d[33]).toBe(2);
      expect(d[34]).toBe(3);
      expect(d[35]).toBe(0);
      expect(d[36]).toBe(4);
      expect(d[37]).toBe(5);
      expect(d[38]).toBe(6);
      expect(d[39]).toBe(0);
      expect(d[40]).toBe(7);
      expect(d[41]).toBe(8);
      expect(d[42]).toBe(9);
      expect(d[43]).toBe(0);
      expect(d[44]).toBe(0);
      expect(d[45]).toBe(0);
      expect(d[46]).toBe(0);
      expect(d[47]).toBe(1);

      // encodedCameraHigh at floats 48..51 (w forced to 0).
      expect(d[48]).toBe(11);
      expect(d[49]).toBe(12);
      expect(d[50]).toBe(13);
      expect(d[51]).toBe(0);

      // encodedCameraLow at floats 52..55 (w forced to 0).
      expect(d[52]).toBe(21);
      expect(d[53]).toBe(22);
      expect(d[54]).toBe(23);
      expect(d[55]).toBe(0);

      // lightDirection at floats 56..59 (w forced to 0).
      expect(d[56]).toBe(0);
      expect(d[57]).toBe(0);
      expect(d[58]).toBe(1);
      expect(d[59]).toBe(0);

      // viewportSize at floats 60..61.
      expect(d[60]).toBe(800);
      expect(d[61]).toBe(600);

      // frameNumber at float 62.
      expect(d[62]).toBe(42);
    });

    it("defaults frameNumber to 0 when frameState is missing", function () {
      const mgr = makeManager();
      mgr.updatePerFrame(/** @type {any} */ ({}));
      // data[62] = uniformState.frameState?.frameNumber ?? 0.
      expect(mgr._perFrameData[62]).toBe(0);
    });

    it("leaves slots untouched when the matching UniformState field is absent", function () {
      const mgr = makeManager();
      // Pre-fill so we can detect "no write".
      mgr._perFrameData.fill(7);
      mgr.updatePerFrame(/** @type {any} */ ({}));
      // mvp/mv/normal/cam/light/viewport are all guarded by truthy checks,
      // so an empty UniformState only writes frameNumber (slot 62).
      expect(mgr._perFrameData[0]).toBe(7);
      expect(mgr._perFrameData[48]).toBe(7);
      expect(mgr._perFrameData[60]).toBe(7);
      expect(mgr._perFrameData[62]).toBe(0);
    });

    it("marks per-frame data dirty after an update", function () {
      const mgr = makeManager();
      mgr._perFrameDirty = false;
      mgr.updatePerFrame(/** @type {any} */ ({}));
      expect(mgr._perFrameDirty).toBe(true);
    });
  });

  describe("beginFrame()", function () {
    it("resets the per-object ring-buffer pool index to 0", function () {
      const mgr = makeManager();
      mgr._objectPoolIndex = 5;
      mgr.beginFrame();
      expect(mgr._objectPoolIndex).toBe(0);
    });
  });

  describe("destroy()", function () {
    it("is safe on a never-initialized manager (no device buffers)", function () {
      const mgr = makeManager();
      expect(() => mgr.destroy()).not.toThrow();
      // _perFrameBuffer was null; the material/object collections are
      // emptied without any device call.
      expect(mgr._perFrameBuffer).toBeNull();
      expect(mgr._materialBuffers.size).toBe(0);
      expect(mgr._materialBindGroups.size).toBe(0);
      expect(mgr._objectBufferPool.length).toBe(0);
    });
  });
});
