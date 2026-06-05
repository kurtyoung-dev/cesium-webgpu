import {
  BUFFER_CONSTANTS,
  createBufferStubs,
} from "../../../Source/Renderer/WebGPU/Stubs/WebGLStubBuffer.js";

describe("Renderer/WebGPU/Stubs/WebGLStubBuffer", function () {
  // These are pure-logic tests — the buffer stub methods read/write a
  // plain `WebGLStubState` object that WebGPUContext normally owns.
  // The only paths exercised here are the ones that DON'T touch a live
  // GPUDevice/queue:
  //   - BUFFER_CONSTANTS enum table + frozen-ness
  //   - createBufferStubs() returns the full method set
  //   - createBuffer() early-out when state.device is null (returns {})
  //   - bindBuffer() pure state mutation (ARRAY → vertex, ELEMENT → index,
  //     null handle clears, unrecognized target is a no-op)
  //   - deleteBuffer() destroy delegation + null safety (no device)
  //   - bufferData()/bufferSubData() device-free early returns
  //     (no bound buffer / numeric size arg / no device)
  //   - the vertex-attribute no-ops
  //
  // SKIPPED (device-bound — need a real GPUDevice/queue): the live
  // createBuffer() allocation, the bufferData() writeBuffer + regrow
  // path, and the bufferSubData() writeBuffer path. Those call
  // device.createBuffer() / device.queue.writeBuffer(), which Karma's
  // headless runner can't provide deterministically.

  // WebGL buffer-target enum literals copied directly from the module
  // under test so a careless renumber there fails one of these.
  const GL_ARRAY_BUFFER = 0x8892;
  const GL_ELEMENT_ARRAY_BUFFER = 0x8893;

  // A minimal fake state. `device` defaults to null so every device-bound
  // branch short-circuits; tests that need a "bound buffer" set one of the
  // boundVertexBuffer / boundIndexBuffer fields to a fake GPUBuffer object
  // (the stub only reads `.size` / `.usage` / `.label` / `.destroy` on the
  // regrow path, which we never reach without a device).
  function makeState() {
    return {
      device: null,
      boundVertexBuffer: null,
      boundIndexBuffer: null,
    };
  }

  // A fake `gl.createBuffer()` handle as the stub would return it. Its
  // `destroy` records invocation so deleteBuffer delegation can be asserted.
  function makeHandle(tag) {
    const calls = { destroy: 0 };
    const handle = {
      _webgpuBuffer: { __fakeGPUBuffer: tag },
      _size: 4096,
      destroy() {
        calls.destroy += 1;
      },
    };
    return { handle, calls };
  }

  describe("BUFFER_CONSTANTS", function () {
    it("pins the buffer-target enum constants", function () {
      expect(BUFFER_CONSTANTS.ARRAY_BUFFER).toBe(GL_ARRAY_BUFFER);
      expect(BUFFER_CONSTANTS.ELEMENT_ARRAY_BUFFER).toBe(
        GL_ELEMENT_ARRAY_BUFFER,
      );
    });

    it("pins the usage-hint enum constants", function () {
      expect(BUFFER_CONSTANTS.STATIC_DRAW).toBe(0x88e4);
      expect(BUFFER_CONSTANTS.DYNAMIC_DRAW).toBe(0x88e8);
      expect(BUFFER_CONSTANTS.STREAM_DRAW).toBe(0x88e0);
    });

    it("is frozen so the constant table can't be mutated at runtime", function () {
      expect(Object.isFrozen(BUFFER_CONSTANTS)).toBe(true);
    });
  });

  describe("createBufferStubs", function () {
    it("returns the full set of stub methods", function () {
      const state = makeState();
      const stubs = createBufferStubs(state, function () {});
      const expectedMethods = [
        "createBuffer",
        "bindBuffer",
        "deleteBuffer",
        "bufferData",
        "bufferSubData",
        "enableVertexAttribArray",
        "disableVertexAttribArray",
        "vertexAttribPointer",
        "vertexAttribDivisor",
      ];
      for (const name of expectedMethods) {
        expect(typeof stubs[name]).toBe("function");
      }
    });
  });

  describe("createBuffer", function () {
    it("returns an empty handle when no device is present", function () {
      const state = makeState(); // device === null
      const stubs = createBufferStubs(state, function () {});
      const handle = stubs.createBuffer();
      // The early-out returns a bare {} — no _webgpuBuffer / _size / destroy.
      expect(handle).toEqual({});
      expect(handle._webgpuBuffer).toBeUndefined();
      expect(handle._size).toBeUndefined();
      expect(handle.destroy).toBeUndefined();
    });
  });

  describe("bindBuffer", function () {
    it("binds ARRAY_BUFFER to the vertex slot", function () {
      const state = makeState();
      const stubs = createBufferStubs(state, function () {});
      const { handle } = makeHandle("vb");
      stubs.bindBuffer(GL_ARRAY_BUFFER, handle);
      expect(state.boundVertexBuffer).toBe(handle._webgpuBuffer);
      expect(state.boundIndexBuffer).toBeNull();
    });

    it("binds ELEMENT_ARRAY_BUFFER to the index slot", function () {
      const state = makeState();
      const stubs = createBufferStubs(state, function () {});
      const { handle } = makeHandle("ib");
      stubs.bindBuffer(GL_ELEMENT_ARRAY_BUFFER, handle);
      expect(state.boundIndexBuffer).toBe(handle._webgpuBuffer);
      expect(state.boundVertexBuffer).toBeNull();
    });

    it("clears the vertex slot when binding a null handle", function () {
      const state = makeState();
      const stubs = createBufferStubs(state, function () {});
      const { handle } = makeHandle("vb");
      stubs.bindBuffer(GL_ARRAY_BUFFER, handle);
      expect(state.boundVertexBuffer).toBe(handle._webgpuBuffer);
      stubs.bindBuffer(GL_ARRAY_BUFFER, null);
      expect(state.boundVertexBuffer).toBeNull();
    });

    it("clears the index slot when binding a null handle", function () {
      const state = makeState();
      const stubs = createBufferStubs(state, function () {});
      const { handle } = makeHandle("ib");
      stubs.bindBuffer(GL_ELEMENT_ARRAY_BUFFER, handle);
      expect(state.boundIndexBuffer).toBe(handle._webgpuBuffer);
      stubs.bindBuffer(GL_ELEMENT_ARRAY_BUFFER, null);
      expect(state.boundIndexBuffer).toBeNull();
    });

    it("ignores unrecognized targets", function () {
      const state = makeState();
      const stubs = createBufferStubs(state, function () {});
      const { handle } = makeHandle("x");
      stubs.bindBuffer(0xdead, handle);
      expect(state.boundVertexBuffer).toBeNull();
      expect(state.boundIndexBuffer).toBeNull();
    });
  });

  describe("deleteBuffer", function () {
    it("destroys the underlying GPUBuffer when present", function () {
      const state = makeState();
      const stubs = createBufferStubs(state, function () {});
      let destroyed = 0;
      const handle = {
        _webgpuBuffer: {
          destroy() {
            destroyed += 1;
          },
        },
        destroy() {
          // Should NOT be called — the _webgpuBuffer branch wins.
          destroyed += 100;
        },
      };
      stubs.deleteBuffer(handle);
      expect(destroyed).toBe(1);
    });

    it("falls back to the handle's own destroy when there is no GPUBuffer", function () {
      const state = makeState();
      const stubs = createBufferStubs(state, function () {});
      let destroyed = 0;
      const handle = {
        destroy() {
          destroyed += 1;
        },
      };
      stubs.deleteBuffer(handle);
      expect(destroyed).toBe(1);
    });

    it("is a no-op on a null handle", function () {
      const state = makeState();
      const stubs = createBufferStubs(state, function () {});
      expect(function () {
        stubs.deleteBuffer(null);
      }).not.toThrow();
    });

    it("is a no-op on a handle with neither GPUBuffer nor destroy", function () {
      const state = makeState();
      const stubs = createBufferStubs(state, function () {});
      expect(function () {
        stubs.deleteBuffer({});
      }).not.toThrow();
    });
  });

  describe("bufferData (device-free paths)", function () {
    it("is a no-op when no buffer is bound for the target", function () {
      const state = makeState(); // both bound slots null
      const stubs = createBufferStubs(state, function () {});
      // Returns at the `if (!boundBuffer) return;` guard, before any
      // device access — so a null device cannot throw here.
      expect(function () {
        stubs.bufferData(GL_ARRAY_BUFFER, new Float32Array([1, 2, 3, 4]), 0);
      }).not.toThrow();
    });

    it("treats a numeric data argument as a size-only allocation (no-op without device)", function () {
      const state = makeState();
      // A non-null bound buffer so we pass the first guard, but a numeric
      // `data` returns at `if (typeof data === "number") return;` — before
      // the device check.
      state.boundVertexBuffer = { size: 16 };
      const stubs = createBufferStubs(state, function () {});
      expect(function () {
        stubs.bufferData(GL_ARRAY_BUFFER, 256, 0);
      }).not.toThrow();
      // The bound buffer reference is unchanged (no regrow attempted).
      expect(state.boundVertexBuffer.size).toBe(16);
    });

    it("is a no-op when the device is null", function () {
      const state = makeState(); // device === null
      state.boundIndexBuffer = { size: 16 };
      const stubs = createBufferStubs(state, function () {});
      // Bound buffer + array data, but device null → returns at the
      // `if (!state.device) return;` guard with no queue write.
      expect(function () {
        stubs.bufferData(
          GL_ELEMENT_ARRAY_BUFFER,
          new Uint16Array([0, 1, 2, 3]),
          0,
        );
      }).not.toThrow();
    });
  });

  describe("bufferSubData (device-free paths)", function () {
    it("is a no-op when no buffer is bound for the target", function () {
      const state = makeState();
      const stubs = createBufferStubs(state, function () {});
      expect(function () {
        stubs.bufferSubData(GL_ARRAY_BUFFER, 0, new Float32Array([1, 2]));
      }).not.toThrow();
    });

    it("is a no-op when the device is null", function () {
      const state = makeState(); // device === null
      state.boundVertexBuffer = { size: 64 };
      const stubs = createBufferStubs(state, function () {});
      // Bound buffer present but device null → returns at the combined
      // `if (!boundBuffer || !state.device) return;` guard.
      expect(function () {
        stubs.bufferSubData(GL_ARRAY_BUFFER, 8, new Float32Array([1, 2]));
      }).not.toThrow();
    });
  });

  describe("vertex-attribute no-ops", function () {
    it("are callable without a device and do not throw", function () {
      const state = makeState();
      const stubs = createBufferStubs(state, function () {});
      expect(function () {
        stubs.enableVertexAttribArray(0);
        stubs.disableVertexAttribArray(0);
        stubs.vertexAttribPointer(0, 3, 0x1406, false, 0, 0);
        stubs.vertexAttribDivisor(0, 1);
      }).not.toThrow();
    });
  });
});
