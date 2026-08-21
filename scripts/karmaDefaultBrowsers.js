export function resolveDefaultBrowsers(
  chromeBin,
  debug = false,
  browsersOverride,
) {
  if (browsersOverride) {
    return browsersOverride.split(",");
  }
  if (debug) {
    return ["ChromeDebugging"];
  }
  return /msedge/i.test(chromeBin ?? "") ? ["EdgeCompat"] : ["Chrome"];
}
