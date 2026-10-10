// webgpu-stub-framebuffer-transfers.spec.mjs - what the WebGPU WebGL-stub does when a recorded
// framebuffer is read: framebuffer-to-texture copies, blitFramebuffer and readPixelsAsync, with the
// refusals each names. Pure Node: no browser, no build, no GPU.
//
//   node --test Tools/visual-regression/webgpu-stub-framebuffer-transfers.spec.mjs
//
// @purpose Pins what the WebGL compatibility stub does with a recorded framebuffer when it is read: a framebuffer-to-texture copy reads the READ binding and refuses by name what it cannot address, a blit copies only between two different single-sample textures and never copies depth or stencil, and readPixelsAsync reads color attachment 0 in texture row order and refuses by name.
// @status ACTIVE
//
// -- HOW THIS IS TESTED ------------------------------------------------------
//
// Nothing here greps source, and no framebuffer enum is a literal on a path
// that goes through `Framebuffer.js`: the classes read `gl.FRAMEBUFFER`,
// `gl.COLOR_ATTACHMENT0` and the rest from the stub, as in the engine. The
// stub is built the way the context builds it (`buildWebGLCompatibilityStubFor`
// over the real `WebGPUContext.prototype` copy methods) and runs against one
// recording fake `GPUDevice` with a texel model (`lib/stub-framebuffer-rig.mjs`).
// A submit that touches a texture whose `destroy()` was requested is a
// violation, so "the attachment is still usable" is read from the device, not
// from a count of calls.
//
// Assertions are on recorded GPU commands, texel values, device events and the
// debug receipt, never on `logUsage` counts (it logs once per method name, and
// only in debug builds).
//
// -- RUNNER HOME --------------------------------------------------------------
//
// `test-engine-node` (package.json; the seat owns the line).

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  RGBA,
  TEXTURE_2D,
  UNSIGNED_BYTE,
  disarmReceipt,
  makeHarness,
  pixelAt,
} from "./lib/stub-wired-harness.mjs";
import {
  COPY_USAGE,
  CUBE_MAP_FACES,
  GL,
  MultisampleFramebuffer,
  PixelFormat,
  RENDER_ATTACHMENT_USAGE,
  RenderbufferFormat,
  SIZE,
  TEXTURE_CUBE_MAP_NEGATIVE_Y,
  TEXTURE_CUBE_MAP_POSITIVE_X,
  ZEROS,
  assertRegion,
  attachRaw,
  commandCount,
  createShaderStubs,
  destination,
  fillTexels,
  framebuffer,
  ownedTexture,
  rawAttachment,
  renderbuffer,
  rig,
  snapshot,
  startFrame,
  submitCount,
  texel,
} from "./lib/stub-framebuffer-rig.mjs";

afterEach(() => disarmReceipt());

// -- framebuffer-to-texture copies -------------------------------------------------------

describe("a framebuffer-to-texture copy", () => {
  it("reads color attachment 0 of the read framebuffer at the requested region and writes at the requested offset", () => {
    const r = rig();
    const fb = framebuffer(r, {
      colorTextures: [ownedTexture(r, 3).owner, ownedTexture(r, 4).owner],
      destroyAttachments: false,
    });
    const d = destination(r);
    fb.bindRead();

    r.stubs.copyTexSubImage2D(TEXTURE_2D, 0, 4, 2, 1, 2, 3, 2);

    assertRegion(d.native, { x: 1, y: 2 }, 4, 2, 3, 2, 3);
    assert.deepEqual(
      pixelAt(d.native, 0, 0),
      [0, 0, 0, 0],
      "outside the region is untouched",
    );
    assert.equal(r.device.violations.length, 0);
    assert.equal(r.receipt.counts["copyTexSubImage2D.offFrame.submitted"], 1);
  });

  it("outside a frame is submitted at once; inside a frame it is recorded in the frame encoder after earlier work, and submits nothing", () => {
    const r = rig();
    const color = ownedTexture(r, 3);
    const fb = framebuffer(r, {
      colorTextures: [color.owner],
      destroyAttachments: false,
    });
    const d = destination(r);
    fb.bindRead();
    const earlier = r.device.createTexture({
      size: { width: SIZE, height: SIZE },
      format: "rgba8unorm",
      usage: COPY_USAGE,
    });

    r.stubs.copyTexSubImage2D(TEXTURE_2D, 0, 0, 0, 0, 0, 2, 2);
    assert.equal(submitCount(r.device), 1, "submitted before the call returns");
    assertRegion(d.native, { x: 0, y: 0 }, 0, 0, 2, 2, 3);

    const frame = startFrame(r);
    frame.copyTextureToTexture(
      { texture: earlier, origin: { x: 0, y: 0 } },
      { texture: earlier, origin: { x: 4, y: 4 } },
      { width: 1, height: 1 },
    );
    const submitsBefore = submitCount(r.device);
    r.stubs.copyTexSubImage2D(TEXTURE_2D, 0, 4, 4, 2, 2, 2, 2);

    assert.equal(
      submitCount(r.device),
      submitsBefore,
      "inside a frame the copy submits nothing",
    );
    assert.equal(frame.copies.length, 2);
    assert.equal(
      frame.copies[0].source,
      earlier,
      "the earlier work stays first",
    );
    assert.equal(frame.copies[1].source, color.native);
    assert.equal(frame.copies[1].destination, d.native);
    assert.deepEqual(frame.copies[1].sourceOrigin, { x: 2, y: 2 });
    assert.deepEqual(frame.copies[1].destinationOrigin, { x: 4, y: 4 });
    assert.deepEqual(frame.copies[1].size, { width: 2, height: 2 });
  });

  it("copyTexImage2D reads the same attachment and lands at (0, 0)", () => {
    const r = rig();
    const fb = framebuffer(r, {
      colorTextures: [ownedTexture(r, 3).owner],
      destroyAttachments: false,
    });
    const d = destination(r);
    fb.bindRead();

    r.stubs.copyTexImage2D(TEXTURE_2D, 0, RGBA, 2, 3, 3, 2, 0);

    assertRegion(d.native, { x: 2, y: 3 }, 0, 0, 3, 2, 3);
  });

  describe("with a null READ binding", () => {
    /** Leave a framebuffer in the draw and legacy bindings only. */
    function staleLegacySlot(r) {
      const stale = ownedTexture(r, 5);
      framebuffer(r, {
        colorTextures: [stale.owner],
        destroyAttachments: false,
      })._bind();
      r.stubs.bindFramebuffer(GL.READ_FRAMEBUFFER, null);
      return stale;
    }

    it("reads nothing outside a frame, never the framebuffer left in another binding and never the canvas", () => {
      const r = rig();
      staleLegacySlot(r);
      // A canvas that could be copied from, so a read of it would show.
      const canvas = r.device.createTexture({
        size: { width: SIZE, height: SIZE },
        format: "rgba8unorm",
        usage: COPY_USAGE,
      });
      fillTexels(canvas, 9);
      r.host._context = {
        getCurrentTexture() {
          r.canvasRequests = (r.canvasRequests ?? 0) + 1;
          return canvas;
        },
      };
      const d = destination(r);
      const commands = commandCount(r.device);
      const submits = submitCount(r.device);

      r.stubs.copyTexSubImage2D(TEXTURE_2D, 0, 0, 0, 0, 0, 4, 4);
      r.stubs.copyTexImage2D(TEXTURE_2D, 0, RGBA, 0, 0, 4, 4, 0);

      assert.equal(commandCount(r.device), commands);
      assert.equal(submitCount(r.device), submits);
      assert.deepEqual(snapshot(d.native), ZEROS);
      assert.equal(r.canvasRequests ?? 0, 0, "no canvas outside a frame");
    });

    it("reads the canvas inside a frame, never the framebuffer left in another binding", () => {
      const r = rig();
      const stale = staleLegacySlot(r);
      const canvas = r.device.createTexture({
        size: { width: SIZE, height: SIZE },
        format: "rgba8unorm",
        usage: COPY_USAGE,
      });
      fillTexels(canvas, 9);
      r.host._context = { getCurrentTexture: () => canvas };
      const d = destination(r);
      const frame = startFrame(r);

      r.stubs.copyTexSubImage2D(TEXTURE_2D, 0, 0, 0, 0, 0, 4, 4);

      assert.equal(frame.copies.length, 1);
      assert.equal(frame.copies[0].source, canvas);
      assert.notEqual(frame.copies[0].source, stale.native);
      r.device.queue.submit([frame.finish()]);
      assertRegion(d.native, { x: 0, y: 0 }, 0, 0, 4, 4, 9);
    });

    it("is refused by name inside a frame when the canvas cannot be copied from, and records nothing", () => {
      const r = rig();
      staleLegacySlot(r);
      const d = destination(r);
      const frame = startFrame(r);

      r.stubs.copyTexSubImage2D(TEXTURE_2D, 0, 0, 0, 0, 0, 2, 2);

      assert.equal(frame.copies.length, 0);
      assert.equal(r.receipt.counts["copyTexSubImage2D.inFrame.refused"], 1);
      assert.equal(
        r.receipt.counts["copyTexSubImage2D.refused.sourceUsage"],
        1,
      );
      assert.deepEqual(snapshot(d.native), ZEROS);
    });
  });

  describe("that cannot address its destination or its source", () => {
    const REFUSALS = [
      {
        name: "a destination level other than 0",
        reason: "destinationLevel",
        arrange: () => ({ level: 1 }),
      },
      {
        name: "a destination that is a cube map face",
        reason: "destinationTarget",
        arrange: (face) => ({ target: face }),
        faces: CUBE_MAP_FACES,
      },
      {
        name: "a source attached at a cube map face",
        reason: "sourceTarget",
        arrange: (face) => ({ sourceTarget: face }),
        faces: [TEXTURE_CUBE_MAP_POSITIVE_X, TEXTURE_CUBE_MAP_NEGATIVE_Y],
      },
      {
        name: "a source attached at a level other than 0",
        reason: "sourceTarget",
        arrange: () => ({ sourceLevel: 1 }),
      },
    ];

    for (const { name, arrange, reason, faces = [undefined] } of REFUSALS) {
      for (const face of faces) {
        for (const entryPoint of ["copyTexSubImage2D", "copyTexImage2D"]) {
          const label =
            face === undefined ? name : `${name} (0x${face.toString(16)})`;
          it(`${entryPoint} refuses ${label} by name: no GPU command, texels unchanged`, () => {
            const r = rig();
            const {
              target = TEXTURE_2D,
              level = 0,
              sourceTarget = TEXTURE_2D,
              sourceLevel = 0,
            } = arrange(face);
            const source = ownedTexture(r, 3);
            const fbo = attachRaw(r, source.wrapper, {
              textarget: sourceTarget,
              level: sourceLevel,
            });
            const d = destination(r);
            const before = snapshot(d.native);
            const commands = commandCount(r.device);
            const submits = submitCount(r.device);
            r.stubs.bindFramebuffer(GL.READ_FRAMEBUFFER, fbo);
            const frame = startFrame(r);
            const call = () =>
              entryPoint === "copyTexSubImage2D"
                ? r.stubs.copyTexSubImage2D(target, level, 0, 0, 0, 0, 4, 4)
                : r.stubs.copyTexImage2D(target, level, RGBA, 0, 0, 4, 4, 0);

            call(); // inside a frame
            r.host._currentCommandEncoder = null;
            call(); // and outside one

            assert.equal(
              commandCount(r.device) - commands,
              0,
              "no GPU command",
            );
            assert.equal(frame.copies.length, 0);
            assert.equal(submitCount(r.device), submits);
            assert.deepEqual(snapshot(d.native), before);
            assert.equal(
              r.receipt.counts[`${entryPoint}.refused.${reason}`],
              2,
            );
          });
        }
      }
    }
  });

  describe("that WebGPU would reject", () => {
    it("a renderbuffer source without copy usage records nothing and names sourceUsage", () => {
      const r = rig();
      const rb = renderbuffer(r, RenderbufferFormat.RGBA8);
      const fb = framebuffer(r, {
        colorRenderbuffers: [rb.buffer],
        destroyAttachments: false,
      });
      const d = destination(r);
      fb.bindRead();

      r.stubs.copyTexSubImage2D(TEXTURE_2D, 0, 0, 0, 0, 0, 4, 4);

      assert.equal(commandCount(r.device), 0);
      assert.equal(submitCount(r.device), 0);
      assert.equal(r.receipt.counts["copyTexSubImage2D.offFrame.refused"], 1);
      assert.equal(
        r.receipt.counts["copyTexSubImage2D.refused.sourceUsage"],
        1,
      );
      assert.deepEqual(snapshot(d.native), ZEROS);
    });

    it("a source equal to the destination names sameTexture", () => {
      const r = rig();
      const both = ownedTexture(r, 3);
      const fb = framebuffer(r, {
        colorTextures: [both.owner],
        destroyAttachments: false,
      });
      r.stubs.bindTexture(TEXTURE_2D, both.wrapper);
      fb.bindRead();

      r.stubs.copyTexSubImage2D(TEXTURE_2D, 0, 4, 4, 0, 0, 2, 2);

      assert.equal(commandCount(r.device), 0);
      assert.equal(
        r.receipt.counts["copyTexSubImage2D.refused.sameTexture"],
        1,
      );
    });

    it("a format mismatch names formatMismatch", () => {
      const r = rig();
      const odd = rawAttachment(r, { format: "bgra8unorm" });
      r.stubs.bindFramebuffer(GL.READ_FRAMEBUFFER, attachRaw(r, odd.wrapper));
      destination(r);

      r.stubs.copyTexSubImage2D(TEXTURE_2D, 0, 0, 0, 0, 0, 2, 2);

      assert.equal(commandCount(r.device), 0);
      assert.equal(
        r.receipt.counts["copyTexSubImage2D.refused.formatMismatch"],
        1,
      );
    });

    it("a render pass open on the frame encoder names openRenderPass and records nothing", () => {
      const r = rig();
      const fb = framebuffer(r, {
        colorTextures: [ownedTexture(r, 3).owner],
        destroyAttachments: false,
      });
      const d = destination(r);
      fb.bindRead();
      const frame = startFrame(r);
      r.host._currentRenderPassEncoder = {};

      r.stubs.copyTexSubImage2D(TEXTURE_2D, 0, 0, 0, 0, 0, 2, 2);

      assert.equal(frame.copies.length, 0);
      assert.equal(
        r.receipt.counts["copyTexSubImage2D.refused.openRenderPass"],
        1,
      );
      assert.deepEqual(snapshot(d.native), ZEROS);
    });
  });
});

// -- blitFramebuffer ------------------------------------------------------------------------

describe("blitFramebuffer", () => {
  function plainBlit() {
    const r = rig();
    const read = ownedTexture(r, 1);
    const draw = ownedTexture(r, 2);
    const fbRead = framebuffer(r, {
      colorTextures: [read.owner],
      destroyAttachments: false,
    });
    const fbDraw = framebuffer(r, {
      colorTextures: [draw.owner],
      destroyAttachments: false,
    });
    fbRead.bindRead();
    fbDraw.bindDraw();
    return { r, read, draw, frame: startFrame(r) };
  }
  const blit = (
    r,
    mask = GL.COLOR_BUFFER_BIT,
    rect = [0, 0, 4, 4, 2, 2, 6, 6],
  ) => r.stubs.blitFramebuffer(...rect, mask, r.stubs.NEAREST);

  it("copies exactly the region between two different single-sample color textures, in the frame encoder", () => {
    const { r, read, draw, frame } = plainBlit();

    blit(r);

    assert.equal(frame.copies.length, 1);
    const [copy] = frame.copies;
    assert.equal(copy.source, read.native);
    assert.equal(copy.destination, draw.native);
    assert.deepEqual(copy.sourceOrigin, { x: 0, y: 0 });
    assert.deepEqual(copy.destinationOrigin, { x: 2, y: 2 });
    assert.deepEqual(copy.size, { width: 4, height: 4 });
    r.device.queue.submit([frame.finish()]);
    assertRegion(draw.native, { x: 0, y: 0 }, 2, 2, 4, 4, 1);
    assert.equal(r.device.violations.length, 0);
  });

  describe("records nothing, without a violation, and names why", () => {
    const REFUSED = [
      {
        reason: "sameTexture",
        arrange: ({ r, read }) =>
          r.stubs.framebufferTexture2D(
            GL.DRAW_FRAMEBUFFER,
            GL.COLOR_ATTACHMENT0,
            TEXTURE_2D,
            read.wrapper,
            0,
          ),
      },
      {
        reason: "sampleCount",
        arrange: ({ r }) =>
          r.stubs.framebufferTexture2D(
            GL.READ_FRAMEBUFFER,
            GL.COLOR_ATTACHMENT0,
            TEXTURE_2D,
            rawAttachment(r, {
              sampleCount: 4,
              usage: COPY_USAGE | RENDER_ATTACHMENT_USAGE,
            }).wrapper,
            0,
          ),
      },
      { reason: "flipped", rect: [0, 0, 4, 4, 6, 6, 2, 2] },
      { reason: "scaled", rect: [0, 0, 4, 4, 0, 0, 8, 8] },
      {
        reason: "defaultFramebuffer",
        arrange: ({ r }) => r.stubs.bindFramebuffer(GL.DRAW_FRAMEBUFFER, null),
      },
      {
        reason: "openRenderPass",
        arrange: ({ r }) => {
          r.host._currentRenderPassEncoder = {};
        },
      },
      {
        reason: "sourceTarget",
        arrange: ({ r, read }) =>
          r.stubs.framebufferTexture2D(
            GL.READ_FRAMEBUFFER,
            GL.COLOR_ATTACHMENT0,
            TEXTURE_CUBE_MAP_NEGATIVE_Y,
            read.wrapper,
            0,
          ),
      },
      {
        reason: "destinationTarget",
        arrange: ({ r, draw }) =>
          r.stubs.framebufferTexture2D(
            GL.DRAW_FRAMEBUFFER,
            GL.COLOR_ATTACHMENT0,
            TEXTURE_2D,
            draw.wrapper,
            2,
          ),
      },
    ];

    for (const { reason, arrange, rect } of REFUSED) {
      it(reason, () => {
        const context = plainBlit();
        const { r, frame, draw } = context;
        arrange?.(context);
        const before = snapshot(draw.native);

        blit(r, GL.COLOR_BUFFER_BIT, rect);

        assert.equal(frame.copies.length, 0);
        assert.equal(r.receipt.counts[`blitFramebuffer.refused.${reason}`], 1);
        assert.equal(r.receipt.counts["blitFramebuffer.recorded"] ?? 0, 0);
        r.device.queue.submit([frame.finish()]);
        assert.deepEqual(snapshot(draw.native), before);
        assert.equal(r.device.violations.length, 0);
      });
    }

    it("noEncoder, outside a frame", () => {
      const { r, frame } = plainBlit();
      r.host._currentCommandEncoder = null;

      blit(r);

      assert.equal(frame.copies.length, 0);
      assert.equal(r.receipt.counts["blitFramebuffer.noEncoder"], 1);
      assert.equal(r.device.violations.length, 0);
    });

    // The two refusals only the context-validated copy makes. A raw encoder
    // copy would record both and leave the GPU to reject them.
    it("sourceUsage, a single-sample color renderbuffer read: it carries no copy usage", () => {
      const r = rig();
      const rb = renderbuffer(r, RenderbufferFormat.RGBA8);
      const fbRead = framebuffer(r, {
        colorRenderbuffers: [rb.buffer],
        destroyAttachments: false,
      });
      const draw = ownedTexture(r, 2);
      const fbDraw = framebuffer(r, {
        colorTextures: [draw.owner],
        destroyAttachments: false,
      });
      fbRead.bindRead();
      fbDraw.bindDraw();
      const frame = startFrame(r);
      const before = snapshot(draw.native);

      blit(r);

      assert.equal(frame.copies.length, 0);
      assert.equal(r.receipt.counts["blitFramebuffer.refused.sourceUsage"], 1);
      assert.equal(r.receipt.counts["blitFramebuffer.recorded"] ?? 0, 0);
      r.device.queue.submit([frame.finish()]);
      assert.deepEqual(snapshot(draw.native), before);
      assert.equal(r.device.violations.length, 0);
    });

    it("formatMismatch, a bgra8unorm read into an rgba8unorm draw", () => {
      const r = rig();
      const odd = rawAttachment(r, { format: "bgra8unorm" });
      // attachRaw rebinds FRAMEBUFFER, so it runs before either binding.
      const readFbo = attachRaw(r, odd.wrapper);
      const draw = ownedTexture(r, 2);
      const fbDraw = framebuffer(r, {
        colorTextures: [draw.owner],
        destroyAttachments: false,
      });
      r.stubs.bindFramebuffer(GL.READ_FRAMEBUFFER, readFbo);
      fbDraw.bindDraw();
      const frame = startFrame(r);
      const before = snapshot(draw.native);

      blit(r);

      assert.equal(frame.copies.length, 0);
      assert.equal(
        r.receipt.counts["blitFramebuffer.refused.formatMismatch"],
        1,
      );
      assert.equal(r.receipt.counts["blitFramebuffer.recorded"] ?? 0, 0);
      r.device.queue.submit([frame.finish()]);
      assert.deepEqual(snapshot(draw.native), before);
      assert.equal(r.device.violations.length, 0);
    });

    it("defaultFramebuffer, a null DRAW binding after FRAMEBUFFER bound one: the framebuffer left in the other slots is not drawn", () => {
      const r = rig();
      const x = ownedTexture(r, 4);
      const fbX = framebuffer(r, {
        colorTextures: [x.owner],
        destroyAttachments: false,
      });
      r.stubs.bindFramebuffer(GL.FRAMEBUFFER, fbX._framebuffer);
      r.stubs.bindFramebuffer(GL.DRAW_FRAMEBUFFER, null);
      const frame = startFrame(r);
      const before = snapshot(x.native);

      blit(r);

      assert.equal(frame.copies.length, 0);
      assert.equal(
        r.receipt.counts["blitFramebuffer.refused.defaultFramebuffer"],
        1,
      );
      assert.equal(
        r.receipt.counts["blitFramebuffer.refused.sameTexture"] ?? 0,
        0,
      );
      r.device.queue.submit([frame.finish()]);
      assert.deepEqual(snapshot(x.native), before);
      assert.equal(r.device.violations.length, 0);
    });
  });

  describe("on a context that validates nothing, the stub's own guards still hold", () => {
    function naive() {
      const h = makeHarness({ frameEncoder: null });
      const frame = h.device.createCommandEncoder({ label: "frame" });
      h.state.currentCommandEncoder = frame;
      const stubs = {
        ...h.stubs,
        ...createShaderStubs(h.state, () => {}),
        NEAREST: GL.NEAREST,
      };
      const texture = () => {
        const wrapper = stubs.createTexture();
        stubs.bindTexture(TEXTURE_2D, wrapper);
        stubs.texImage2D(
          TEXTURE_2D,
          0,
          RGBA,
          SIZE,
          SIZE,
          0,
          RGBA,
          UNSIGNED_BYTE,
          null,
        );
        return wrapper;
      };
      const attach = (target, wrapper) => {
        const fbo = stubs.createFramebuffer();
        stubs.bindFramebuffer(target, fbo);
        stubs.framebufferTexture2D(
          target,
          GL.COLOR_ATTACHMENT0,
          TEXTURE_2D,
          wrapper,
          0,
        );
      };
      const blitNow = () =>
        stubs.blitFramebuffer(
          0,
          0,
          4,
          4,
          0,
          0,
          4,
          4,
          GL.COLOR_BUFFER_BIT,
          GL.NEAREST,
        );
      return { h, frame, texture, attach, blitNow };
    }

    it("records the copy between two different single-sample textures", () => {
      const { frame, texture, attach, blitNow } = naive();
      attach(GL.READ_FRAMEBUFFER, texture());
      attach(GL.DRAW_FRAMEBUFFER, texture());
      blitNow();
      assert.equal(frame.copies.length, 1);
    });

    it("refuses the same texture read and drawn", () => {
      const { frame, texture, attach, blitNow } = naive();
      const same = texture();
      attach(GL.READ_FRAMEBUFFER, same);
      attach(GL.DRAW_FRAMEBUFFER, same);
      blitNow();
      assert.equal(frame.copies.length, 0);
    });

    it("refuses a blit while a render pass is open", () => {
      const { h, frame, texture, attach, blitNow } = naive();
      attach(GL.READ_FRAMEBUFFER, texture());
      attach(GL.DRAW_FRAMEBUFFER, texture());
      h.state.currentRenderPassEncoder = {};
      blitNow();
      assert.equal(frame.copies.length, 0);
    });

    it("refuses a multisample source: a resolve is not a copy", () => {
      const { h, frame, texture, attach, blitNow } = naive();
      const native = h.device.createTexture({
        size: { width: SIZE, height: SIZE },
        format: "rgba8unorm",
        usage: COPY_USAGE,
        sampleCount: 4,
      });
      attach(GL.READ_FRAMEBUFFER, { _webgpuTexture: { texture: native } });
      attach(GL.DRAW_FRAMEBUFFER, texture());
      blitNow();
      assert.equal(frame.copies.length, 0);
    });
  });

  describe("the mask", () => {
    it("never copies depth or stencil: each bit present is reported by name, beside the color copy", () => {
      const { r, frame } = plainBlit();

      blit(
        r,
        GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT | GL.STENCIL_BUFFER_BIT,
      );

      assert.equal(frame.copies.length, 1, "the color part still records");
      assert.equal(r.receipt.counts["blitFramebuffer.refused.depthMask"], 1);
      assert.equal(r.receipt.counts["blitFramebuffer.refused.stencilMask"], 1);
    });

    it("copies no color without COLOR_BUFFER_BIT, and reports the depth bit alone", () => {
      const { r, frame } = plainBlit();

      blit(r, GL.DEPTH_BUFFER_BIT);

      assert.equal(frame.copies.length, 0);
      assert.equal(r.receipt.counts["blitFramebuffer.refused.depthMask"], 1);
      assert.equal(
        r.receipt.counts["blitFramebuffer.refused.stencilMask"] ?? 0,
        0,
      );
    });

    it("reports the stencil bit alone by its own name", () => {
      const { r, frame } = plainBlit();

      blit(r, GL.COLOR_BUFFER_BIT | GL.STENCIL_BUFFER_BIT);

      assert.equal(frame.copies.length, 1);
      assert.equal(r.receipt.counts["blitFramebuffer.refused.stencilMask"], 1);
      assert.equal(
        r.receipt.counts["blitFramebuffer.refused.depthMask"] ?? 0,
        0,
      );
    });
  });

  describe("through MultisampleFramebuffer.blitFramebuffers", () => {
    function multisample(r, blitStencil) {
      const color = renderbuffer(r, RenderbufferFormat.RGBA8, { samples: 4 });
      const depthStencil = renderbuffer(
        r,
        RenderbufferFormat.DEPTH24_STENCIL8,
        { samples: 4 },
      );
      const resolved = ownedTexture(r, 2);
      const depthStencilTexture = {
        _texture: r.stubs.createTexture(),
        _target: TEXTURE_2D,
        pixelFormat: PixelFormat.DEPTH_STENCIL,
        destroy() {},
      };
      const msfb = new MultisampleFramebuffer({
        context: r.context,
        width: SIZE,
        height: SIZE,
        colorRenderbuffers: [color.buffer],
        colorTextures: [resolved.owner],
        depthStencilRenderbuffer: depthStencil.buffer,
        depthStencilTexture,
        destroyAttachments: false,
      });
      const frame = startFrame(r);
      const before = snapshot(resolved.native);
      msfb.blitFramebuffers(r.context, blitStencil);
      return { frame, resolved, before };
    }

    it("refuses the multisample resolve by name, reports depth and stencil, and leaves the bindings at the default framebuffer", () => {
      const r = rig();
      const { frame, resolved, before } = multisample(r, true);

      assert.equal(frame.copies.length, 0, "no copy stands in for a resolve");
      assert.equal(r.receipt.counts["blitFramebuffer.refused.sampleCount"], 1);
      assert.equal(r.receipt.counts["blitFramebuffer.refused.depthMask"], 1);
      assert.equal(r.receipt.counts["blitFramebuffer.refused.stencilMask"], 1);
      assert.deepEqual(snapshot(resolved.native), before);
      assert.equal(r.device.violations.length, 0);
      assert.equal(r.host._boundReadFramebuffer, null);
      assert.equal(r.host._boundDrawFramebuffer, null);
    });

    it("reports no stencil bit when the stencil is not blitted", () => {
      const r = rig();
      multisample(r, false);

      assert.equal(r.receipt.counts["blitFramebuffer.refused.depthMask"], 1);
      assert.equal(
        r.receipt.counts["blitFramebuffer.refused.stencilMask"] ?? 0,
        0,
      );
    });
  });
});

// -- readPixelsAsync -------------------------------------------------------------------------------

describe("readPixelsAsync", () => {
  const read = (r, x, y, w, h, pixels) =>
    r.stubs.readPixelsAsync(x, y, w, h, RGBA, UNSIGNED_BYTE, pixels);

  it("fills the array from color attachment 0 of the READ binding in texture row order, with no flip", async () => {
    const r = rig();
    framebuffer(r, {
      colorTextures: [ownedTexture(r, 5).owner, ownedTexture(r, 6).owner],
      destroyAttachments: false,
    }).bindRead();
    const pixels = new Uint8Array(3 * 2 * 4);

    const ok = await read(r, 2, 3, 3, 2, pixels);

    assert.equal(ok, true);
    for (let row = 0; row < 2; row++) {
      for (let column = 0; column < 3; column++) {
        const at = (row * 3 + column) * 4;
        assert.deepEqual(
          Array.from(pixels.subarray(at, at + 4)),
          texel(5, 2 + column, 3 + row),
          `output row ${row} is texture row ${3 + row}`,
        );
      }
    }
    assert.equal(r.device.violations.length, 0);
    assert.ok(
      r.device.buffers.every((buffer) => buffer.destroyed),
      "the staging buffer is released",
    );
  });

  const REFUSALS = [
    {
      reason: "defaultFramebuffer",
      name: "the READ binding is null, even when another binding holds a framebuffer",
      arrange: (r) => {
        framebuffer(r, {
          colorTextures: [ownedTexture(r, 5).owner],
          destroyAttachments: false,
        })._bind();
        r.stubs.bindFramebuffer(GL.READ_FRAMEBUFFER, null);
      },
    },
    {
      reason: "noColorAttachment",
      name: "nothing is attached",
      arrange: (r) =>
        r.stubs.bindFramebuffer(
          GL.READ_FRAMEBUFFER,
          r.stubs.createFramebuffer(),
        ),
    },
    {
      reason: "sourceTarget",
      name: "the attachment is a cube map face",
      arrange: (r) =>
        r.stubs.bindFramebuffer(
          GL.READ_FRAMEBUFFER,
          attachRaw(r, ownedTexture(r, 5).wrapper, {
            textarget: TEXTURE_CUBE_MAP_NEGATIVE_Y,
          }),
        ),
    },
    {
      reason: "sourceTarget",
      name: "the attachment is a level other than 0",
      arrange: (r) =>
        r.stubs.bindFramebuffer(
          GL.READ_FRAMEBUFFER,
          attachRaw(r, ownedTexture(r, 5).wrapper, { level: 1 }),
        ),
    },
    {
      reason: "sourceUsage",
      name: "the attachment is a renderbuffer without copy usage",
      arrange: (r) =>
        framebuffer(r, {
          colorRenderbuffers: [
            renderbuffer(r, RenderbufferFormat.RGBA8).buffer,
          ],
          destroyAttachments: false,
        }).bindRead(),
    },
    {
      reason: "sampleCount",
      name: "the attachment is multisample",
      arrange: (r) =>
        r.stubs.bindFramebuffer(
          GL.READ_FRAMEBUFFER,
          attachRaw(r, rawAttachment(r, { sampleCount: 4 }).wrapper),
        ),
    },
  ];

  for (const { reason, name, arrange } of REFUSALS) {
    it(`resolves false and records no GPU command when ${name}`, async () => {
      const r = rig();
      arrange(r);
      const encoders = r.device.encodersCreated.length;
      const pixels = new Uint8Array(2 * 2 * 4);

      const ok = await read(r, 0, 0, 2, 2, pixels);

      assert.equal(ok, false);
      assert.equal(
        r.device.encodersCreated.length,
        encoders,
        "no command encoder",
      );
      assert.deepEqual(Array.from(pixels), new Array(16).fill(0));
      assert.equal(r.receipt.counts[`readPixelsAsync.refused.${reason}`], 1);
    });
  }
});
