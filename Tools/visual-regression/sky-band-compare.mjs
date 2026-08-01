import { chromium } from "playwright";
import fs from "fs";
const A = process.argv[2],
  B = process.argv[3]; // off, on
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
await page.setContent("<!doctype html><html><body></body></html>");
const a64 = fs.readFileSync(A).toString("base64");
const b64 = fs.readFileSync(B).toString("base64");
const r = await page.evaluate(
  async ({ a64, b64 }) => {
    async function decode(s) {
      const img = new Image();
      img.src = "data:image/png;base64," + s;
      await img.decode();
      const cv = document.createElement("canvas");
      cv.width = img.width;
      cv.height = img.height;
      const ctx = cv.getContext("2d");
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, img.width, img.height);
    }
    const a = await decode(a64),
      b = await decode(b64);
    const da = a.data,
      db = b.data,
      w = a.width,
      h = a.height;
    // Sample only columns 0..480 (left half) to avoid UI overlays at top-center/right.
    function band(d, y0, y1) {
      let lum = 0,
        r = 0,
        g = 0,
        bb = 0,
        n = 0;
      for (let y = y0; y < y1; y++)
        for (let x = 0; x < 480; x++) {
          const i = (y * w + x) * 4;
          r += d[i];
          g += d[i + 1];
          bb += d[i + 2];
          lum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          n++;
        }
      return { lum: lum / n, r: r / n, g: g / n, b: bb / n };
    }
    // upper sky (zenith) 0.10-0.22; mid sky 0.30-0.42; near-horizon-above 0.44-0.50
    const zA = band(da, h * 0.1, h * 0.22),
      zB = band(db, h * 0.1, h * 0.22);
    const mA = band(da, h * 0.3, h * 0.42),
      mB = band(db, h * 0.3, h * 0.42);
    const hA = band(da, h * 0.44, h * 0.5),
      hB = band(db, h * 0.44, h * 0.5);
    return { zA, zB, mA, mB, hA, hB };
  },
  { a64, b64 },
);
await browser.close();
const f = (o) =>
  `lum=${o.lum.toFixed(1)} rgb=(${o.r.toFixed(0)},${o.g.toFixed(0)},${o.b.toFixed(0)})`;
const pct = (a, b) => (((b - a) / a) * 100).toFixed(1);
console.log(
  `ZENITH  OFF ${f(r.zA)}  ON ${f(r.zB)}  lift=${pct(r.zA.lum, r.zB.lum)}%`,
);
console.log(
  `MIDSKY  OFF ${f(r.mA)}  ON ${f(r.mB)}  lift=${pct(r.mA.lum, r.mB.lum)}%`,
);
console.log(
  `NEARHZN OFF ${f(r.hA)}  ON ${f(r.hB)}  lift=${pct(r.hA.lum, r.hB.lum)}%`,
);
