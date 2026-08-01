import {
  commitEnvironmentalFullscreenStage,
  destroyEnvironmentalEffectsCompositor,
  presentEnvironmentalEffectsComposition,
  selectEnvironmentalCompositionTarget,
  selectEnvironmentalWeatherRoute,
} from "../../../Source/Renderer/WebGPU/WebGPUEnvironmentalEffectsCompositor.js";

function makeState(snapshotView, pingView) {
  return {
    snapshotView,
    pingView,
    sourceView: snapshotView,
    targetView: pingView,
    wrote: false,
  };
}

describe("Renderer/WebGPU/WebGPUEnvironmentalEffectsCompositor", function () {
  it("alternates stable targets without ever sampling its render target", function () {
    const snapshot = { label: "snapshot" };
    const ping = { label: "ping" };

    expect(selectEnvironmentalCompositionTarget(snapshot, snapshot, ping)).toBe(
      ping,
    );
    expect(selectEnvironmentalCompositionTarget(ping, snapshot, ping)).toBe(
      snapshot,
    );
    expect(
      selectEnvironmentalCompositionTarget(
        { label: "foreign" },
        snapshot,
        ping,
      ),
    ).toBeNull();
  });

  it("does not advance when a culled or not-ready stage records nothing", function () {
    const snapshot = { label: "snapshot" };
    const ping = { label: "ping" };
    const state = makeState(snapshot, ping);

    commitEnvironmentalFullscreenStage(state, false);

    expect(state.sourceView).toBe(snapshot);
    expect(state.targetView).toBe(ping);
    expect(state.wrote).toBeFalse();
  });

  it("feeds every recorded full-screen stage from the previous result", function () {
    const snapshot = { label: "snapshot" };
    const ping = { label: "ping" };
    const state = makeState(snapshot, ping);
    const edges = [];

    for (let i = 0; i < 3; i++) {
      edges.push([state.sourceView, state.targetView]);
      commitEnvironmentalFullscreenStage(state, true);
    }

    expect(edges).toEqual([
      [snapshot, ping],
      [ping, snapshot],
      [snapshot, ping],
    ]);
    expect(state.sourceView).toBe(ping);
    expect(state.targetView).toBe(snapshot);
    expect(state.wrote).toBeTrue();
  });

  it("keeps weather-only direct and routes weather offscreen only for fog", function () {
    expect(selectEnvironmentalWeatherRoute(false, false, false)).toBe(
      "direct-canvas",
    );
    expect(selectEnvironmentalWeatherRoute(false, true, false)).toBe(
      "direct-canvas",
    );
    expect(selectEnvironmentalWeatherRoute(false, true, true)).toBe(
      "present-then-canvas",
    );
    expect(selectEnvironmentalWeatherRoute(true, true, false)).toBe(
      "offscreen-before-fog",
    );
    expect(selectEnvironmentalWeatherRoute(true, true, true)).toBe(
      "offscreen-before-fog",
    );
  });

  it("does not resume or present the canvas when the graph has no writes", function () {
    const resume = jasmine.createSpy("resumeDefaultRenderPass");
    const context = { resumeDefaultRenderPass: resume };
    const state = makeState({ label: "snapshot" }, { label: "ping" });

    expect(presentEnvironmentalEffectsComposition(context, state)).toBeFalse();
    expect(resume).not.toHaveBeenCalled();
  });

  it("releases the snapshot side during teardown or device recovery", function () {
    const destroy = jasmine.createSpy("destroy snapshot");
    const context = {
      _postProcessSnapshotTexture: { destroy },
      _postProcessSnapshotView: { label: "snapshot" },
      _postProcessSnapshotWidth: 1920,
      _postProcessSnapshotHeight: 1080,
      _postProcessSnapshotDevice: { label: "old device" },
    };

    destroyEnvironmentalEffectsCompositor(context);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(context._postProcessSnapshotTexture).toBeNull();
    expect(context._postProcessSnapshotView).toBeNull();
    expect(context._postProcessSnapshotWidth).toBe(0);
    expect(context._postProcessSnapshotHeight).toBe(0);
    expect(context._postProcessSnapshotDevice).toBeNull();
  });
});
