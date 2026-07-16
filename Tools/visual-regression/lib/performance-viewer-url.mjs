export function buildPerformanceViewerUrl(baseUrl, renderer) {
  const url = new URL(baseUrl);
  url.searchParams.set("renderer", renderer);
  url.searchParams.set("offline", "true");
  return url;
}
