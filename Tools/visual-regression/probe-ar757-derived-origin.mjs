// probe-ar757-derived-origin.mjs — the Edge acceptance for AR-757 / L2-DAT-1.
//
// @purpose Counts, in Edge, how many requests the browser actually sends to a cross-origin derived url carrying the parent resource's request header or its query parameter, so AR-757's acceptance is a network measurement rather than an inspection of the Resource object.
// @status ACTIVE
// @runtime lib/probe-runtime.mjs
//
// ── WHAT IT ANSWERS ─────────────────────────────────────────────────────────
//
//   AR-757. An authenticated parent resource on the page's own origin derives
//           an ABSOLUTE url on a different origin — the shape CZML `uri`,
//           KML `<href>` and 3D Tiles `content.uri` all reach
//           `Resource.getDerivedResource` with. Acceptance: requests to the
//           far origin carrying `X-Probe` = 0, carrying `token=` = 0, while
//           the same-origin control and a three-deep same-origin chain each
//           still carry both, 1 / 1.
//
// ── THE TWO ORIGINS ─────────────────────────────────────────────────────────
//
// There is exactly one server: the fork's own `node server.js`. The page is
// loaded through `localhost` and the far url names `127.0.0.1` on the same
// port. Those are two different origins by the only rule that matters here
// (scheme + host + port string equality) while remaining one local process —
// no external host is ever contacted, by construction.
//
// ── WHAT IS COUNTED, AND WHY IT IS THE REQUEST AND NOT THE RESPONSE ─────────
//
// The count comes from Playwright's `request` event, which fires when the
// browser emits the request — before DNS, before CORS decides anything about
// the response. That is the right instant: the defect is that credentials
// LEAVE the browser for a host the document named, and a request later
// refused by CORS has already left. A failing far-origin request is therefore
// expected and is not a refusal.
//
// A cross-origin request carrying a non-simple header is preceded by a CORS
// preflight, which does not repeat `X-Probe` but does announce it in
// `access-control-request-headers`. Both spellings count as carrying the
// parent's header, so a pre-fix (or mutant) engine cannot score zero merely
// because the browser turned the GET into an OPTIONS.
//
// ── PRECONDITIONS ───────────────────────────────────────────────────────────
//
//   * `npx gulp build` has run, so `/Build/CesiumUnminified/` is current.
//   * `node server.js --port 8094 --serve-built` is running. Load through
//     `localhost`; the far leg names `127.0.0.1` deliberately.
//   * Edge, not Firefox.
//
// Run:
//   node Tools/visual-regression/probe-ar757-derived-origin.mjs
//   node Tools/visual-regression/probe-ar757-derived-origin.mjs --headed

import { ProbeRefusal, isEntryPoint, runProbe } from "./lib/probe-runtime.mjs";

const HARNESS_PATH =
  "/Tools/visual-regression/ar757-derived-origin-harness.html";

const PROBE_HEADER = "x-probe";
const TOKEN_PARAMETER = "token=";

/**
 * True when a recorded request carried the parent's header, either directly or
 * as a CORS preflight announcement of it.
 *
 * @param {{headers: Record<string,string>}} entry One recorded request.
 * @returns {boolean} Whether the parent's header travelled with it.
 */
export function carriedProbeHeader(entry) {
  if (PROBE_HEADER in entry.headers) {
    return true;
  }
  const announced = entry.headers["access-control-request-headers"];
  return (
    typeof announced === "string" &&
    announced.toLowerCase().includes(PROBE_HEADER)
  );
}

/**
 * True when a recorded request carried the parent's query parameter.
 *
 * @param {{url: string}} entry One recorded request.
 * @returns {boolean} Whether the parent's query parameter travelled with it.
 */
export function carriedTokenParameter(entry) {
  return entry.url.includes(TOKEN_PARAMETER);
}

/**
 * AR-757's acceptance over the recorded traffic of every cell.
 *
 * @param {Array<object>} cells Every recorded cell.
 * @returns {Array<object>} Three verdicts per cell.
 */
export function buildAr757Verdicts(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const far = cell.legs.crossOrigin;
    const near = cell.legs.sameOrigin;
    const chain = cell.legs.chain;
    verdicts.push({
      id: `${cell.renderer}/run${cell.run}/cross-origin`,
      claim:
        "AR-757 — a cross-origin derived url receives neither the header nor the query parameter",
      requests: far.total,
      withHeader: far.withHeader,
      withToken: far.withToken,
      pass: far.total > 0 && far.withHeader === 0 && far.withToken === 0,
    });
    verdicts.push({
      id: `${cell.renderer}/run${cell.run}/same-origin-control`,
      claim: "AR-757 — the same-origin control still carries both, 1 / 1",
      requests: near.total,
      withHeader: near.withHeader,
      withToken: near.withToken,
      pass: near.withHeader === 1 && near.withToken === 1,
    });
    verdicts.push({
      id: `${cell.renderer}/run${cell.run}/three-deep-chain`,
      claim:
        "AR-757 — a three-deep same-origin derivation chain still carries both",
      requests: chain.total,
      withHeader: chain.withHeader,
      withToken: chain.withToken,
      pass: chain.withHeader === 1 && chain.withToken === 1,
    });
  }
  return verdicts;
}

/**
 * Records every request the page emits to one origin while a leg runs.
 *
 * @param {import("playwright").Page} page The page under measurement.
 * @param {string} originPrefix Only requests whose url starts with this count.
 * @param {Function} leg The async work to measure.
 * @returns {Promise<object>} The leg's counts and the recorded entries.
 */
async function measureLeg(page, originPrefix, leg) {
  const entries = [];
  const listener = (request) => {
    const url = request.url();
    if (url.startsWith(originPrefix)) {
      entries.push({
        url,
        method: request.method(),
        headers: request.headers(),
      });
    }
  };
  page.on("request", listener);
  let record;
  try {
    record = await leg();
  } finally {
    // Request events are delivered asynchronously; give the ones already in
    // flight a turn before the listener comes off.
    await page.waitForTimeout(500);
    page.off("request", listener);
  }
  return {
    record,
    total: entries.length,
    withHeader: entries.filter(carriedProbeHeader).length,
    withToken: entries.filter(carriedTokenParameter).length,
    entries,
  };
}

/**
 * Runs one backend's cell: load the harness, then the three legs.
 *
 * @param {object} options Cell inputs.
 * @returns {Promise<object>} The cell's result.
 */
async function runCell({ browser, harness, origin, farOrigin, renderer, run }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message)));

  await page.goto(harness, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => window.Cesium !== undefined, null, {
    timeout: 60000,
  });

  const legs = {};

  legs.crossOrigin = await measureLeg(page, farOrigin, () =>
    page.evaluate((a) => window.__deriveAndFetch(a), {
      parentUrl: `${origin}/Apps/ar757/scene.czml`,
      derivedUrl: `${farOrigin}/Apps/ar757/billboard.png`,
    }),
  );
  legs.sameOrigin = await measureLeg(page, `${origin}/Apps/ar757/`, () =>
    page.evaluate((a) => window.__deriveAndFetch(a), {
      parentUrl: `${origin}/Apps/ar757/scene.czml`,
      derivedUrl: "billboard.png",
    }),
  );
  legs.chain = await measureLeg(page, `${origin}/Apps/ar757chain/`, () =>
    page.evaluate((a) => window.__deriveAndFetch(a), {
      parentUrl: `${origin}/Apps/ar757chain/scene.czml`,
      derivedUrl: "leaf.png",
      chain: true,
    }),
  );

  const errors = await page.evaluate(() => window.__errors.slice());
  await context.close();

  if (legs.crossOrigin.total === 0) {
    throw new ProbeRefusal(
      "no-far-origin-request",
      "the far origin was never requested, so nothing was measured",
      { renderer, legs },
    );
  }

  return { renderer, run, legs, pageErrors: [...pageErrors, ...errors] };
}

function printReport(receipt) {
  console.log("\n── AR-757 ──");
  for (const verdict of receipt.verdicts) {
    console.log(
      `${verdict.pass ? "PASS" : "FAIL"} ${verdict.id} ` +
        `requests=${verdict.requests} withHeader=${verdict.withHeader} withToken=${verdict.withToken}`,
    );
  }
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "ar757-derived-origin",
  title: "AR-757 — derived-resource credentials stop at the origin boundary",
  outputSubdirectory: "ar757-derived-origin",
  receiptEnvelope: "probe-owned",
  async cells({ browser, run, options, origin }) {
    // One server, two origin strings. The harness loads through `localhost`;
    // `127.0.0.1` is the far origin.
    const farOrigin = origin.replace("localhost", "127.0.0.1");
    if (farOrigin === origin) {
      throw new ProbeRefusal(
        "single-origin-run",
        `the probe needs two origin strings and the runtime resolved ${origin}; it must contain "localhost" so the far leg can name 127.0.0.1`,
        { origin },
      );
    }
    const harness = `${origin}${HARNESS_PATH}`;
    const produced = [];
    for (const renderer of options.renderers) {
      produced.push(
        await runCell({ browser, harness, origin, farOrigin, renderer, run }),
      );
    }
    return produced;
  },
  verdicts(cells) {
    return buildAr757Verdicts(cells);
  },
  receipt(cells, context) {
    const receipt = {
      generatedAt: context.generatedAt,
      harness: `${context.origin}${HARNESS_PATH}`,
      verdicts: context.verdicts,
      cells,
    };
    if (cells.length > 0) {
      printReport(receipt);
    }
    return receipt;
  },
  summary(receipt) {
    const passed = receipt.verdicts.filter((v) => v.pass === true).length;
    return [
      "# AR-757 derived-resource origin boundary",
      "",
      `Generated: ${receipt.generatedAt}`,
      "",
      `Harness: \`${receipt.harness}\``,
      "",
      `AR-757: ${passed}/${receipt.verdicts.length} verdicts passed.`,
      "",
    ].join("\n");
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
