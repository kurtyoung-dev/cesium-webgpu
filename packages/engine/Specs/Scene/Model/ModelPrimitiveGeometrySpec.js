import {
  bumpGeometryRevision,
  createPrimitiveGeometryView,
  extractPrimitiveGeometry,
  getPrimitiveGeometryCacheDiagnostics,
  resetPrimitiveGeometryCacheForSpecs,
  resetPrimitiveGeometryView,
} from "../../../Source/Scene/Model/ModelPrimitiveGeometry.js";

describe("Scene/Model/ModelPrimitiveGeometry", function () {
  function createFixture() {
    const position = {
      semantic: "POSITION",
      componentsPerAttribute: 3,
      typedArray: new Int16Array([0, 0, 0, 10, 20, 30]),
      quantization: {
        quantizedVolumeOffset: [1, 2, 3],
        quantizedVolumeStepSize: [0.5, 0.25, 0.125],
      },
    };
    const morphPosition = {
      semantic: "POSITION",
      componentsPerAttribute: 3,
      typedArray: new Int16Array([1, 2, 3, 4, 5, 6]),
      quantization: {
        quantizedVolumeOffset: [0, 0, 0],
        quantizedVolumeStepSize: [0.1, 0.1, 0.1],
      },
    };
    const indices = {
      typedArray: new Uint8Array([0, 1, 0]),
    };
    const primitive = {
      attributes: [position],
      morphTargets: [{ attributes: [morphPosition] }],
      indices,
      primitiveType: 4,
    };
    return {
      runtimePrimitive: { primitive },
      primitive,
      position,
      morphPosition,
      indices,
    };
  }

  beforeEach(function () {
    resetPrimitiveGeometryCacheForSpecs();
  });

  it("converts quantized attributes, morphs, and uint8 indices once across frames", function () {
    const fixture = createFixture();
    const first = extractPrimitiveGeometry(fixture.runtimePrimitive);

    for (let frame = 0; frame < 100; frame++) {
      expect(extractPrimitiveGeometry(fixture.runtimePrimitive)).toBe(first);
    }

    expect(first.positionData).toEqual(new Float32Array([1, 2, 3, 6, 7, 6.75]));
    expect(first.morphTargets[0].positionData).toEqual(
      new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]),
    );
    expect(first.indexData).toEqual(new Uint16Array([0, 1, 0]));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.morphTargets)).toBe(true);
    expect(Object.isFrozen(first.morphTargets[0])).toBe(true);
    expect(getPrimitiveGeometryCacheDiagnostics()).toEqual({
      hitCount: 100,
      missCount: 1,
      invalidationCount: 0,
      descriptorBuildCount: 1,
      attributeConversionCount: 1,
      morphAttributeConversionCount: 1,
      uint8IndexUpcastCount: 1,
      // This fixture carries no loader revision tokens, so every settled hit
      // goes through the deep walk (C9-17 Slice B fallback).
      revisionHitCount: 0,
      walkHitCount: 100,
    });
  });

  it("invalidates once per source identity, conversion metadata, or revision change", function () {
    const fixture = createFixture();
    let previous = extractPrimitiveGeometry(fixture.runtimePrimitive);

    function expectOneInvalidation(mutate) {
      const before = getPrimitiveGeometryCacheDiagnostics();
      mutate();
      const next = extractPrimitiveGeometry(fixture.runtimePrimitive);
      expect(next).not.toBe(previous);
      expect(extractPrimitiveGeometry(fixture.runtimePrimitive)).toBe(next);
      const after = getPrimitiveGeometryCacheDiagnostics();
      expect(after.invalidationCount).toBe(before.invalidationCount + 1);
      expect(after.descriptorBuildCount).toBe(before.descriptorBuildCount + 1);
      previous = next;
    }

    expectOneInvalidation(function () {
      fixture.position.typedArray = new Int16Array([2, 4, 6, 8, 10, 12]);
    });
    expectOneInvalidation(function () {
      fixture.morphPosition.typedArray = new Int16Array([6, 5, 4, 3, 2, 1]);
    });
    expectOneInvalidation(function () {
      fixture.indices.typedArray = new Uint8Array([1, 0, 1]);
    });
    expectOneInvalidation(function () {
      fixture.position.quantization.quantizedVolumeStepSize[0] = 0.75;
    });
    expectOneInvalidation(function () {
      fixture.primitive._geometryRevision = 1;
    });
    expectOneInvalidation(function () {
      fixture.runtimePrimitive.renderResources = {
        attributes: fixture.primitive.attributes,
        indices: fixture.primitive.indices,
        primitiveType: fixture.primitive.primitiveType,
      };
    });

    const diagnostics = getPrimitiveGeometryCacheDiagnostics();
    expect(diagnostics.invalidationCount).toBe(6);
    expect(diagnostics.descriptorBuildCount).toBe(7);
    expect(diagnostics.hitCount).toBe(6);
  });

  it("isolates mutable renderer annotations from the immutable cached base", function () {
    const fixture = createFixture();
    const base = extractPrimitiveGeometry(fixture.runtimePrimitive);
    const view = createPrimitiveGeometryView(base);
    const synthesizedFeatureIds = new Float32Array([4, 5]);

    view.featureId0Data = synthesizedFeatureIds;
    view.hasFeatureId0 = true;
    view.metadataData = new Float32Array([8, 9]);
    view.hasMetadata = true;
    view.metadataClassHash = 123;
    view.indexData = new Uint16Array([0, 1]);
    view.indexCount = 2;

    expect(base.featureId0Data).toBeNull();
    expect(base.hasFeatureId0).toBe(false);
    expect(base.hasMetadata).toBe(false);
    expect(base.indexCount).toBe(3);

    expect(resetPrimitiveGeometryView(view, base)).toBe(view);
    expect(view.featureId0Data).toBe(base.featureId0Data);
    expect(view.hasFeatureId0).toBe(false);
    expect(view.metadataData).toBeNull();
    expect(view.hasMetadata).toBe(false);
    expect(view.metadataClassHash).toBe(0);
    expect(view.indexData).toBe(base.indexData);
    expect(view.indexCount).toBe(base.indexCount);
  });

  // C9-17 Slice B — loader-owned revision tokens for O(1) positive-path validation.
  function createStampedFixture() {
    const fixture = createFixture();
    // Simulate the loader stamping each geometry-identity-bearing object at
    // load completion (GltfLoader finalize callbacks + indices callback).
    bumpGeometryRevision(fixture.position);
    bumpGeometryRevision(fixture.morphPosition);
    bumpGeometryRevision(fixture.indices);
    return fixture;
  }

  it("validates settled frames through the revision fast path with zero deep walk", function () {
    const fixture = createStampedFixture();
    const first = extractPrimitiveGeometry(fixture.runtimePrimitive);

    for (let frame = 0; frame < 50; frame++) {
      expect(extractPrimitiveGeometry(fixture.runtimePrimitive)).toBe(first);
    }

    const diagnostics = getPrimitiveGeometryCacheDiagnostics();
    expect(diagnostics.hitCount).toBe(50);
    expect(diagnostics.revisionHitCount).toBe(50);
    expect(diagnostics.walkHitCount).toBe(0);
  });

  it("falls back to the deep walk when any revision token is absent", function () {
    // Stamp every object EXCEPT the morph attribute — one missing token forces
    // the whole primitive onto the walk (honest-partial fallback).
    const fixture = createFixture();
    bumpGeometryRevision(fixture.position);
    bumpGeometryRevision(fixture.indices);
    const first = extractPrimitiveGeometry(fixture.runtimePrimitive);

    for (let frame = 0; frame < 50; frame++) {
      expect(extractPrimitiveGeometry(fixture.runtimePrimitive)).toBe(first);
    }

    const diagnostics = getPrimitiveGeometryCacheDiagnostics();
    expect(diagnostics.hitCount).toBe(50);
    expect(diagnostics.revisionHitCount).toBe(0);
    expect(diagnostics.walkHitCount).toBe(50);
  });

  it("invalidates once when a stamped producer bumps the geometry revision", function () {
    const fixture = createStampedFixture();
    const first = extractPrimitiveGeometry(fixture.runtimePrimitive);
    expect(extractPrimitiveGeometry(fixture.runtimePrimitive)).toBe(first);

    // A real re-stamp replaces the typed array AND bumps the revision.
    const before = getPrimitiveGeometryCacheDiagnostics();
    fixture.position.typedArray = new Int16Array([2, 4, 6, 8, 10, 12]);
    bumpGeometryRevision(fixture.position);
    const next = extractPrimitiveGeometry(fixture.runtimePrimitive);
    expect(next).not.toBe(first);
    const afterRebuild = getPrimitiveGeometryCacheDiagnostics();
    expect(afterRebuild.invalidationCount).toBe(before.invalidationCount + 1);
    expect(afterRebuild.descriptorBuildCount).toBe(
      before.descriptorBuildCount + 1,
    );

    // The rebuilt signature re-arms the fast path.
    expect(extractPrimitiveGeometry(fixture.runtimePrimitive)).toBe(next);
    expect(getPrimitiveGeometryCacheDiagnostics().revisionHitCount).toBe(
      afterRebuild.revisionHitCount + 1,
    );
  });

  it("catches an unstamped external typed-array swap via the deep-walk fallback", function () {
    // A producer we did NOT instrument replaces the typed array but forgets to
    // bump the revision. The fast path's data-identity guard rejects the stale
    // token and the walk rebuilds — no false HIT.
    const fixture = createStampedFixture();
    const first = extractPrimitiveGeometry(fixture.runtimePrimitive);

    fixture.position.typedArray = new Int16Array([9, 9, 9, 1, 1, 1]);
    const next = extractPrimitiveGeometry(fixture.runtimePrimitive);
    expect(next).not.toBe(first);
  });

  it("debug cross-check flags a fast-path hit that diverges from the deep walk", function () {
    // Simulate a MISSED stamp: mutate a scalar field in place without bumping
    // the revision and without changing the data identity. The fast path will
    // (wrongly) HIT; the debug cross-check must console.error the divergence.
    // (Debug-build only — the assertion runs in the unminified spec bundle.)
    const fixture = createStampedFixture();
    extractPrimitiveGeometry(fixture.runtimePrimitive);

    const errorSpy = spyOn(console, "error");
    fixture.position.componentDatatype = 5126; // FLOAT — was undefined
    extractPrimitiveGeometry(fixture.runtimePrimitive);
    expect(errorSpy).toHaveBeenCalled();
  });
});
