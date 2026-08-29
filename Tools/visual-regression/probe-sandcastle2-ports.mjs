// Sandcastle2 port diagnosis: load the same demo through the guarded opener
// on the outer app origin and directly on the inner bucket origin, and
// compare. Bounded, always closes the browser.
// @purpose One-off diagnosis loading the same Sandcastle2 demo, through the guarded opener, on the outer app origin vs directly on the inner bucket origin, and comparing.
// @status INVESTIGATION
//
// PORT SAFETY. Ports are read from `PROBE_SANDCASTLE2_PORT_OUTER` /
// `PROBE_SANDCASTLE2_PORT_INNER`, defaulting to 8134/8135 — never 8080/8081.
// This file used to hard-code exactly those two ports, which is the incident
// class `sandcastle2-origin-rewrite.mjs` exists to prevent: an unconfigured
// run of this script would have silently opened the maintainer's live
// server.
//
// ROUTED THROUGH THE GUARDED OPENER. Both legs go through
// `createGuardedPage` + `openSandcastle2Url`, exactly like every other
// opener of the built app — an executable opener is not exempt from the
// guard just because its purpose is diagnostic rather than a pass/fail
// gate. The diagnostic value survives intact: a leg that lands where it was
// asked to reports the same console/iframe observations as before; a leg
// that gets redirected away (the expected shape for the INNER leg — a
// top-level navigation straight at the run-frame mirror, which the app was
// never designed to be opened from directly, and which its own baked
// redirect script sends back toward the outer origin) now reports the named
// `OriginRewriteRefusal` — which origin was requested, which one the app
// actually produced, and why — instead of either silently completing on the
// wrong origin or crashing the whole script.
//
// `PROBE_SANDCASTLE2_BAKED_OUTER` / `PROBE_SANDCASTLE2_BAKED_INNER` (both
// optional) tell the rewrite what origins the ALREADY-RUNNING server under
// test was actually built with, for a build baked with non-default ports;
// left unset, the module's own defaults (`http://localhost:8080` /
// `:8081` — what `server.js` bakes in by default) are used, which is the
// common case: this script deliberately navigates on OTHER ports
// (8134/8135 by default) so the rewrite has real work to do.
import { chromium } from "playwright";

import {
  OriginRewriteRefusal,
  createGuardedPage,
} from "./lib/sandcastle2-origin-rewrite.mjs";
import { openSandcastle2Url } from "./lib/sandcastle2-renderer-gate.mjs";

const DEMO = "gltf-pbr-extensions";
const OUTER_PORT = process.env.PROBE_SANDCASTLE2_PORT_OUTER || "8134";
const INNER_PORT = process.env.PROBE_SANDCASTLE2_PORT_INNER || "8135";
const OUTER_ORIGIN = `http://localhost:${OUTER_PORT}`;
const INNER_ORIGIN = `http://localhost:${INNER_PORT}`;
const BAKED_OUTER = process.env.PROBE_SANDCASTLE2_BAKED_OUTER || undefined;
const BAKED_INNER = process.env.PROBE_SANDCASTLE2_BAKED_INNER || undefined;

/**
 * One leg of the diagnosis: open the demo with `requestedOrigin` as the
 * top-level target (and `INNER_ORIGIN` as the bucket mirror, for both legs —
 * the inner leg is not expected to get far enough to reach the bucket-frame
 * wait at all), through the guarded opener, and report either where it
 * actually landed or the named refusal.
 *
 * @param {import("playwright").Browser} browser
 * @param {string} requestedOrigin
 * @returns {Promise<object>} A plain diagnostic record, never throws.
 */
async function runLeg(browser, requestedOrigin) {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 800 },
  });
  const msgs = [];
  const page = await createGuardedPage(context, {
    servedOrigin: requestedOrigin,
    bucketOrigin: INNER_ORIGIN,
    ...(BAKED_OUTER && { bakedServedOrigin: BAKED_OUTER }),
    ...(BAKED_INNER && { bakedBucketOrigin: BAKED_INNER }),
  });
  page.on("console", (m) => {
    const t = m.text();
    if (
      msgs.length < 40 &&
      (m.type() === "error" ||
        /postMessage|origin|bucket|runComplete|Viewer|Cannot/i.test(t))
    ) {
      msgs.push(`[${m.type()}] ${t.slice(0, 200)}`);
    }
  });
  page.on("pageerror", (e) =>
    msgs.push(`[pageerror] ${String(e).slice(0, 200)}`),
  );

  const record = { requestedOrigin, msgs, refusal: null, state: null };
  let structuralRefusal = null;
  try {
    try {
      const opened = await openSandcastle2Url(
        page,
        {
          base: requestedOrigin,
          bucketBase: INNER_ORIGIN,
          bakedServedOrigin: BAKED_OUTER,
          bakedBucketOrigin: BAKED_INNER,
          id: DEMO,
          renderer: "webgpu",
        },
        { timeoutMs: 30000 },
      );
      record.finalUrl = opened.finalUrl;
      await page.waitForTimeout(14000); // fixed bounded wait for demo run
      await page.screenshot({
        path: `Tools/visual-regression/output/sc2-port-${new URL(requestedOrigin).port}.png`,
      });
      record.state = await page
        .evaluate(() => {
          const ifr = document.querySelector("iframe");
          return {
            iframeSrc: ifr?.getAttribute("src") || null,
            bodyText: (document.body.innerText || "").slice(0, 120),
            loc: location.origin,
          };
        })
        .catch((e) => ({ err: String(e).slice(0, 120) }));
    } catch (error) {
      if (error instanceof OriginRewriteRefusal) {
        // THE diagnostic result for a leg that gets redirected away — named,
        // structured, and reported below instead of crashing the script.
        structuralRefusal = error;
        record.refusal = {
          code: error.code,
          reason: error.reason,
          observedOrigin: error.observedOrigin ?? null,
          expectedOrigin: error.expectedOrigin ?? null,
        };
      } else {
        record.error = String(error?.message ?? error).slice(0, 300);
      }
    }
  } finally {
    try {
      await page.close();
    } catch (closeErr) {
      if (!structuralRefusal && closeErr instanceof OriginRewriteRefusal) {
        record.refusal = {
          code: closeErr.code,
          reason: closeErr.reason,
          observedOrigin: closeErr.observedOrigin ?? null,
          expectedOrigin: closeErr.expectedOrigin ?? null,
        };
      }
    }
    await context.close().catch(() => {});
  }
  return record;
}

let browser;
let browserCloseError = null;
const results = {};
try {
  browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  results.outer = await runLeg(browser, OUTER_ORIGIN);
  results.inner = await runLeg(browser, INNER_ORIGIN);
} finally {
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      browserCloseError = error;
    }
  }
}

for (const [legName, r] of Object.entries(results)) {
  console.log(
    `\n═══════ ${legName.toUpperCase()} LEG (requested ${r.requestedOrigin}) ═══════`,
  );
  if (r.refusal) {
    console.log(
      `REFUSED: ${r.refusal.code} — requested ${r.refusal.expectedOrigin}, landed on ${r.refusal.observedOrigin}`,
    );
    console.log(`reason: ${r.refusal.reason}`);
  } else if (r.error) {
    console.log(`ERROR (not an origin refusal): ${r.error}`);
  } else {
    console.log("finalUrl:", r.finalUrl);
    console.log("loc:", r.state?.loc, "| iframe src:", r.state?.iframeSrc);
  }
  console.log("console (" + r.msgs.length + "):");
  for (const m of r.msgs) {
    console.log("  " + m);
  }
}

if (browserCloseError) {
  throw browserCloseError;
}
