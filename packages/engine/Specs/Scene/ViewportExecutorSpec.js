import { beginSecondaryViewportSegment } from "../../Source/Scene/ViewportExecutor.js";

describe("Scene/ViewportExecutor", function () {
  it("segments the frame-local context before a wrapped second viewport", function () {
    const sceneContextBoundary = jasmine.createSpy("sceneContextBoundary");
    const frameContextBoundary = jasmine.createSpy("frameContextBoundary");
    const scene = {
      context: { beginSecondaryViewport: sceneContextBoundary },
      frameState: {
        context: { beginSecondaryViewport: frameContextBoundary },
      },
      _is2DViewportSplit: true,
    };

    beginSecondaryViewportSegment(false, scene);

    expect(frameContextBoundary).toHaveBeenCalledTimes(1);
    expect(sceneContextBoundary).not.toHaveBeenCalled();
  });

  it("does not segment a first or non-wrapped viewport", function () {
    const boundary = jasmine.createSpy("boundary");
    const scene = {
      frameState: { context: { beginSecondaryViewport: boundary } },
      _is2DViewportSplit: true,
    };

    beginSecondaryViewportSegment(true, scene);
    scene._is2DViewportSplit = false;
    beginSecondaryViewportSegment(false, scene);

    expect(boundary).not.toHaveBeenCalled();
  });
});
