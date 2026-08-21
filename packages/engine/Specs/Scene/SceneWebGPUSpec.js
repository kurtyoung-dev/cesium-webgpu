import { defined, GraphicsContext, RendererType } from "../../index.js";

import createCanvas from "../../../../Specs/createCanvas.js";
import createSceneAsync from "../../../../Specs/createSceneAsync.js";
import {
  AdapterTier,
  describeRequiresWebGPU,
  observedWebGPUAdapter,
  recordWebGPUAdapterTier,
  RequiredAdapterTier,
  requiredAdapterTier,
} from "../../../../Specs/webgpuPolicy.js";

// Every assertion below is a NON-PIXEL observable, deliberately. The suite's
// pixel matchers (`toRender`, `toRenderAndCall`, ...) are built on the
// synchronous `context.readPixels()`, which the WebGPU context implements as a
// shim returning `null` — WebGPU has no synchronous readback, and real readback
// goes through `readPixelsToPBO()` + `mapAsync()`. A first WebGPU scene spec
// built on those matchers would be testing the matcher, not the renderer; the
// last spec here pins that shim so the reason stays visible rather than
// becoming folklore.
//
// A 16x16 canvas is used rather than the harness default of 1x1: the default
// trips the small-drawing-buffer branch that forces `msaaSamples = 1`, and a
// backend smoke lane should not silently run in a degenerate configuration.
const CANVAS_SIZE = 16;

describeRequiresWebGPU("Scene/Scene on WebGPU", function () {
  let scene;
  let contextIdsBeforeCreation;

  beforeAll(async function () {
    contextIdsBeforeCreation = new Set(GraphicsContext.registry.all.keys());
    scene = await createSceneAsync({
      canvas: createCanvas(CANVAS_SIZE, CANVAS_SIZE),
    });

    // Record the adapter as early as possible, and from the context the Scene
    // actually holds — not from a separate `navigator.gpu.requestAdapter()`
    // call, which could resolve a different adapter and prove nothing about
    // this Scene. The lane's root afterAll fails a hardware-demanding run that
    // never reaches this line.
    recordWebGPUAdapterTier(scene.context.adapter?.info);
  });

  afterAll(function () {
    if (defined(scene) && !scene.isDestroyed()) {
      scene.destroyForSpecs();
    }
  });

  it("resolves the WebGPU backend rather than falling back to WebGL", function () {
    expect(scene.context.rendererType).toBe(RendererType.WEBGPU);
    expect(scene.context.isWebGPU).toBe(true);

    // `rendererType` alone cannot distinguish "WebGPU was requested and taken"
    // from "WebGPU was requested, failed, and something else re-requested it".
    // The creation diagnostics can: a fallback record is written whenever an
    // explicit request loses its first attempt.
    const diagnostics = scene.contextCreationDiagnostics;
    expect(diagnostics.requestedRenderer).toBe(RendererType.WEBGPU);
    expect(diagnostics.resolvedRenderer).toBe(RendererType.WEBGPU);
    expect(diagnostics.selectionReason).toBe("explicit");
    expect(diagnostics.fallback).toBeNull();
    expect(diagnostics.attempts.length).toBe(1);
    expect(diagnostics.attempts[0].status).toBe("succeeded");
  });

  it("registers a fresh context id in the context registry", function () {
    const id = scene.context.id;
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    // Fresh: this id did not exist before the Scene was constructed, so the
    // Scene is not sharing or reviving another suite's context.
    expect(contextIdsBeforeCreation.has(id)).toBe(false);

    expect(GraphicsContext.registry.get(id)).toBe(scene.context);
    expect(GraphicsContext.registry.getByType(RendererType.WEBGPU)).toContain(
      scene.context,
    );
  });

  it("advances the frame number over repeated renders without throwing", function () {
    const renderCount = 3;
    const before = scene.frameState.frameNumber;

    // `rethrowRenderErrors` is true, so a render-path exception surfaces here
    // instead of being swallowed into a quietly wrong frame.
    expect(function () {
      for (let i = 0; i < renderCount; i++) {
        scene.renderForSpecs();
      }
    }).not.toThrow();

    const after = scene.frameState.frameNumber;
    expect(after).toBeGreaterThan(before);
    expect(after - before).toBe(renderCount);
  });

  it("runs on a hardware adapter when the lane demands one", function () {
    const adapter = scene.context.adapter;
    expect(adapter).not.toBeNull();
    expect(adapter).toBeDefined();

    const observed = observedWebGPUAdapter();
    expect(observed).toBeDefined();

    // An absent GPU does not produce an absent adapter. Chromium launched with
    // `--disable-gpu` still resolves one, reporting vendor "google" /
    // architecture "swiftshader" / isFallbackAdapter true. Presence is
    // therefore not the question; tier is.
    if (requiredAdapterTier() === RequiredAdapterTier.HARDWARE) {
      expect(observed.tier).toBe(AdapterTier.HARDWARE);
      expect(observed.isFallbackAdapter).toBe(false);
    } else {
      // The lane accepts any tier here, but the run record must still name
      // which one it got — an unclassifiable adapter is reported as UNKNOWN
      // and never rounded up to hardware.
      expect([
        AdapterTier.HARDWARE,
        AdapterTier.SOFTWARE,
        AdapterTier.UNKNOWN,
      ]).toContain(observed.tier);
    }
  });

  it("reports no synchronous pixel readback, so pixel matchers do not apply", function () {
    expect(scene.context.supportsSynchronousReadback).toBe(false);
    expect(scene.context.readPixels({})).toBeNull();
  });
});

// A separate suite, not a spec in the one above: Jasmine runs suites in
// sequence, so this Scene is constructed only after the previous suite's
// afterAll has destroyed its own. Testing destruction on a shared Scene would
// either depend on spec ordering or hold two GPU devices at once.
describeRequiresWebGPU("Scene/Scene on WebGPU destruction", function () {
  it("destroyForSpecs destroys the Scene and unregisters its context", async function () {
    const scene = await createSceneAsync({
      canvas: createCanvas(CANVAS_SIZE, CANVAS_SIZE),
    });
    const id = scene.context.id;

    expect(scene.isDestroyed()).toBe(false);
    expect(GraphicsContext.registry.get(id)).toBe(scene.context);

    scene.destroyForSpecs();

    expect(scene.isDestroyed()).toBe(true);
    expect(GraphicsContext.registry.get(id)).toBeUndefined();
  });
});
