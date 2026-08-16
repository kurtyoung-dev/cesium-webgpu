// @purpose One-function helper building the offline CesiumViewer URL with the renderer query param for performance runs.
// @status ACTIVE

export function buildPerformanceViewerUrl(baseUrl, renderer) {
  const url = new URL(baseUrl);
  url.searchParams.set("renderer", renderer);
  url.searchParams.set("offline", "true");
  return url;
}
