// webgpu-stub-framebuffer-semantics.spec.mjs - what the WebGPU WebGL-stub names and keeps for
// the real Framebuffer.js, MultisampleFramebuffer.js and Renderbuffer.js: the enums, the bindings,
// the attachments, and what deleting a framebuffer leaves alone. Pure Node: no browser, no build,
// no GPU.
//
//   node --test Tools/visual-regression/webgpu-stub-framebuffer-semantics.spec.mjs
//
// @purpose Pins that on the WebGL compatibility stub the real framebuffer classes behave as on WebGL: the framebuffer enums are named, bindings split read and draw, an attachment is recorded at color attachment 0 and never replaced by a higher or a depth/stencil one, deleting a framebuffer destroys no attachment, and an atlas growth through Framebuffer.js carries every earlier image before its one owner-driven destruction.
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
  pixelAt,
} from "./lib/stub-wired-harness.mjs";
import {
  GL,
  RenderbufferFormat,
  ZEROS,
  assertRegion,
  commandCount,
  destination,
  destroysOf,
  engineTexture,
  framebuffer,
  liveTextures,
  ownedTexture,
  renderbuffer,
  rig,
  snapshot,
  tracedRig,
} from "./lib/stub-framebuffer-rig.mjs";
import { copySourceDestroyOrder } from "./lib/stub-texture-trace.mjs";

afterEach(() => disarmReceipt());

// -- the enums -------------------------------------------------------------------

describe("the enums the stub names", () => {
  it("answers every framebuffer enum the classes read with its WebGL value", () => {
    const { stubs } = rig();
    for (const [name, value] of Object.entries(GL)) {
      assert.equal(stubs[name], value, name);
    }
  });

  it("records a Framebuffer's color texture as color attachment 0, at the target it was attached at", () => {
    const r = rig();
    const color = ownedTexture(r, 1);
    const fb = framebuffer(r, {
      colorTextures: [color.owner],
      destroyAttachments: false,
    });

    const recorded = fb._framebuffer;
    assert.equal(recorded._colorAttachment, color.wrapper);
    assert.equal(recorded._colorAttachmentTarget, TEXTURE_2D);
    assert.equal(recorded._colorAttachmentLevel, 0);
    assert.equal(fb.status, GL.FRAMEBUFFER_COMPLETE);
  });

  it("records a Framebuffer's color renderbuffer as color attachment 0", () => {
    const r = rig();
    const rb = renderbuffer(r, RenderbufferFormat.RGBA8);
    const fb = framebuffer(r, {
      colorRenderbuffers: [rb.buffer],
      destroyAttachments: false,
    });

    assert.equal(
      fb._framebuffer._colorAttachment,
      rb.buffer._getRenderbuffer(),
    );
    assert.equal(fb._framebuffer._colorAttachment._texture, rb.native);
  });
});

// -- bindings --------------------------------------------------------------------

describe("which framebuffer each target binds", () => {
  it("FRAMEBUFFER binds read and draw, READ_FRAMEBUFFER and DRAW_FRAMEBUFFER one each, and null the default", () => {
    const r = rig();
    const a = framebuffer(r, {
      colorTextures: [ownedTexture(r, 1).owner],
      destroyAttachments: false,
    });
    const b = framebuffer(r, {
      colorTextures: [ownedTexture(r, 2).owner],
      destroyAttachments: false,
    });

    a._bind();
    assert.equal(r.host._boundReadFramebuffer, a._framebuffer);
    assert.equal(r.host._boundDrawFramebuffer, a._framebuffer);

    b.bindRead();
    assert.equal(r.host._boundReadFramebuffer, b._framebuffer);
    assert.equal(
      r.host._boundDrawFramebuffer,
      a._framebuffer,
      "READ leaves draw",
    );

    b.bindDraw();
    a.bindRead();
    assert.equal(r.host._boundReadFramebuffer, a._framebuffer);
    assert.equal(
      r.host._boundDrawFramebuffer,
      b._framebuffer,
      "DRAW leaves read",
    );

    r.stubs.bindFramebuffer(GL.READ_FRAMEBUFFER, null);
    assert.equal(r.host._boundReadFramebuffer, null);
    assert.equal(r.host._boundDrawFramebuffer, b._framebuffer);
  });

  it("a copy reads the READ binding when the draw binding is another framebuffer", () => {
    const r = rig();
    const fbRead = framebuffer(r, {
      colorTextures: [ownedTexture(r, 1).owner],
      destroyAttachments: false,
    });
    const fbDraw = framebuffer(r, {
      colorTextures: [ownedTexture(r, 2).owner],
      destroyAttachments: false,
    });
    const d = destination(r);

    fbRead.bindRead();
    fbDraw.bindDraw();
    r.stubs.copyTexSubImage2D(TEXTURE_2D, 0, 0, 0, 0, 0, 4, 4);

    assertRegion(d.native, { x: 0, y: 0 }, 0, 0, 4, 4, 1);
    assert.equal(r.device.violations.length, 0);
  });

  it("a target that is not a framebuffer target binds nothing", () => {
    const r = rig();
    const a = framebuffer(r, {
      colorTextures: [ownedTexture(r, 1).owner],
      destroyAttachments: false,
    });
    const b = framebuffer(r, {
      colorTextures: [ownedTexture(r, 2).owner],
      destroyAttachments: false,
    });
    a._bind();

    r.stubs.bindFramebuffer(GL.RENDERBUFFER, b._framebuffer);
    r.stubs.bindFramebuffer(0x1234, b._framebuffer);

    assert.equal(r.host._boundFramebuffer, a._framebuffer);
    assert.equal(r.host._boundReadFramebuffer, a._framebuffer);
    assert.equal(r.host._boundDrawFramebuffer, a._framebuffer);
  });

  it("deleting a bound framebuffer binds the default one, and a copy then reads no attachment", () => {
    const r = rig();
    const fb = framebuffer(r, {
      colorTextures: [ownedTexture(r, 1).owner],
      destroyAttachments: false,
    });
    const d = destination(r);
    fb._bind();
    fb.destroy();

    assert.equal(r.host._boundFramebuffer, null);
    assert.equal(r.host._boundReadFramebuffer, null);
    assert.equal(r.host._boundDrawFramebuffer, null);

    const before = commandCount(r.device);
    r.stubs.copyTexSubImage2D(TEXTURE_2D, 0, 0, 0, 0, 0, 4, 4);
    assert.equal(commandCount(r.device), before);
    assert.deepEqual(snapshot(d.native), ZEROS);
  });
});

// -- attachments -----------------------------------------------------------------

describe("which attachment a point records", () => {
  it("a higher color attachment never replaces color attachment 0", () => {
    const r = rig();
    const first = ownedTexture(r, 1);
    const second = ownedTexture(r, 2);
    const fb = framebuffer(r, {
      colorTextures: [first.owner, second.owner],
      destroyAttachments: false,
    });
    assert.equal(fb._framebuffer._colorAttachment, first.wrapper);

    const rbs = [
      renderbuffer(r, RenderbufferFormat.RGBA8).buffer,
      renderbuffer(r, RenderbufferFormat.RGBA8).buffer,
    ];
    const mrt = framebuffer(r, {
      colorRenderbuffers: rbs,
      destroyAttachments: false,
    });
    assert.equal(mrt._framebuffer._colorAttachment, rbs[0]._getRenderbuffer());
  });

  it("a depth, stencil or depth-stencil attachment replaces no color attachment and touches no GPU object", () => {
    const r = rig();
    const color = ownedTexture(r, 1);
    const depth = renderbuffer(r, RenderbufferFormat.DEPTH_COMPONENT16);
    const stencil = renderbuffer(r, RenderbufferFormat.STENCIL_INDEX8);
    const depthStencil = renderbuffer(r, RenderbufferFormat.DEPTH24_STENCIL8);
    const texturesBefore = r.device.textures.length;
    const eventsBefore = r.device.events.length;

    const withDepth = framebuffer(r, {
      colorTextures: [color.owner],
      depthRenderbuffer: depth.buffer,
      destroyAttachments: false,
    });
    const withStencil = framebuffer(r, {
      colorTextures: [color.owner],
      stencilRenderbuffer: stencil.buffer,
      destroyAttachments: false,
    });
    const withBoth = framebuffer(r, {
      colorTextures: [color.owner],
      depthStencilRenderbuffer: depthStencil.buffer,
      destroyAttachments: false,
    });
    const depthOnly = framebuffer(r, {
      depthRenderbuffer: depth.buffer,
      destroyAttachments: false,
    });

    for (const fb of [withDepth, withStencil, withBoth]) {
      assert.equal(fb._framebuffer._colorAttachment, color.wrapper);
    }
    assert.equal(depthOnly._framebuffer._colorAttachment, null);
    assert.equal(
      r.device.textures.length,
      texturesBefore,
      "no texture created",
    );
    assert.equal(
      r.device.events.length,
      eventsBefore,
      "nothing written, copied or destroyed",
    );
  });
});

// -- deleting a framebuffer -----------------------------------------------------------

describe("what deleting a framebuffer leaves alone", () => {
  it("with destroyAttachments: false, every attachment is still usable and nothing is destroyed", () => {
    const r = rig();
    const color = ownedTexture(r, 1);
    const rb = renderbuffer(r, RenderbufferFormat.RGBA8);
    const depth = renderbuffer(r, RenderbufferFormat.DEPTH_COMPONENT16);
    const depthStencil = renderbuffer(r, RenderbufferFormat.DEPTH24_STENCIL8);
    const live = liveTextures(r);

    framebuffer(r, {
      colorTextures: [color.owner],
      depthRenderbuffer: depth.buffer,
      destroyAttachments: false,
    }).destroy();
    framebuffer(r, {
      colorRenderbuffers: [rb.buffer],
      depthStencilRenderbuffer: depthStencil.buffer,
      destroyAttachments: false,
    }).destroy();

    assert.equal(liveTextures(r), live, "the live texture count is unchanged");
    assert.equal(color.owner.destroyCalls, 0);
    for (const native of [
      color.native,
      rb.native,
      depth.native,
      depthStencil.native,
    ]) {
      assert.equal(native.destroyed, false);
      assert.equal(destroysOf(r.device, native), 0, "no destroy was requested");
    }

    // Later: copied from, uploaded to, and copied from again, with no violation.
    const again = framebuffer(r, {
      colorTextures: [color.owner],
      destroyAttachments: false,
    });
    const d = destination(r);
    again.bindRead();
    r.stubs.copyTexSubImage2D(TEXTURE_2D, 0, 0, 0, 0, 0, 4, 4);
    assertRegion(d.native, { x: 0, y: 0 }, 0, 0, 4, 4, 1);
    r.stubs.bindTexture(TEXTURE_2D, color.wrapper);
    r.stubs.texSubImage2D(
      TEXTURE_2D,
      0,
      0,
      0,
      1,
      1,
      RGBA,
      UNSIGNED_BYTE,
      new Uint8Array([9, 8, 7, 6]),
    );
    r.stubs.bindTexture(TEXTURE_2D, d.wrapper);
    r.stubs.copyTexSubImage2D(TEXTURE_2D, 0, 0, 0, 0, 0, 4, 4);
    assert.deepEqual(pixelAt(d.native, 0, 0), [9, 8, 7, 6]);
    assert.equal(r.device.violations.length, 0);
  });

  it("with destroyAttachments: true, each attachment is destroyed exactly once, by its owner", () => {
    const r = rig();
    const baseline = liveTextures(r);
    const color = engineTexture(r, 1);
    const rb = renderbuffer(r, RenderbufferFormat.RGBA8);
    const depth = renderbuffer(r, RenderbufferFormat.DEPTH_COMPONENT16);
    assert.equal(liveTextures(r), baseline + 1);

    framebuffer(r, {
      colorTextures: [color.owner],
      depthRenderbuffer: depth.buffer,
      destroyAttachments: true,
    }).destroy();
    framebuffer(r, {
      colorRenderbuffers: [rb.buffer],
      destroyAttachments: true,
    }).destroy();

    assert.equal(color.owner.isDestroyed(), true, "Texture.destroy ran");
    assert.equal(destroysOf(r.device, color.native), 1);
    assert.equal(destroysOf(r.device, rb.native), 1);
    assert.equal(destroysOf(r.device, depth.native), 1);
    assert.equal(
      liveTextures(r),
      baseline,
      "the live count returns to its baseline",
    );
    assert.equal(r.device.violations.length, 0);
  });
});

// -- the atlas -----------------------------------------------------------------------

describe("an atlas growth through the real Framebuffer.js", () => {
  it("destroys the old Texture once, from its own destroy(), after every copy was submitted", () => {
    const r = rig();
    const old = engineTexture(r, 1);
    const grown = engineTexture(r, null, { size: 16 });
    const fb = framebuffer(r, {
      colorTextures: [old.owner],
      destroyAttachments: false,
    });
    const images = [
      { from: { x: 0, y: 0 }, to: { x: 8, y: 0 }, w: 2, h: 2 },
      { from: { x: 4, y: 1 }, to: { x: 0, y: 9 }, w: 2, h: 3 },
      { from: { x: 1, y: 5 }, to: { x: 10, y: 10 }, w: 3, h: 2 },
    ];

    // Through the real Texture.copyFromFramebuffer, so the copy's target is
    // the TEXTURE_2D the stub names, read by Texture.js, not a literal here.
    fb._bind();
    for (const { from, to, w, h } of images) {
      grown.owner.copyFromFramebuffer(to.x, to.y, from.x, from.y, w, h);
    }
    fb._unBind();
    fb.destroy();

    assert.equal(
      destroysOf(r.device, old.native),
      0,
      "tearing the framebuffer down destroys nothing",
    );

    // What TextureAtlas does after the copies: oldTexture.destroy().
    old.owner.destroy();

    assert.equal(
      destroysOf(r.device, old.native),
      1,
      "the owner destroyed it, once",
    );
    for (const { from, to, w, h } of images) {
      assertRegion(grown.native, from, to.x, to.y, w, h, 1);
    }
    const firstDestroy = r.device.events.findIndex(
      (e) => e.kind === "destroy" && e.texture === old.native,
    );
    const lastSubmit = r.device.events.findLastIndex(
      (e) => e.kind === "submit",
    );
    assert.ok(lastSubmit >= 0 && lastSubmit < firstDestroy);
    assert.equal(r.device.violations.length, 0);
    assert.equal(
      r.receipt.counts["copyTexSubImage2D.offFrame.submitted"],
      images.length,
    );
    assert.equal(r.receipt.counts["copyTexSubImage2D.noSource"] ?? 0, 0);
  });

  it("the probe's own trace reads the old native's one destroy after the tenth copy's submit", () => {
    // The Edge atlas cell's acceptance, read from the same instrument the
    // probe arms: ten copies, as the label atlas makes, each submitted off
    // the frame, then the owner's destroy.
    const r = tracedRig();
    try {
      const old = engineTexture(r, 1, { size: 16 });
      const grown = engineTexture(r, null, { size: 32 });
      const fb = framebuffer(r, {
        colorTextures: [old.owner],
        destroyAttachments: false,
      });
      const images = Array.from({ length: 10 }, (_, i) => ({
        from: { x: (i % 4) * 4, y: Math.floor(i / 4) * 4 },
        to: { x: (i % 5) * 6, y: Math.floor(i / 5) * 6 },
        w: 2,
        h: 2,
      }));
      fb._bind();
      for (const { from, to, w, h } of images) {
        grown.owner.copyFromFramebuffer(to.x, to.y, from.x, from.y, w, h);
      }
      fb._unBind();
      fb.destroy();
      old.owner.destroy();

      const order = copySourceDestroyOrder(r.gpu, "GLStub_OffFrameTextureCopy");
      assert.equal(order.submits, 10, "ten copies, each submitted");
      assert.notEqual(order.sourceId, null, "every copy read one texture");
      assert.deepEqual(order.sources, { [order.sourceId]: 10 });
      assert.equal(order.destroyCount, 1, "destroyed exactly once");
      assert.equal(order.destroyedAfterLastSubmit, true);
      const destroyEvent = `destroy.${old.native.label || "unlabelled"}`;
      const sample = r.gpu.samples[destroyEvent].find(
        (kept) => kept.id === order.sourceId,
      );
      assert.ok(sample, "the destroy's own sample is kept");
      assert.ok(
        sample.seq > order.lastSubmitSequence,
        `destroy seq ${sample.seq} after the tenth submit's ${order.lastSubmitSequence}`,
      );
      // The engine receipt is numbered on the same sequence.
      assert.equal(r.engine.counts["copyTexSubImage2D.offFrame.submitted"], 10);
      assert.ok(
        r.engine.lastSequence["copyTexSubImage2D.offFrame.submitted"] <
          sample.seq,
      );
      for (const { from, to, w, h } of images) {
        assertRegion(grown.native, from, to.x, to.y, w, h, 1);
      }
      assert.equal(r.device.violations.length, 0);
    } finally {
      r.release();
    }
  });
});
