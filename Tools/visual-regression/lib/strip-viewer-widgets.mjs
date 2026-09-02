// Shared page-side widget-removal helper for probes that take a Playwright
// ELEMENT screenshot of the CesiumViewer canvas.
//
// INSTRUMENT DEFECT THIS CLOSES (found 2026-08-28, Edge-executor tranche 2,
// Job 2): a Playwright element screenshot of the CesiumViewer canvas
// composites whatever the browser has visually stacked over that element's
// bounding rect — the toolbar, the navigation-help popup, the animation
// clock, the timeline and the credit line all sit at absolute positions
// inside (not merely around) the canvas's rectangle. A per-pixel metric taken
// from such a capture is partly measuring DOM chrome, not the scene: a metric
// like "fraction of border pixels that are near-black" can never read high
// because the chrome is never black.
//
// Exported as SOURCE TEXT because `page.evaluate` cannot close over a Node
// import — the string is evaluated in page scope, not this module's scope.
//
// Repatriated (CLAUDE.md Evidence Repatriation) from lane-setup.mjs, which
// lived as a sibling of probe-gpucull-blackframe-isolation.mjs under a
// gitignored output/ directory.

export const STRIP_WIDGETS_SOURCE = `() => {
  const selectors = [
    ".cesium-viewer-toolbar",
    ".cesium-viewer-animationContainer",
    ".cesium-viewer-timelineContainer",
    ".cesium-viewer-bottom",
    ".cesium-viewer-fullscreenContainer",
    ".cesium-viewer-geocoderContainer",
    ".cesium-viewer-vrContainer",
    ".cesium-viewer-infoBoxContainer",
    ".cesium-navigation-help",
    ".cesium-widget-credits",
    ".cesium-credit-lightbox-overlay",
  ];
  let removed = 0;
  for (const sel of selectors) {
    for (const el of document.querySelectorAll(sel)) {
      el.remove();
      removed++;
    }
  }
  // Anything still stacked over the canvas is a capture contaminant.
  const canvas = document.querySelector("canvas");
  const leftovers = [];
  if (canvas) {
    const r = canvas.getBoundingClientRect();
    for (const el of document.body.querySelectorAll("*")) {
      if (el === canvas || el.contains(canvas)) continue;
      const b = el.getBoundingClientRect();
      if (b.width < 2 || b.height < 2) continue;
      const overlaps =
        b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top;
      if (overlaps && getComputedStyle(el).visibility !== "hidden")
        leftovers.push(el.className || el.tagName);
    }
  }
  return { removed, leftovers: leftovers.slice(0, 8) };
}`;
