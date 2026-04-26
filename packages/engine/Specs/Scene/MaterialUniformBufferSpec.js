import Cartesian2 from "../../Source/Core/Cartesian2.js";
import Color from "../../Source/Core/Color.js";
import MaterialUniformBuffer from "../../Source/Scene/MaterialUniformBuffer.js";

// BUG-36.2 (Session 36) — the material UBO packer previously dropped
// channel / channels strings as texture refs (offset -1), so shaders that
// declared runtime `channel: f32` / `channels: vec3` always read zeros.
// These specs lock in the Option B fix: channel strings pack as numeric
// indices (r=0, g=1, b=2, a=3) and WGSL struct layouts match fabric
// declaration order for the affected material types.

describe("Scene/MaterialUniformBuffer", function () {
  describe("channel-string packing (BUG-36.2 Option B)", function () {
    it("maps `channel: 'a'` to f32 index 3", function () {
      const buf = new MaterialUniformBuffer({ channel: "a" });
      const entry = buf.layout.get("channel");
      expect(entry).toBeDefined();
      expect(entry.type).toBe("channelIndex");
      expect(entry.offset).toBe(0);
      expect(entry.size).toBe(1);
      expect(buf.gpuData[0]).toBe(3);
    });

    it("maps `channel: 'r'` to f32 index 0", function () {
      const buf = new MaterialUniformBuffer({ channel: "r" });
      expect(buf.gpuData[0]).toBe(0);
    });

    it("maps `channels: 'rgb'` to vec3 (0, 1, 2)", function () {
      const buf = new MaterialUniformBuffer({ channels: "rgb" });
      const entry = buf.layout.get("channels");
      expect(entry.type).toBe("channelsVec3");
      expect(entry.size).toBe(3);
      expect(buf.gpuData[0]).toBe(0);
      expect(buf.gpuData[1]).toBe(1);
      expect(buf.gpuData[2]).toBe(2);
    });

    it("maps `channels: 'rgba'` to vec4 (0, 1, 2, 3)", function () {
      const buf = new MaterialUniformBuffer({ channels: "rgba" });
      const entry = buf.layout.get("channels");
      expect(entry.type).toBe("channelsVec4");
      expect(entry.size).toBe(4);
      expect(buf.gpuData[0]).toBe(0);
      expect(buf.gpuData[3]).toBe(3);
    });

    it("round-trips `channel` through the read facade", function () {
      const buf = new MaterialUniformBuffer({ channel: "g" });
      expect(buf._readValue("channel")).toBe("g");
    });

    it("round-trips `channels` through the read facade", function () {
      const buf = new MaterialUniformBuffer({ channels: "bgr" });
      expect(buf._readValue("channels")).toBe("bgr");
    });
  });

  describe("Material.AlphaMapType layout — fabric { image, channel, repeat }", function () {
    it("places channel at float 0 and repeat at float 2 (vec2 align)", function () {
      const buf = new MaterialUniformBuffer({
        image: "cesium://default",
        channel: "a",
        repeat: new Cartesian2(1.0, 1.0),
      });
      expect(buf.layout.get("image").offset).toBe(-1);
      expect(buf.layout.get("channel").offset).toBe(0);
      expect(buf.layout.get("repeat").offset).toBe(2);
      expect(buf.gpuData[0]).toBe(3); // "a" → 3
      expect(buf.gpuData[2]).toBe(1);
      expect(buf.gpuData[3]).toBe(1);
    });
  });

  describe("Material.BumpMapType layout — fabric { image, channel, strength, repeat }", function () {
    it("packs channel, strength, repeat contiguously — no phantom pad", function () {
      const buf = new MaterialUniformBuffer({
        image: "cesium://default",
        channel: "r",
        strength: 0.8,
        repeat: new Cartesian2(1.0, 1.0),
      });
      expect(buf.layout.get("channel").offset).toBe(0);
      expect(buf.layout.get("strength").offset).toBe(1);
      expect(buf.layout.get("repeat").offset).toBe(2);
      expect(buf.gpuData[0]).toBe(0);
      expect(buf.gpuData[1]).toBeCloseTo(0.8);
      expect(buf.gpuData[2]).toBe(1);
      expect(buf.gpuData[3]).toBe(1);
    });
  });

  describe("Material.NormalMapType layout — fabric { image, channels, strength, repeat }", function () {
    // WGSL places an f32 in the 4-byte tail of a vec3. Packer must match:
    // channels at floats 0-2, strength at float 3 (NOT 4), repeat at 4-5.
    it("fits strength in the vec3 tail at float 3, not past the pad", function () {
      const buf = new MaterialUniformBuffer({
        image: "cesium://default",
        channels: "rgb",
        strength: 0.8,
        repeat: new Cartesian2(1.0, 1.0),
      });
      expect(buf.layout.get("channels").offset).toBe(0);
      expect(buf.layout.get("channels").size).toBe(3);
      expect(buf.layout.get("strength").offset).toBe(3);
      expect(buf.layout.get("repeat").offset).toBe(4);
      expect(buf.gpuData[0]).toBe(0); // r=0
      expect(buf.gpuData[1]).toBe(1); // g=1
      expect(buf.gpuData[2]).toBe(2); // b=2
      expect(buf.gpuData[3]).toBeCloseTo(0.8);
      expect(buf.gpuData[4]).toBe(1);
      expect(buf.gpuData[5]).toBe(1);
    });
  });

  describe("Material.CheckerboardType layout — fabric { lightColor, darkColor, repeat }", function () {
    // Regression guard for the already-clean path so a future refactor
    // can't silently break vec4+vec4+vec2 packing.
    it("places two vec4s then a vec2 at floats 0/4/8", function () {
      const buf = new MaterialUniformBuffer({
        lightColor: new Color(1, 1, 1, 0.5),
        darkColor: new Color(0, 0, 0, 0.5),
        repeat: new Cartesian2(5, 5),
      });
      expect(buf.layout.get("lightColor").offset).toBe(0);
      expect(buf.layout.get("darkColor").offset).toBe(4);
      expect(buf.layout.get("repeat").offset).toBe(8);
      expect(buf.gpuData[0]).toBe(1);
      expect(buf.gpuData[3]).toBeCloseTo(0.5);
      expect(buf.gpuData[7]).toBeCloseTo(0.5);
      expect(buf.gpuData[8]).toBe(5);
      expect(buf.gpuData[9]).toBe(5);
    });
  });

  describe("Material.ImageType layout — fabric { image, repeat, color }", function () {
    // This was broken before the Session 36 fix — the WGSL struct declared
    // color BEFORE repeat, so fabric's repeat overwrote color.rg. The WGSL
    // struct now matches fabric order; this spec locks it in from the
    // JS side.
    it("places repeat at float 0 and color at float 4", function () {
      const buf = new MaterialUniformBuffer({
        image: "cesium://default",
        repeat: new Cartesian2(2, 3),
        color: new Color(1, 0, 0, 1),
      });
      expect(buf.layout.get("repeat").offset).toBe(0);
      expect(buf.layout.get("color").offset).toBe(4);
      expect(buf.gpuData[0]).toBe(2);
      expect(buf.gpuData[1]).toBe(3);
      expect(buf.gpuData[4]).toBe(1);
      expect(buf.gpuData[7]).toBe(1);
    });
  });

  describe("Material.FadeType layout — fabric { fadeInColor, fadeOutColor, maximumDistance, repeat, fadeDirection, time }", function () {
    it("places boolVec2 fadeDirection at float 10 and Cart2 time at float 12", function () {
      const buf = new MaterialUniformBuffer({
        fadeInColor: new Color(1, 0, 0, 1),
        fadeOutColor: new Color(0, 0, 0, 0),
        maximumDistance: 0.5,
        repeat: true,
        fadeDirection: { x: true, y: false },
        time: new Cartesian2(0.5, 0.25),
      });
      expect(buf.layout.get("fadeInColor").offset).toBe(0);
      expect(buf.layout.get("fadeOutColor").offset).toBe(4);
      expect(buf.layout.get("maximumDistance").offset).toBe(8);
      expect(buf.layout.get("repeat").offset).toBe(9);
      expect(buf.layout.get("fadeDirection").offset).toBe(10);
      expect(buf.layout.get("time").offset).toBe(12);
      expect(buf.gpuData[8]).toBeCloseTo(0.5);
      expect(buf.gpuData[9]).toBe(1); // repeat bool true
      expect(buf.gpuData[10]).toBe(1); // fadeDirection.x true
      expect(buf.gpuData[11]).toBe(0); // fadeDirection.y false
      expect(buf.gpuData[12]).toBeCloseTo(0.5);
      expect(buf.gpuData[13]).toBeCloseTo(0.25);
    });
  });

  describe("Material.EmissionMapType layout — fabric { image, channels, repeat }", function () {
    it("places channels:vec3 at float 0 and repeat at float 4", function () {
      const buf = new MaterialUniformBuffer({
        image: "cesium://default",
        channels: "rgb",
        repeat: new Cartesian2(1, 1),
      });
      expect(buf.layout.get("channels").offset).toBe(0);
      expect(buf.layout.get("channels").size).toBe(3);
      expect(buf.layout.get("repeat").offset).toBe(4);
      expect(buf.gpuData[0]).toBe(0);
      expect(buf.gpuData[1]).toBe(1);
      expect(buf.gpuData[2]).toBe(2);
      expect(buf.gpuData[4]).toBe(1);
      expect(buf.gpuData[5]).toBe(1);
    });
  });

  describe("non-channel strings still classify as textures", function () {
    // An asset URL or base-64 data URI must not be mistaken for a channel
    // shorthand even if its first char happens to be r/g/b/a.
    it("treats `image: 'rainbow.png'` as a texture, not a channel", function () {
      const buf = new MaterialUniformBuffer({ image: "rainbow.png" });
      expect(buf.layout.get("image").offset).toBe(-1);
    });

    it("treats a 5+ char `channels` string as a texture", function () {
      const buf = new MaterialUniformBuffer({ channels: "rgbag" });
      expect(buf.layout.get("channels").offset).toBe(-1);
    });
  });
});
