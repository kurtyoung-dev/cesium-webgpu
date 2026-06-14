// validate-sgp4.mjs — validate the JS FP64 SGP4 (sgp4-reference.mjs) against
// python-sgp4 2.25 reference vectors. Not a probe; a dev gate that proves the
// JS reference IS SGP4 before the GPU kernel is checked against it.
import { readFileSync } from "node:fs";
import { sgp4init, sgp4, gstime } from "./sgp4-reference.mjs";

const ref = JSON.parse(readFileSync("/tmp/sgp4_ref.json", "utf8"));
let worst = 0;
let worstName = "";
for (const [name, sat] of Object.entries(ref)) {
  const s = sgp4init(sat.l1, sat.l2);
  // Cross-check epoch JD + GMST init against python-sgp4.
  const jdErr = Math.abs(s.jd + s.jdFrac - (sat.jd + sat.jdF));
  const gstoErr = Math.abs(s.gsto - sat.gsto);
  console.log(
    `${name.padEnd(9)} deep=${s.isDeepSpace} (py=${sat.deep}) period=${s.periodMin.toFixed(2)}min  jdErr=${jdErr.toExponential(2)}  gstoErr=${gstoErr.toExponential(2)}`,
  );
  if (s.isDeepSpace) {
    console.log(`  -> DEEP SPACE: skipping position check (SDP4 deferred)`);
    continue;
  }
  for (const rec of sat.recs) {
    const r = sgp4(s, rec.tmin);
    const dx = r[0] - rec.r_km[0];
    const dy = r[1] - rec.r_km[1];
    const dz = r[2] - rec.r_km[2];
    const errM = Math.sqrt(dx * dx + dy * dy + dz * dz) * 1000.0;
    if (errM > worst) {
      worst = errM;
      worstName = `${name}@${rec.tmin}min`;
    }
    console.log(`  t=${String(rec.tmin).padStart(5)}min  err=${errM.toFixed(4)} m`);
  }
}
console.log(`\nWORST JS-vs-python err: ${worst.toFixed(4)} m (${worstName})`);
const OK = worst < 1.0; // sub-meter agreement with python-sgp4
console.log(OK ? "JS SGP4 VALIDATED (< 1 m)" : "JS SGP4 MISMATCH");
process.exit(OK ? 0 : 1);
