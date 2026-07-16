import {
  ShaderDefine,
  ShaderSourceId,
  defineKeyToNames,
  resolveDefineBit,
} from "../../../Source/Renderer/WebGPU/WebGPUShaderDefines.js";

describe("Renderer/WebGPU/WebGPUShaderDefines", function () {
  // This module is pure data + two pure lookup functions. It needs no
  // GPU device, no scene context, and no async setup. The values below
  // are load-bearing: per the module's "add-only; never reorder or
  // remove" rule, a careless renumber would silently alias cached shader
  // modules across rebuilds. These assertions pin every bit and source
  // ID so an accidental reorder fails fast in CI.

  describe("ShaderDefine bitmask registry", function () {
    it("assigns each define a distinct single-bit value", function () {
      expect(ShaderDefine.GEODETIC_NORMAL).toBe(1 << 0);
      expect(ShaderDefine.DISABLE_DEPTH_DISTANCE).toBe(1 << 1);
      expect(ShaderDefine.SPLIT_ENABLED).toBe(1 << 2);
      expect(ShaderDefine.COMPRESSED_VERTICES).toBe(1 << 3);
      expect(ShaderDefine.DISTANCE_DISPLAY_CONDITION).toBe(1 << 4);
      expect(ShaderDefine.EYE_DISTANCE_TRANSLUCENCY).toBe(1 << 5);
      expect(ShaderDefine.EYE_DISTANCE_PIXEL_OFFSET).toBe(1 << 6);
      expect(ShaderDefine.EYE_DISTANCE_SCALING).toBe(1 << 7);
      expect(ShaderDefine.VS_THREE_POINT_DEPTH_CHECK).toBe(1 << 8);
      expect(ShaderDefine.MODEL_HAS_KHR_TEXTURES).toBe(1 << 9);
      expect(ShaderDefine.STOCHASTIC_DITHER_ALPHA).toBe(1 << 10);
      expect(ShaderDefine.STENCIL_PICK_WINNER).toBe(1 << 11);
      expect(ShaderDefine.MODEL_HAS_TEXCOORD_1).toBe(1 << 12);
      expect(ShaderDefine.MODEL_HAS_FEATURE_ID_0).toBe(1 << 13);
      expect(ShaderDefine.MATERIAL_APPLY).toBe(1 << 14);
      expect(ShaderDefine.LOG_DEPTH).toBe(1 << 15);
      expect(ShaderDefine.GLOBE_IMAGERY_REDUCED).toBe(1 << 16);
      expect(ShaderDefine.CAPTURE_MODE).toBe(1 << 17);
      expect(ShaderDefine.MODEL_HAS_METADATA).toBe(1 << 18);
      expect(ShaderDefine.MODEL_HAS_PROPERTY_TEXTURES).toBe(1 << 19);
      expect(ShaderDefine.MODEL_HAS_PROPERTY_TABLES).toBe(1 << 20);
      expect(ShaderDefine.METADATA_PICKING_ENABLED).toBe(1 << 21);
      expect(ShaderDefine.POINT_CLOUD_EDL_DEPTH).toBe(1 << 22);
      expect(ShaderDefine.MODEL_HAS_WGSL_CUSTOM_SHADER).toBe(1 << 23);
      expect(ShaderDefine.MODEL_HAS_WGSL_CUSTOM_VERTEX).toBe(1 << 24);
      expect(ShaderDefine.VOXEL_CUSTOM_SHADER_COLOR).toBe(1 << 25);
      expect(ShaderDefine.MODEL_SPLIT_ENABLED).toBe(1 << 26);
      expect(ShaderDefine.MODEL_HAS_COLOR).toBe(1 << 27);
      expect(ShaderDefine.MODEL_SILHOUETTE).toBe(1 << 28);
      expect(ShaderDefine.VOXEL_USER_CUSTOM_SHADER).toBe(1 << 29);
      expect(ShaderDefine.MODEL_METADATA_MAT_TRANSPORT).toBe(1 << 30);
    });

    it("pins every declared define (no unpinned additions)", function () {
      // The block above pins each bit by name. This count guard forces a
      // newly-added define to come with its own explicit pin: bump the
      // expected count here only after adding the matching expect() above.
      // Bits 0..30 inclusive => 31 entries.
      expect(Object.keys(ShaderDefine).length).toBe(31);
    });

    it("uses each bit exactly once (no aliasing)", function () {
      const bits = Object.values(ShaderDefine);
      const unique = new Set(bits);
      expect(unique.size).toBe(bits.length);
    });

    it("declares every value as a single power of two", function () {
      for (const bit of Object.values(ShaderDefine)) {
        // Power-of-two check: exactly one bit set.
        expect(bit & (bit - 1)).toBe(0);
        expect(bit).toBeGreaterThan(0);
      }
    });

    it("keeps all defines within the full Uint32 cache-key field", function () {
      // The cache key retains `(defines >>> 0)` in a safe 40-bit integer,
      // so all 32 Uint32 bits are available to the add-only registry.
      for (const bit of Object.values(ShaderDefine)) {
        expect(bit >>> 0).toBe(bit);
      }
    });

    it("is frozen (add-only registry cannot be mutated at runtime)", function () {
      expect(Object.isFrozen(ShaderDefine)).toBe(true);
    });
  });

  describe("ShaderSourceId registry", function () {
    it("assigns the documented stable numeric identity to each source", function () {
      expect(ShaderSourceId.GLOBE_TERRAIN).toBe(1);
      expect(ShaderSourceId.BILLBOARD_COLLECTION).toBe(2);
      expect(ShaderSourceId.BILLBOARD_COLLECTION_PICK).toBe(3);
      expect(ShaderSourceId.BILLBOARD_COLLECTION_SDF).toBe(4);
      expect(ShaderSourceId.POINT_PRIMITIVE_COLOR).toBe(5);
      expect(ShaderSourceId.POINT_PRIMITIVE_PICK).toBe(6);
      expect(ShaderSourceId.POLYLINE_COLLECTION).toBe(7);
      expect(ShaderSourceId.POLYLINE_COLLECTION_PICK).toBe(8);
      expect(ShaderSourceId.POLYLINE_ARROW).toBe(9);
      expect(ShaderSourceId.POLYLINE_DASH).toBe(10);
      expect(ShaderSourceId.POLYLINE_GLOW).toBe(11);
      expect(ShaderSourceId.POLYLINE_OUTLINE).toBe(12);
      expect(ShaderSourceId.CLOUD_COLLECTION).toBe(13);
      expect(ShaderSourceId.VOXEL_PRIMITIVE).toBe(14);
      expect(ShaderSourceId.WEATHER_PARTICLE_RENDER).toBe(15);
      expect(ShaderSourceId.WEATHER_PARTICLES_COMPUTE).toBe(16);
      expect(ShaderSourceId.ENVIRONMENT_SUN).toBe(17);
      expect(ShaderSourceId.ENVIRONMENT_MOON).toBe(18);
      expect(ShaderSourceId.VOLUMETRIC_FOG_COMPUTE).toBe(19);
      expect(ShaderSourceId.VOLUMETRIC_FOG_COMPOSITE).toBe(20);
      expect(ShaderSourceId.POINT_CLOUD).toBe(21);
      expect(ShaderSourceId.POINT_CLOUD_LOD).toBe(22);
      expect(ShaderSourceId.MODEL_PBR_COMPLETE).toBe(23);
      expect(ShaderSourceId.VECTOR_3DTILE_PRIMITIVE).toBe(24);
      expect(ShaderSourceId.VECTOR_3DTILE_POLYLINES).toBe(25);
      expect(ShaderSourceId.VECTOR_3DTILE_CLAMPED_POLYLINES).toBe(26);
      expect(ShaderSourceId.BUFFER_POINT_MATERIAL).toBe(27);
      expect(ShaderSourceId.BUFFER_POLYLINE_MATERIAL).toBe(28);
      expect(ShaderSourceId.BUFFER_POLYGON_MATERIAL).toBe(29);
      expect(ShaderSourceId.GROUND_PRIMITIVE).toBe(30);
      expect(ShaderSourceId.GROUND_POLYLINE).toBe(31);
      expect(ShaderSourceId.SKY_ATMOSPHERE).toBe(32);
      expect(ShaderSourceId.ELLIPSOID_PRIMITIVE).toBe(33);
      expect(ShaderSourceId.COMPUTE_INSTANCE_SCAFFOLD).toBe(34);
      expect(ShaderSourceId.COMPUTE_INSTANCE_RENDER).toBe(35);
      expect(ShaderSourceId.GAUSSIAN_SPLAT).toBe(36);
      expect(ShaderSourceId.STAR_FIELD_CATALOG).toBe(37);
      expect(ShaderSourceId.POINT_CLOUD_EDL_DEPTH).toBe(38);
      expect(ShaderSourceId.POINT_CLOUD_EDL_BLEND).toBe(39);
      expect(ShaderSourceId.FLOW_FIELD_RENDER).toBe(40);
      expect(ShaderSourceId.OCEAN_SURFACE).toBe(41);
    });

    it("pins every declared source ID (no unpinned additions)", function () {
      // As with the defines, this count guard forces a newly-added source
      // ID to come with its own explicit pin above. IDs 1..41 with 0
      // reserved => 41 entries.
      expect(Object.keys(ShaderSourceId).length).toBe(41);
    });

    it("reserves source ID 0 (no entry uses it)", function () {
      // ID 0 is intentionally unused so a cache key of zero is
      // distinguishable from "no source."
      expect(Object.values(ShaderSourceId)).not.toContain(0);
    });

    it("uses a unique ID per source (no collisions)", function () {
      const ids = Object.values(ShaderSourceId);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    });

    it("keeps every source ID within the 8-bit cache-key field", function () {
      // The cache key reserves its low byte for sourceId, and the cache
      // rejects callers outside this range rather than masking collisions.
      for (const id of Object.values(ShaderSourceId)) {
        expect(id & 0xff).toBe(id);
      }
    });

    it("is frozen (add-only registry cannot be mutated at runtime)", function () {
      expect(Object.isFrozen(ShaderSourceId)).toBe(true);
    });
  });

  describe("defineKeyToNames", function () {
    it("returns an empty array for a zero bitmask", function () {
      expect(defineKeyToNames(0)).toEqual([]);
    });

    it("returns the single matching name for a single bit", function () {
      expect(defineKeyToNames(ShaderDefine.GEODETIC_NORMAL)).toEqual([
        "GEODETIC_NORMAL",
      ]);
      expect(defineKeyToNames(ShaderDefine.LOG_DEPTH)).toEqual(["LOG_DEPTH"]);
    });

    it("expands a multi-bit mask in registry order", function () {
      const mask =
        ShaderDefine.GEODETIC_NORMAL |
        ShaderDefine.SPLIT_ENABLED |
        ShaderDefine.MATERIAL_APPLY;
      // Object.entries iterates in insertion order, so the returned
      // names follow the declaration order in the registry.
      expect(defineKeyToNames(mask)).toEqual([
        "GEODETIC_NORMAL",
        "SPLIT_ENABLED",
        "MATERIAL_APPLY",
      ]);
    });

    it("ignores bits that don't correspond to any define", function () {
      // Bit 31 is not yet a declared define; it must not produce a name and
      // must not throw.
      const mask = ShaderDefine.COMPRESSED_VERTICES | 0x80000000;
      expect(defineKeyToNames(mask)).toEqual(["COMPRESSED_VERTICES"]);
    });

    it("returns every name when all declared bits are set", function () {
      let mask = 0;
      for (const bit of Object.values(ShaderDefine)) {
        mask |= bit;
      }
      expect(defineKeyToNames(mask)).toEqual(Object.keys(ShaderDefine));
    });
  });

  describe("resolveDefineBit", function () {
    it("resolves a known flag name to its bit", function () {
      expect(resolveDefineBit("GEODETIC_NORMAL")).toBe(
        ShaderDefine.GEODETIC_NORMAL,
      );
      expect(resolveDefineBit("DISABLE_DEPTH_DISTANCE")).toBe(
        ShaderDefine.DISABLE_DEPTH_DISTANCE,
      );
      expect(resolveDefineBit("LOG_DEPTH")).toBe(ShaderDefine.LOG_DEPTH);
    });

    it("returns undefined for an unknown flag name", function () {
      expect(resolveDefineBit("NOT_A_REAL_DEFINE")).toBeUndefined();
    });

    it("is the inverse of defineKeyToNames for each single define", function () {
      for (const [name, bit] of Object.entries(ShaderDefine)) {
        expect(resolveDefineBit(name)).toBe(bit);
        expect(defineKeyToNames(bit)).toEqual([name]);
      }
    });
  });
});
