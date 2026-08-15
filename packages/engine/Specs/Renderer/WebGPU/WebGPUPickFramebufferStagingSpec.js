import WebGPUPickFramebuffer from "../../../Source/Renderer/WebGPU/WebGPUPickFramebuffer.js";

if (typeof globalThis.GPUTextureUsage === "undefined") {
  globalThis.GPUTextureUsage = {
    RENDER_ATTACHMENT: 0x10,
    COPY_SRC: 0x01,
    TEXTURE_BINDING: 0x04,
    COPY_DST: 0x02,
  };
}
if (typeof globalThis.GPUBufferUsage === "undefined") {
  globalThis.GPUBufferUsage = {
    COPY_DST: 0x08,
    MAP_READ: 0x01,
  };
}
if (typeof globalThis.GPUMapMode === "undefined") {
  globalThis.GPUMapMode = { READ: 0x01 };
}

function makeDevice(options = {}) {
  const buffers = [];
  const textures = [];
  const copies = [];
  const mapResolvers = [];
  const queue = {
    submissions: [],
    writeTexture: jasmine.createSpy("writeTexture"),
    submit: function (commandBuffers) {
      this.submissions.push(commandBuffers);
    },
  };

  const device = {
    options: options,
    buffers: buffers,
    textures: textures,
    copies: copies,
    mapResolvers: mapResolvers,
    queue: queue,
    createTexture: function (descriptor) {
      const texture = {
        descriptor: descriptor,
        destroyed: false,
        createView: function () {
          return { texture: texture };
        },
        destroy: function () {
          this.destroyed = true;
        },
      };
      textures.push(texture);
      return texture;
    },
    createBuffer: function (descriptor) {
      if (this.failNextBufferCreate) {
        this.failNextBufferCreate = false;
        throw new Error("synthetic createBuffer failure");
      }
      const storage = new ArrayBuffer(descriptor.size);
      if (options.nonzeroPixels) {
        const bytes = new Uint8Array(storage);
        for (let i = 0; i < bytes.length; i += 4) {
          bytes[i] = 1;
        }
      }
      if (options.alphaOnlyPixels) {
        const bytes = new Uint8Array(storage);
        for (let i = 3; i < bytes.length; i += 4) {
          bytes[i] = 1;
        }
      }
      const buffer = {
        descriptor: descriptor,
        storage: new Uint8Array(storage),
        destroyed: false,
        destroyCount: 0,
        mapped: false,
        mapAsync: function () {
          if (options.rejectMaps) {
            return Promise.reject(new Error("synthetic map failure"));
          }
          if (!options.deferMaps) {
            this.mapped = true;
            return Promise.resolve();
          }
          return new Promise((resolve) => {
            mapResolvers.push(() => {
              this.mapped = true;
              resolve();
            });
          });
        },
        getMappedRange: function () {
          if (options.throwGetMappedRange) {
            throw new Error("synthetic mapped-range failure");
          }
          return storage;
        },
        unmap: function () {
          this.mapped = false;
        },
        destroy: function () {
          this.destroyed = true;
          this.destroyCount++;
        },
      };
      buffers.push(buffer);
      return buffer;
    },
    createCommandEncoder: function () {
      return {
        copyTextureToBuffer: function (source, destination, extent) {
          copies.push({ source: source, destination: destination, extent });
        },
        finish: function () {
          return {};
        },
      };
    },
  };

  return device;
}

function makeFramebuffer(options) {
  const device = makeDevice(options);
  const context = {
    _device: device,
    scenePipelineFormat: "rgba8unorm",
    getObjectByPickColor: function () {
      return options?.pickObject;
    },
  };
  const framebuffer = new WebGPUPickFramebuffer(context);
  framebuffer.begin(
    { x: 100, y: 50, width: 3, height: 3 },
    { x: 0, y: 0, width: 1920, height: 1080 },
  );
  return { framebuffer, device, context };
}

describe("Renderer/WebGPU/WebGPUPickFramebuffer staging", function () {
  it("starts the pick mini-frame before allocating attachments", function () {
    const device = makeDevice();
    const order = [];
    const createTexture = device.createTexture;
    device.createTexture = function (descriptor) {
      order.push("texture");
      return createTexture.call(this, descriptor);
    };
    const context = {
      _device: device,
      scenePipelineFormat: "rgba8unorm",
      beginPickFrame: function () {
        order.push("frame");
      },
    };
    const framebuffer = new WebGPUPickFramebuffer(context);

    framebuffer.begin(
      { x: 100, y: 50, width: 3, height: 3 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    );

    expect(order[0]).toBe("frame");
    expect(order.filter((entry) => entry === "frame").length).toBe(1);
    framebuffer.destroy();
  });

  it("does not allocate viewport-sized staging during begin", function () {
    const { framebuffer, device } = makeFramebuffer();

    expect(device.buffers.length).toBe(0);
    expect(device.textures.length).toBe(3);
    expect(device.textures[2].descriptor.size).toEqual([1, 1]);
    framebuffer.destroy();
  });

  it("allocates and caches readable depth only when a consumer requests it", function () {
    const { framebuffer, device } = makeFramebuffer();

    expect(device.textures.length).toBe(3);
    const firstView = framebuffer.readableDepthView;
    expect(firstView).not.toBeNull();
    expect(device.textures.length).toBe(4);
    expect(device.textures[3].descriptor.label).toBe(
      "Pick readable depth texture (depth32float)",
    );
    expect(framebuffer.readableDepthView).toBe(firstView);
    expect(device.textures.length).toBe(4);
    framebuffer.destroy();
  });

  it("allocates packed classification depth only for a classification query", function () {
    const { framebuffer, device } = makeFramebuffer();
    const ensure = framebuffer._passState.framebuffer.ensureClassificationDepth;

    expect(device.textures.length).toBe(3);
    const first = ensure();
    expect(first).not.toBeNull();
    expect(device.textures.length).toBe(4);
    expect(device.textures[3].descriptor.label).toBe(
      "Pick packed classification depth texture",
    );
    expect(ensure()).toEqual(first);
    expect(device.textures.length).toBe(4);
    framebuffer.destroy();
  });

  it("recreates same-size attachments after a device change", function () {
    const { framebuffer, device, context } = makeFramebuffer();
    const oldTextures = [...device.textures];
    const replacement = makeDevice();
    context._device = replacement;

    const passState = framebuffer.begin(
      { x: 100, y: 50, width: 3, height: 3 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    );

    expect(oldTextures.every((texture) => texture.destroyed)).toBe(true);
    expect(replacement.textures.length).toBe(3);
    expect(passState.framebuffer.colorView.texture).toBe(
      replacement.textures[0],
    );
    expect(passState.framebuffer.depthView.texture).toBe(
      replacement.textures[1],
    );
    framebuffer.destroy();
  });

  it("allocates an exact-row-padded buffer for a 3x3 async query", async function () {
    const { framebuffer, device } = makeFramebuffer();

    await framebuffer.endAsync({ width: 3, height: 3 }, {}, 1);

    expect(device.buffers.length).toBe(1);
    expect(device.buffers[0].descriptor.size).toBe(256 * 3);
    expect(device.buffers[0].descriptor.label).toBe(
      "Pick async staging buffer",
    );
    expect(device.copies[0].extent).toEqual([3, 3]);
    expect(device.copies[0].destination.buffer).toBe(device.buffers[0]);
    expect(device.buffers[0].destroyed).toBe(true);
    framebuffer.destroy();
  });

  it("clips the GPU edge copy but preserves and zero-pads the logical query center", async function () {
    const options = {
      deferMaps: true,
      pickObject: { id: "edge-center" },
    };
    const { framebuffer, device } = makeFramebuffer(options);
    const passState = framebuffer.begin(
      { x: 1918, y: 1078, width: 3, height: 3 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    );

    const readback = framebuffer.endAsync(
      { x: 1918, y: 1078, width: 3, height: 3 },
      {},
      1,
    );

    // The logical 3x3 center maps to source row 0, column 1 after the missing
    // top row is padded. Populate only that copied pixel.
    device.buffers[0].storage[4] = 1;
    device.mapResolvers[0]();
    const result = await readback;

    expect(passState.framebuffer.pickScissor).toEqual({
      x: 1918,
      y: 0,
      width: 2,
      height: 2,
    });
    expect(device.copies[0].source.origin).toEqual([1918, 0, 0]);
    expect(device.copies[0].extent).toEqual([2, 2]);
    expect(device.buffers[0].descriptor.size).toBe(256 * 2);
    expect(framebuffer._lastReadPixels.length).toBe(3 * 3 * 4);
    expect(framebuffer._lastReadPixels[4 * (1 * 3 + 1)]).toBe(1);
    expect(result).toEqual([options.pickObject]);
    framebuffer.destroy();
  });

  it("gives overlapping async queries distinct staging buffers", async function () {
    const { framebuffer, device } = makeFramebuffer({ deferMaps: true });

    const first = framebuffer.endAsync({ width: 3, height: 3 }, {}, 1);
    const second = framebuffer.endAsync({ width: 3, height: 3 }, {}, 1);

    expect(device.buffers.length).toBe(2);
    expect(device.queue.submissions.length).toBe(2);
    expect(device.copies[0].destination.buffer).not.toBe(
      device.copies[1].destination.buffer,
    );
    for (const resolveMap of device.mapResolvers.splice(0)) {
      resolveMap();
    }
    await Promise.all([first, second]);
    expect(device.buffers.every((buffer) => buffer.destroyed)).toBe(true);
    framebuffer.destroy();
  });

  it("does not let an older async completion overwrite a newer cached query", async function () {
    const { framebuffer, device } = makeFramebuffer({ deferMaps: true });

    const first = framebuffer.endAsync({ width: 3, height: 3 }, {}, 1);
    framebuffer.begin(
      { x: 101, y: 50, width: 3, height: 3 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    );
    const second = framebuffer.endAsync({ width: 3, height: 3 }, {}, 1);
    device.buffers[0].storage[0] = 1;
    device.buffers[1].storage[0] = 2;

    device.mapResolvers[1]();
    await second;
    expect(framebuffer._lastReadPixels[0]).toBe(2);
    expect(framebuffer._lastReadRegion.logicalOriginX).toBe(101);

    device.mapResolvers[0]();
    await first;
    expect(framebuffer._lastReadPixels[0]).toBe(2);
    expect(framebuffer._lastReadRegion.logicalOriginX).toBe(101);
    framebuffer.destroy();
  });

  it("keeps sync and async readbacks on separate buffers", async function () {
    const { framebuffer, device } = makeFramebuffer({ deferMaps: true });

    framebuffer.end({ width: 3, height: 3 }, 1);
    const asyncResult = framebuffer.endAsync({ width: 3, height: 3 }, {}, 1);
    // A second sync request while the first buffer is mapping-pending must be
    // skipped instead of reallocating or submitting into the mapped slot.
    framebuffer.end({ width: 3, height: 3 }, 1);

    expect(device.buffers.length).toBe(2);
    expect(device.copies.length).toBe(2);
    expect(device.buffers[0].descriptor.label).toBe("Pick sync staging buffer");
    expect(device.buffers[1].descriptor.label).toBe(
      "Pick async staging buffer",
    );
    expect(device.copies[0].destination.buffer).not.toBe(
      device.copies[1].destination.buffer,
    );
    for (const resolveMap of device.mapResolvers.splice(0)) {
      resolveMap();
    }
    await asyncResult;
    await Promise.resolve();
    expect(device.buffers[0].destroyed).toBe(false);
    expect(device.buffers[1].destroyed).toBe(true);
    framebuffer.destroy();
  });

  it("reuses the exact-size sync staging buffer after it is unmapped", async function () {
    const { framebuffer, device } = makeFramebuffer();

    framebuffer.end({ width: 3, height: 3 }, 1);
    await Promise.resolve();
    await Promise.resolve();
    framebuffer.end({ width: 3, height: 3 }, 1);

    expect(device.buffers.length).toBe(1);
    expect(device.buffers[0].descriptor.size).toBe(256 * 3);
    framebuffer.destroy();
  });

  it("does not reuse a synchronous cache entry for a different logical query", async function () {
    const options = {
      deferMaps: true,
      nonzeroPixels: true,
      pickObject: { id: "first-location" },
    };
    const { framebuffer, device } = makeFramebuffer(options);

    framebuffer.end({ width: 3, height: 3 }, 1);
    device.mapResolvers[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(framebuffer._lastReadPixels).not.toBeNull();

    framebuffer.begin(
      { x: 101, y: 50, width: 3, height: 3 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    );
    options.deferMaps = false;
    const result = framebuffer.end({ width: 3, height: 3 }, 1);

    expect(result).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();
    framebuffer.destroy();
  });

  it("propagates async map failures and destroys the request buffer once", async function () {
    const { framebuffer, device } = makeFramebuffer({ rejectMaps: true });
    let rejection;

    try {
      await framebuffer.endAsync({ width: 3, height: 3 }, {}, 1);
    } catch (error) {
      rejection = error;
    }

    expect(rejection?.message).toBe("synthetic map failure");
    expect(device.buffers[0].destroyed).toBe(true);
    expect(device.buffers[0].destroyCount).toBe(1);
    framebuffer.destroy();
  });

  it("decodes a valid pick key whose only nonzero byte is alpha", async function () {
    const options = {
      alphaOnlyPixels: true,
      pickObject: { id: "high-pick-key" },
    };
    const { framebuffer } = makeFramebuffer(options);

    const result = await framebuffer.endAsync({ width: 3, height: 3 }, {}, 1);

    expect(result).toEqual([options.pickObject]);
    framebuffer.destroy();
  });

  it("does not publish delayed sync bytes after the attachment is resized", async function () {
    const options = {
      deferMaps: true,
      nonzeroPixels: true,
      pickObject: { id: "old-target" },
    };
    const { framebuffer, device } = makeFramebuffer(options);

    framebuffer.end({ width: 3, height: 3 }, 1);
    framebuffer.begin(
      { x: 10, y: 10, width: 3, height: 3 },
      { x: 0, y: 0, width: 800, height: 600 },
    );
    for (const resolveMap of device.mapResolvers.splice(0)) {
      resolveMap();
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(framebuffer._lastReadPixels).toBeNull();
    framebuffer.destroy();
  });

  it("returns a delayed async result but does not warm a resized target's cache", async function () {
    const options = {
      deferMaps: true,
      nonzeroPixels: true,
      pickObject: { id: "old-target" },
    };
    const { framebuffer, device } = makeFramebuffer(options);

    const readback = framebuffer.endAsync({ width: 3, height: 3 }, {}, 1);
    framebuffer.begin(
      { x: 10, y: 10, width: 3, height: 3 },
      { x: 0, y: 0, width: 800, height: 600 },
    );
    for (const resolveMap of device.mapResolvers.splice(0)) {
      resolveMap();
    }
    const result = await readback;

    expect(result).toEqual([options.pickObject]);
    expect(framebuffer._lastReadPixels).toBeNull();
    framebuffer.destroy();
  });

  it("unmaps the sync buffer when mapped-range unpacking throws", async function () {
    const options = { throwGetMappedRange: true };
    const { framebuffer, device } = makeFramebuffer(options);

    framebuffer.end({ width: 3, height: 3 }, 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(device.buffers[0].mapped).toBe(false);

    options.throwGetMappedRange = false;
    framebuffer.end({ width: 3, height: 3 }, 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(device.buffers.length).toBe(1);
    expect(device.copies.length).toBe(2);
    framebuffer.destroy();
  });

  it("keeps the previous sync buffer usable when resize allocation fails", async function () {
    const { framebuffer, device } = makeFramebuffer();

    framebuffer.end({ width: 3, height: 3 }, 1);
    await Promise.resolve();
    await Promise.resolve();
    const original = device.buffers[0];

    device.failNextBufferCreate = true;
    framebuffer.begin(
      { x: 100, y: 50, width: 3, height: 4 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    );
    expect(function () {
      framebuffer.end({ width: 3, height: 4 }, 1);
    }).toThrowError("synthetic createBuffer failure");
    expect(original.destroyed).toBe(false);

    framebuffer.begin(
      { x: 100, y: 50, width: 3, height: 3 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    );
    framebuffer.end({ width: 3, height: 3 }, 1);
    expect(device.buffers.length).toBe(1);
    expect(device.copies.length).toBe(2);
    framebuffer.destroy();
  });

  describe("center-pixel readback across concurrent identities", function () {
    const rectangle = { x: 100, y: 50, width: 3, height: 3 };

    function arm(framebuffer, property) {
      return framebuffer.readCenterPixel(
        rectangle,
        "metadata",
        "class",
        property,
        "schema class property",
        undefined,
        "provenance",
      );
    }

    async function settle() {
      for (let i = 0; i < 4; ++i) {
        await Promise.resolve();
      }
    }

    it("converges every distinct identity armed inside one task", async function () {
      // A multi-property pickMetadata sweep arms one readback per property
      // before any of them can resolve. A single publishing slot let only the
      // last-armed identity ever converge; the earlier ones returned undefined
      // forever, no matter how many picks followed.
      const { framebuffer, device } = makeFramebuffer();

      expect(arm(framebuffer, "alpha")).toBeUndefined();
      expect(arm(framebuffer, "beta")).toBeUndefined();
      expect(device.buffers.length).toBe(2);
      device.buffers[0].storage[0] = 11;
      device.buffers[1].storage[0] = 22;

      await settle();

      const alpha = arm(framebuffer, "alpha");
      const beta = arm(framebuffer, "beta");
      expect(alpha).toBeDefined();
      expect(beta).toBeDefined();
      expect(alpha[0]).toBe(11);
      expect(beta[0]).toBe(22);
      framebuffer.destroy();
    });

    it("arms one readback per identity while requests are in flight", async function () {
      const { framebuffer, device } = makeFramebuffer({ deferMaps: true });

      arm(framebuffer, "alpha");
      arm(framebuffer, "alpha");
      arm(framebuffer, "alpha");
      expect(device.buffers.length).toBe(1);
      arm(framebuffer, "beta");
      expect(device.buffers.length).toBe(2);

      for (const resolveMap of device.mapResolvers.splice(0)) {
        resolveMap();
      }
      await settle();
      expect(arm(framebuffer, "alpha")).toBeDefined();
      expect(arm(framebuffer, "beta")).toBeDefined();
      framebuffer.destroy();
    });

    it("refreshes an identity's slot from its next resolved readback", async function () {
      const { framebuffer, device } = makeFramebuffer({ deferMaps: true });

      arm(framebuffer, "alpha");
      device.buffers[0].storage[0] = 1;
      device.mapResolvers.splice(0).forEach((resolveMap) => resolveMap());
      await settle();

      // Reading returns the cached byte AND arms the next readback for the
      // same identity; that later value replaces the slot rather than adding
      // a second entry for it.
      expect(arm(framebuffer, "alpha")[0]).toBe(1);
      expect(device.buffers.length).toBe(2);
      device.buffers[1].storage[0] = 2;
      device.mapResolvers.splice(0).forEach((resolveMap) => resolveMap());
      await settle();
      expect(arm(framebuffer, "alpha")[0]).toBe(2);
      framebuffer.destroy();
    });

    it("evicts the least recently used identity beyond the cache bound", async function () {
      const { framebuffer } = makeFramebuffer();
      const properties = ["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7"];

      for (const property of properties) {
        arm(framebuffer, property);
      }
      await settle();

      // Eight distinct identities fill the cache exactly. A ninth evicts the
      // least recently used slot, which is p0 — it published first and nothing
      // has touched it since.
      arm(framebuffer, "p8");
      await settle();
      expect(arm(framebuffer, "p8")).toBeDefined();
      expect(arm(framebuffer, "p7")).toBeDefined();
      expect(arm(framebuffer, "p0")).toBeUndefined();
      framebuffer.destroy();
    });
  });
});
