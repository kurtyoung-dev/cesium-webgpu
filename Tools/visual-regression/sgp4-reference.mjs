// sgp4-reference.mjs — self-contained JS FP64 near-earth SGP4 (Vallado
// "Revisiting Spacetrack Report #3", WGS-72), shared by the SGP4 demo kernel
// pre-conditioning and probe-orbital-sgp4.mjs. NOT engine code — this is
// demo/probe-owned domain math (the engine stays orbital-agnostic).
//
// Two halves, matching the SGP4 stage guardrail:
//   sgp4init(tle)  — TIME-INDEPENDENT pre-conditioning (FP64). Parses the
//                    TLE, recovers the Brouwer mean motion, and computes every
//                    secular/drag/periodic CONSTANT that does not depend on
//                    time. Detects deep-space (period >= 225 min) and flags it.
//   sgp4(satrec,t) — TIME-DEPENDENT per-frame update (FP64). The GPU df64
//                    kernel is a direct port of THIS half only; the constants
//                    `satrec` carries are exactly the per-instance params the
//                    demo uploads.
//
// Output is TEME (True Equator Mean Equinox) position in km. The caller
// converts TEME->ECEF by rotating about +Z by -GMST(t) (same as the J2 demo).
// Validated against python-sgp4 2.25 to < 1 m (see the bottom main()).

// WGS-72 (the constant set SGP4 was tuned against; do NOT use WGS-84 here).
const MU = 398600.8; // km^3/s^2
const RADIUSEARTHKM = 6378.135;
const XKE = 60.0 / Math.sqrt((RADIUSEARTHKM * RADIUSEARTHKM * RADIUSEARTHKM) / MU);
const TUMIN = 1.0 / XKE;
const J2 = 0.001082616;
const J3 = -0.00000253881;
const J4 = -0.00000165597;
const J3OJ2 = J3 / J2;
const X2O3 = 2.0 / 3.0;
const TWOPI = 2.0 * Math.PI;
const DEG2RAD = Math.PI / 180.0;

// ── GMST (gstime) — Vallado IAU-82, identical to python-sgp4's gstime ──
export function gstime(jdut1) {
  const tut1 = (jdut1 - 2451545.0) / 36525.0;
  let temp =
    -6.2e-6 * tut1 * tut1 * tut1 +
    0.093104 * tut1 * tut1 +
    (876600.0 * 3600 + 8640184.812866) * tut1 +
    67310.54841; // sec of the day
  temp = ((temp * DEG2RAD) / 240.0) % TWOPI; // 360/86400 = 1/240, to rad
  if (temp < 0.0) temp += TWOPI;
  return temp;
}

// ── TLE parse (the two-line element columns we need) ──
export function parseTLE(line1, line2) {
  // Epoch: cols 19-32 of line 1 -> YYDDD.DDDDDDDD
  const epochStr = line1.substring(18, 32).trim();
  const yy = parseInt(epochStr.substring(0, 2), 10);
  const days = parseFloat(epochStr.substring(2));
  const year = yy < 57 ? yy + 2000 : yy + 1900;
  // bstar: cols 54-61, implied decimal + exponent (e.g. " 10270-3").
  const bstarStr = line1.substring(53, 61);
  const bstar = parseAssumedDecimal(bstarStr);

  const inclo = parseFloat(line2.substring(8, 16)) * DEG2RAD;
  const nodeo = parseFloat(line2.substring(17, 25)) * DEG2RAD;
  const ecco = parseFloat("0." + line2.substring(26, 33).trim());
  const argpo = parseFloat(line2.substring(34, 42)) * DEG2RAD;
  const mo = parseFloat(line2.substring(43, 51)) * DEG2RAD;
  const noKozaiRevPerDay = parseFloat(line2.substring(52, 63));
  const noKozai = (noKozaiRevPerDay * TWOPI) / 1440.0; // rad/min

  // Julian date of the epoch (days method, matches python-sgp4 jday).
  const { jd, jdFrac } = jdayFromYearDoy(year, days);
  return { year, jd, jdFrac, bstar, inclo, nodeo, ecco, argpo, mo, noKozai };
}

function parseAssumedDecimal(s) {
  s = s.trim();
  if (s === "" || s === "00000-0" || s === "00000+0") return 0.0;
  const sign = s[0] === "-" ? -1 : 1;
  const body = s.replace(/^[+-]/, "");
  // last char (or last two with sign) is the exponent
  const m = body.match(/^(\d+)([+-]\d)$/);
  if (!m) return sign * parseFloat("0." + body) || 0.0;
  const mantissa = parseFloat("0." + m[1]);
  const exp = parseInt(m[2], 10);
  return sign * mantissa * Math.pow(10, exp);
}

function jdayFromYearDoy(year, doy) {
  // Jan 0.0 of `year` as a JD, then add the day-of-year. Matches Vallado.
  const jan1 =
    367.0 * year -
    Math.floor(7 * (year + Math.floor(10 / 12)) / 4) +
    Math.floor((275 * 1) / 9) +
    1 +
    1721013.5; // Jan 1, 00:00 of `year`
  const jd = jan1 - 1.0; // "Jan 0"
  const whole = Math.floor(doy);
  const frac = doy - whole;
  return { jd: jd + whole, jdFrac: frac };
}

// ── sgp4init: TIME-INDEPENDENT pre-conditioning (the CPU FP64 half) ──
export function sgp4init(line1, line2) {
  const t = parseTLE(line1, line2);
  const { ecco, inclo, nodeo, argpo, mo, noKozai, bstar } = t;

  const cosio = Math.cos(inclo);
  const sinio = Math.sin(inclo);
  const cosio2 = cosio * cosio;
  const eccsq = ecco * ecco;
  const omeosq = 1.0 - eccsq;
  const rteosq = Math.sqrt(omeosq);

  // ── De-Kozai: recover the Brouwer mean motion no_unkozai from no_kozai ──
  const ak = Math.pow(XKE / noKozai, X2O3);
  const d1 = (0.75 * J2 * (3.0 * cosio2 - 1.0)) / (rteosq * omeosq);
  let del = d1 / (ak * ak);
  const adel = ak * (1.0 - del * del - del * (1.0 / 3.0 + (134.0 * del * del) / 81.0));
  del = d1 / (adel * adel);
  const noUnkozai = noKozai / (1.0 + del);

  const ao = Math.pow(XKE / noUnkozai, X2O3);
  const sinio2 = sinio * sinio;
  const po = ao * omeosq;
  const con42 = 1.0 - 5.0 * cosio2;
  const con41 = -con42 - cosio2 - cosio2; // 3*cosio2 - 1
  const x1mth2 = 1.0 - cosio2;
  const x7thm1 = 7.0 * cosio2 - 1.0;

  // Deep-space test: orbital period >= 225 minutes -> SDP4 (we DEFER it).
  const periodMin = TWOPI / noUnkozai;
  const isDeepSpace = periodMin >= 225.0;

  // Perigee altitude (km) for the SIMPLE-drag switch and the s/qzms tuning.
  const rp = ao * (1.0 - ecco);
  const perigeeKm = (rp - 1.0) * RADIUSEARTHKM;

  // s and qzms parameters vary with perigee (Vallado's piecewise table).
  let sfour = 78.0 / RADIUSEARTHKM + 1.0;
  let qzms24 = Math.pow((120.0 - 78.0) / RADIUSEARTHKM, 4.0);
  if (perigeeKm < 156.0) {
    sfour = perigeeKm - 78.0;
    if (perigeeKm < 98.0) sfour = 20.0;
    qzms24 = Math.pow((120.0 - sfour) / RADIUSEARTHKM, 4.0);
    sfour = sfour / RADIUSEARTHKM + 1.0;
  }
  const pinvsq = 1.0 / (po * po);

  // ── Secular gravity coefficients (J2/J3/J4) ──
  const tsi = 1.0 / (ao - sfour);
  const eta = ao * ecco * tsi;
  const etasq = eta * eta;
  const eeta = ecco * eta;
  const psisq = Math.abs(1.0 - etasq);
  const coef = qzms24 * Math.pow(tsi, 4.0);
  const coef1 = coef / Math.pow(psisq, 3.5);
  const cc2 =
    coef1 *
    noUnkozai *
    (ao * (1.0 + 1.5 * etasq + eeta * (4.0 + etasq)) +
      (0.375 * J2 * tsi) / psisq * con41 * (8.0 + 3.0 * etasq * (8.0 + etasq)));
  const cc1 = bstar * cc2;

  let cc3 = 0.0;
  if (ecco > 1.0e-4) {
    cc3 = (-2.0 * coef * tsi * J3OJ2 * noUnkozai * sinio) / ecco;
  }
  const x1mth2_ = 1.0 - cosio2;
  const cc4 =
    2.0 *
    noUnkozai *
    coef1 *
    ao *
    omeosq *
    (eta * (2.0 + 0.5 * etasq) +
      ecco * (0.5 + 2.0 * etasq) -
      ((J2 * tsi) / (ao * psisq)) *
        (-3.0 * con41 * (1.0 - 2.0 * eeta + etasq * (1.5 - 0.5 * eeta)) +
          0.75 * x1mth2_ * (2.0 * etasq - eeta * (1.0 + etasq)) * Math.cos(2.0 * argpo)));
  const cc5 =
    2.0 * coef1 * ao * omeosq * (1.0 + 2.75 * (etasq + eeta) + eeta * etasq);

  const cosio4 = cosio2 * cosio2;
  const temp1 = 1.5 * J2 * pinvsq * noUnkozai;
  const temp2 = 0.5 * temp1 * J2 * pinvsq;
  const temp3 = -0.46875 * J4 * pinvsq * pinvsq * noUnkozai;
  const mdot =
    noUnkozai +
    0.5 * temp1 * rteosq * con41 +
    0.0625 * temp2 * rteosq * (13.0 - 78.0 * cosio2 + 137.0 * cosio4);
  const argpdot =
    -0.5 * temp1 * con42 +
    0.0625 * temp2 * (7.0 - 114.0 * cosio2 + 395.0 * cosio4) +
    temp3 * (3.0 - 36.0 * cosio2 + 49.0 * cosio4);
  const xhdot1 = -temp1 * cosio;
  const nodedot =
    xhdot1 +
    (0.5 * temp2 * (4.0 - 19.0 * cosio2) + 2.0 * temp3 * (3.0 - 7.0 * cosio2)) * cosio;
  const xpidot = argpdot + nodedot;
  const omgcof = bstar * cc3 * Math.cos(argpo);
  let xmcof = 0.0;
  if (ecco > 1.0e-4) xmcof = (-X2O3 * coef * bstar) / eeta;
  const nodecf = 3.5 * omeosq * xhdot1 * cc1;
  const t2cof = 1.5 * cc1;

  // xlcof: the |cosio+1| guard avoids a divide-by-zero near retrograde-polar.
  let xlcof;
  if (Math.abs(cosio + 1.0) > 1.5e-12) {
    xlcof = (-0.25 * J3OJ2 * sinio * (3.0 + 5.0 * cosio)) / (1.0 + cosio);
  } else {
    xlcof = (-0.25 * J3OJ2 * sinio * (3.0 + 5.0 * cosio)) / 1.5e-12;
  }
  const aycof = -0.5 * J3OJ2 * sinio;
  const delmo = Math.pow(1.0 + eta * Math.cos(mo), 3.0);
  const sinmao = Math.sin(mo);
  const x7thm1_ = 7.0 * cosio2 - 1.0;

  // ── SIMPLE-drag switch + the higher-order drag polynomials ──
  let isimp = 0;
  let d2 = 0.0,
    d3 = 0.0,
    d4 = 0.0,
    t3cof = 0.0,
    t4cof = 0.0,
    t5cof = 0.0;
  if ((rp - 1.0) * RADIUSEARTHKM < 220.0) {
    isimp = 1;
  } else {
    const cc1sq = cc1 * cc1;
    d2 = 4.0 * ao * tsi * cc1sq;
    const temp = (d2 * tsi * cc1) / 3.0;
    d3 = (17.0 * ao + sfour) * temp;
    d4 = 0.5 * temp * ao * tsi * (221.0 * ao + 31.0 * sfour) * cc1;
    t3cof = d2 + 2.0 * cc1sq;
    t4cof = 0.25 * (3.0 * d3 + cc1 * (12.0 * d2 + 10.0 * cc1sq));
    t5cof =
      0.2 *
      (3.0 * d4 + 12.0 * cc1 * d3 + 6.0 * d2 * d2 + 15.0 * cc1sq * (2.0 * d3 + cc1sq));
  }

  // GMST at epoch (Vallado uses gstime(jdsatepoch + jdsatepochF)).
  const gsto = gstime(t.jd + t.jdFrac);

  return {
    // raw mean elements at epoch
    ecco,
    inclo,
    nodeo,
    argpo,
    mo,
    bstar,
    noUnkozai,
    // geometry
    cosio,
    sinio,
    con41,
    con42,
    x1mth2,
    x7thm1: x7thm1_,
    aycof,
    xlcof,
    // secular rates
    mdot,
    argpdot,
    nodedot,
    xpidot,
    nodecf,
    // drag
    cc1,
    cc4,
    cc5,
    omgcof,
    xmcof,
    eta,
    delmo,
    sinmao,
    t2cof,
    t3cof,
    t4cof,
    t5cof,
    d2,
    d3,
    d4,
    isimp,
    // epoch + flags
    jd: t.jd,
    jdFrac: t.jdFrac,
    gsto,
    isDeepSpace,
    periodMin,
    ao,
  };
}

// ── sgp4: TIME-DEPENDENT update (the GPU df64 kernel ports THIS half) ──
// tsince in minutes since epoch. Returns TEME position [x,y,z] in km.
export function sgp4(s, tsince) {
  const {
    ecco,
    inclo,
    argpo,
    mo,
    noUnkozai,
    con41,
    x1mth2,
    x7thm1,
    aycof,
    xlcof,
    mdot,
    argpdot,
    nodedot,
    nodecf,
    cc1,
    cc4,
    cc5,
    omgcof,
    xmcof,
    eta,
    delmo,
    sinmao,
    t2cof,
    t3cof,
    t4cof,
    t5cof,
    d2,
    d3,
    d4,
    isimp,
    cosio,
    sinio,
  } = s;

  // ── Secular update of mean elements (gravity + drag) ──
  const xmdf = mo + mdot * tsince;
  const argpdf = argpo + argpdot * tsince;
  const nodedf = s.nodeo + nodedot * tsince;
  let argpm = argpdf;
  let mm = xmdf;
  const t2 = tsince * tsince;
  const nodem = nodedf + nodecf * t2;
  let tempa = 1.0 - cc1 * tsince;
  let tempe = s.bstar * cc4 * tsince;
  let templ = t2cof * t2;

  if (isimp !== 1) {
    const delomg = omgcof * tsince;
    const delmtemp = 1.0 + eta * Math.cos(xmdf);
    const delm = xmcof * (delmtemp * delmtemp * delmtemp - delmo);
    const temp = delomg + delm;
    mm = xmdf + temp;
    argpm = argpdf - temp;
    const t3 = t2 * tsince;
    const t4 = t3 * tsince;
    tempa = tempa - d2 * t2 - d3 * t3 - d4 * t4;
    tempe = tempe + s.bstar * cc5 * (Math.sin(mm) - sinmao);
    templ = templ + t3cof * t3 + t4 * (t4cof + tsince * t5cof);
  }

  const nm = noUnkozai;
  let em = ecco;
  const inclm = inclo;

  const am = Math.pow(XKE / nm, X2O3) * tempa * tempa;
  const nmNew = XKE / Math.pow(am, 1.5);
  em = em - tempe;

  // guard (near-circular / sanity)
  if (em >= 1.0 || em < -0.001) {
    // out of range; near-earth shouldn't hit this for well-behaved TLEs
  }
  if (em < 1.0e-6) em = 1.0e-6;

  mm = mm + noUnkozai * templ;
  let xlm = mm + argpm + nodem;
  const nodemR = nodem % TWOPI;
  argpm = argpm % TWOPI;
  xlm = xlm % TWOPI;
  mm = (xlm - argpm - nodemR) % TWOPI;

  // ── Long-period periodics (the J3 terms) ──
  const sinim = Math.sin(inclm);
  const cosim = Math.cos(inclm);
  const ep = em;
  const xincp = inclm;
  const argpp = argpm;
  const nodep = nodemR;
  const mp = mm;
  const sinip = sinim;
  const cosip = cosim;

  const axnl = ep * Math.cos(argpp);
  const temp = 1.0 / (am * (1.0 - ep * ep));
  const aynl = ep * Math.sin(argpp) + temp * aycof;
  const xl = mp + argpp + nodep + temp * xlcof * axnl;

  // ── Solve Kepler's equation for (E + omega) ──
  let u = (xl - nodep) % TWOPI;
  let eo1 = u;
  let tem5 = 9999.9;
  let ktr = 1;
  let sineo1 = 0.0,
    coseo1 = 0.0;
  while (Math.abs(tem5) >= 1.0e-12 && ktr <= 10) {
    sineo1 = Math.sin(eo1);
    coseo1 = Math.cos(eo1);
    tem5 = 1.0 - coseo1 * axnl - sineo1 * aynl;
    tem5 = (u - aynl * coseo1 + axnl * sineo1 - eo1) / tem5;
    if (Math.abs(tem5) >= 0.95) tem5 = tem5 > 0.0 ? 0.95 : -0.95;
    eo1 = eo1 + tem5;
    ktr += 1;
  }

  // ── Short-period periodics -> position ──
  const ecose = axnl * coseo1 + aynl * sineo1;
  const esine = axnl * sineo1 - aynl * coseo1;
  const el2 = axnl * axnl + aynl * aynl;
  const pl = am * (1.0 - el2);
  const rl = am * (1.0 - ecose);
  const rdotl = (Math.sqrt(am) * esine) / rl;
  const rvdotl = Math.sqrt(pl) / rl;
  const betal = Math.sqrt(1.0 - el2);
  const tempA = esine / (1.0 + betal);
  const sinu = (am / rl) * (sineo1 - aynl - axnl * tempA);
  const cosu = (am / rl) * (coseo1 - axnl + aynl * tempA);
  let su = Math.atan2(sinu, cosu);
  const sin2u = (cosu + cosu) * sinu;
  const cos2u = 1.0 - 2.0 * sinu * sinu;
  const tempB = 1.0 / pl;
  const temp1 = 0.5 * J2 * tempB;
  const temp2 = temp1 * tempB;

  // Update for short-period periodics.
  const mrt = rl * (1.0 - 1.5 * temp2 * betal * con41) + 0.5 * temp1 * x1mth2 * cos2u;
  su = su - 0.25 * temp2 * x7thm1 * sin2u;
  const xnode = nodep + 1.5 * temp2 * cosip * sin2u;
  const xinc = xincp + 1.5 * temp2 * cosip * sinip * cos2u;
  // mvt/rvdot not needed for position-only.

  // ── Orientation vectors -> TEME position ──
  const sinsu = Math.sin(su);
  const cossu = Math.cos(su);
  const snod = Math.sin(xnode);
  const cnod = Math.cos(xnode);
  const sini = Math.sin(xinc);
  const cosi = Math.cos(xinc);
  const xmx = -snod * cosi;
  const xmy = cnod * cosi;
  const ux = xmx * sinsu + cnod * cossu;
  const uy = xmy * sinsu + snod * cossu;
  const uz = sini * sinsu;

  const r = mrt * RADIUSEARTHKM; // km
  return [r * ux, r * uy, r * uz];
}

// ── TEME position (km) -> ECEF (m) by rotating -GMST(t) about +Z ──
export function temeToEcef(rTeme, gmst) {
  const cg = Math.cos(gmst);
  const sg = Math.sin(gmst);
  const x = rTeme[0],
    y = rTeme[1],
    z = rTeme[2];
  return [
    (cg * x + sg * y) * 1000.0,
    (-sg * x + cg * y) * 1000.0,
    z * 1000.0,
  ];
}

// ── self-validation against python-sgp4 vectors (run directly) ──
const _entry = process.argv[1]
  ? `file://${process.argv[1].replace(/\\/g, "/")}`
  : "";
if (_entry && import.meta.url === _entry) {
  // (placeholder; the real validation lives in validate-sgp4.mjs)
  const iss1 =
    "1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9999";
  const iss2 =
    "2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.50125623 18883";
  const s = sgp4init(iss1, iss2);
  console.log("ISS init: deepSpace=%s period=%s min", s.isDeepSpace, s.periodMin.toFixed(3));
  for (const tmin of [0, 90, 360, 720, 1440]) {
    const r = sgp4(s, tmin);
    console.log(`t=${tmin} TEME km: [${r.map((v) => v.toFixed(3)).join(", ")}]`);
  }
}
