// Sandcastle2 port diagnosis: load the same demo on :8080 (outer app origin) and
// :8081 (inner bucket origin) and compare. Bounded, always closes the browser.
// @purpose One-off diagnosis loading the same Sandcastle2 demo on the outer :8080 app origin vs inner :8081 bucket origin and comparing.
// @status INVESTIGATION
//
import { chromium } from "playwright";

const DEMO = "gltf-pbr-extensions";
const ports = [8080, 8081];
const out = {};
let browser;
try {
  browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  for (const port of ports) {
    const msgs = [];
    const page = await browser.newPage({
      viewport: { width: 1400, height: 800 },
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
    const url = `http://localhost:${port}/Apps/Sandcastle2/index.html?id=${DEMO}`;
    await page.goto(url, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(14000); // fixed bounded wait for demo run
    // Did any canvas paint inside the run iframe? Screenshot the whole page.
    await page.screenshot({
      path: `Tools/visual-regression/output/sc2-port-${port}.png`,
    });
    // Probe the run-frame readiness flag the parent tracks, if exposed.
    const state = await page
      .evaluate(() => {
        const ifr = document.querySelector("iframe");
        return {
          iframeSrc: ifr?.getAttribute("src") || null,
          bodyText: (document.body.innerText || "").slice(0, 120),
          loc: location.origin,
        };
      })
      .catch((e) => ({ err: String(e).slice(0, 120) }));
    out[port] = { url, state, msgs };
    await page.close();
  }
} finally {
  if (browser) await browser.close();
}
for (const port of ports) {
  console.log(`\n═══════ PORT ${port} ═══════`);
  console.log(
    "loc:",
    out[port].state.loc,
    "| iframe src:",
    out[port].state.iframeSrc,
  );
  console.log("console (" + out[port].msgs.length + "):");
  for (const m of out[port].msgs) console.log("  " + m);
}
