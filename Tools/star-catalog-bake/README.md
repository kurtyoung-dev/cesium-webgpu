# Star-catalogue depth bake (Yale BSC5 via NASA HEASARC) — Campaign 12, C12-09

Reproducible offline pipeline that fills
`packages/engine/Source/Scene/BrightStarCatalog.js` from the HEASARC
`heasarc_bsc5p` Browse table, taking the embedded sky from the **263**
hand-curated stars the fork shipped through C12-08 to **2,868** stars at visual
magnitude **5.5**.

> **Licence:** the table is **not** covered by the repo's MIT grant. It is
> bundled under its own terms in the repo-root `LICENSE.md` → _Bundled Engine
> Assets_ → _Bright-star catalogue_. Read §2 below before changing the source.

---

## 1. Why this exists

Decision record **DR-01** (queue §6c) makes the star cubemap carry _diffuse
light only_ — the C12-10 bake low-passes the t5 map until it holds no resolved
point sources. Every star you can actually pick out of the sky therefore comes
from this catalogue, on **both** backends. That promotes catalogue depth from a
nice-to-have to load-bearing: at 263 stars the sky was demonstrably emptier than
what an ISS-reference frame shows.

This is a **data ingest**, not a constant being raised. The full 9,110-entry
BSC5 is not vendored and never was.

---

## 2. Licence verification (the gate this work had to pass)

Verified **2026-08-01** against primary sources before anything was downloaded.

|                           |                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Serving policy            | <https://heasarc.gsfc.nasa.gov/docs/heasarc/data_policy.html> — verbatim: _"HEASARC materials are all available freely for your use."_ The only obligation is an acknowledgement in research publications.                                                                                                                                        |
| Partner-agency carve-outs | The same page enumerates missions whose source agency imposes extra conditions. **The sole listed carve-out is XMM-Newton** (ESA, non-commercial). `bsc5p` is not partner-agency mission data and is not within it.                                                                                                                               |
| Catalogue page            | <https://heasarc.gsfc.nasa.gov/W3Browse/star-catalog/bsc5p.html> — carries **no** copyright notice, licence, or restriction. Its Provenance section states the table _"was created by the HEASARC in 1995 based upon a file obtained from either the ADC or the CDS"_, with HEASARC's own corrections applied since (most recently January 2014). |
| The file itself           | Its TDAT header declares `table_security = public`. No terms text of any kind.                                                                                                                                                                                                                                                                    |
| NASA policy               | <https://www.nasa.gov/nasa-brand-center/images-and-media/> — _"NASA content … generally are not subject to copyright in the United States"_; factual, non-endorsing use needs no explicit permission. The third-party carve-out applies to material NASA **marks** as copyright-protected; this table carries no marking.                         |
| Fact doctrine             | The four vendored columns are measurements of physical reality — uncopyrightable facts in the US under _Feist v. Rural_.                                                                                                                                                                                                                          |

**Verdict: redistribution of a four-column factual extract is permitted.**

**Stated honestly, this is not a clearance.** There is no affirmative licence
instrument (no CC0 tag, no written grant), and 17 U.S.C. §105 does **not** reach
the underlying 1991 compilation — Hoffleit was Yale, Warren was a contractor, and
federal hosting confers nothing. The permission rests on three independent
limbs: HEASARC's own broad grant over the HEASARC-created table we actually take,
NASA's general non-assertion, and the fact/expression line. The residual is
assessed low and **accepted on stated grounds** — never record it as "it is
clear". A one-line written confirmation from CDS (`cds-question@unistra.fr`)
and/or Yale would convert defensible into cleared.

### DR-02's three conditions — status

| Condition (queue §6d)                            | Status                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source from **NASA HEASARC**, not VizieR         | **SATISFIED.** The pinned file is served by HEASARC. This is what removes the EU _sui generis_ database right: the right protects substantial extraction independently of copyright, and its maker would be the European provider. `star-catalog-depth.spec.mjs` fails if the manifest's source URL stops being a HEASARC URL, or if it ever mentions VizieR/CDS. |
| Vendor **only** RA/Dec/Vmag/B−V                  | **SATISFIED.** `VENDORED_COLUMNS` in the bake is the whole permitted set and the spec asserts it. Identifiers, cross-references, spectral types, proper motions, parallaxes, notes and remarks are dropped. (The bake _reads_ two further columns during reconciliation — never emits them.)                                                                      |
| Re-sort under our own schema, not V/50 row order | **SATISFIED.** The source is ordered by declination; the emitted table is the curated core in its historical order followed by the appended rows sorted brightest-first. The spec asserts the ordering.                                                                                                                                                           |

### What C12-09 does **not** discharge

- **The underlying provenance question is unchanged** — DR-02 remains
  UNCONFIRMED, not retracted. This ingest satisfied its conditions; it did not
  answer it.
- **DR-01's own obligations stay with `C12-11`.** This work supplies the
  _density_ half of the seam. It does not verify that the blurred bake has no
  resolved point sources, and it does not capture the DR-01 reversal evidence
  (G3 on blurred vs un-blurred bakes). If the seam is ever reversed to option
  (b), reversal step 6 — _"cap sprite magnitude at the texture's threshold so
  the extended catalogue does not double-draw faint stars"_ — now has real work
  to do, and the cap is `MAG_CUTOFF`.
- **The frame-cost measurement DR-01 asks for** (a ~5,000-sprite delta on both
  backends) is an orchestrator probe lane, not something a pure-Node bake can
  produce. The ruling accepted the cost on prior evidence; the measurement
  should still be taken at the shipped count.

---

## 3. Source

|               |                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------- |
| Product       | Bright Star Catalogue, 5th Revised Ed. (Preliminary), Hoffleit & Warren 1991                  |
| Served as     | HEASARC Browse table `heasarc_bsc5p`, 9,110 rows                                              |
| **URL**       | `https://heasarc.gsfc.nasa.gov/FTP/heasarc/dbase/tdat_files/heasarc_bsc5p.tdat.gz`            |
| **SHA-256**   | `122628cde2d8bedf7e16ddf5f888167ac58c04b5592d6155408ce297f3073931`                            |
| Bytes         | 913,895 (gzip); 2,242,587 uncompressed                                                        |
| Format        | TDAT — pipe-delimited, with the column order declared in the header's `line[1]` specification |
| Last modified | 2022-02-04                                                                                    |
| Retrieved     | 2026-08-01                                                                                    |

Download (kept out of git, under `work/`):

```bash
mkdir -p Tools/star-catalog-bake/work
curl -L -o Tools/star-catalog-bake/work/heasarc_bsc5p.tdat.gz \
  https://heasarc.gsfc.nasa.gov/FTP/heasarc/dbase/tdat_files/heasarc_bsc5p.tdat.gz
sha256sum Tools/star-catalog-bake/work/heasarc_bsc5p.tdat.gz
# 122628cde2d8bedf7e16ddf5f888167ac58c04b5592d6155408ce297f3073931
```

The bake verifies that hash before doing anything and aborts on a mismatch — a
silent HEASARC re-issue must fail loudly rather than quietly change the shipped
sky. It also re-reads the column order from the file rather than hardcoding
positions, so a re-issue that _reorders_ columns cannot mis-index silently.

**Why the static TDAT file and not the TAP service.** HEASARC's TAP endpoint
returns base64 `BINARY` VOTable and gives no ordering guarantee without an
explicit `ORDER BY`, so a query response cannot be hash-pinned the way an asset
can. The Browse TDAT file is a stable, dated artefact — the same discipline as
`Tools/moon-albedo-bake`.

---

## 4. Stages

### 1. Verify

Pinned SHA-256 + byte count, then a `TOTAL ROWS` header cross-check against the
number of rows actually read.

### 2. Parse — four columns only

Column indices come from the header's `line[1]` specification. **14 rows carry
no V magnitude** (BSC5's novae and deleted entries — there is nothing for a
sprite to render) and are dropped; 9,096 remain. Every surviving cell is range-
checked: RA in [0, 360), Dec in [−90, 90].

### 3. Magnitude filter

`vmag <= --limit` (default **5.5**). Reference counts from the source:

| limit   | stars in band |
| ------- | ------------- |
| 5.0     | 1,630         |
| 5.4     | 2,579         |
| **5.5** | **2,887**     |
| 6.0     | 5,080         |

### 4. Correct the curated core

See §5. 24 pinned corrections, each validated against the source before it is
applied.

### 5. Reconcile + dedupe

Two independent mechanisms, because they catch different failures:

- **Suppression (0.05°).** Any source row within 0.05° of a curated row is
  dropped from the append set — _all_ of them, not just the nearest, so the
  components of a naked-eye double are never stacked on top of a curated entry
  that already carries the combined magnitude. 279 rows suppressed.
- **Same-star collapse (0.01°).** Two rows of _identical magnitude_ closer than
  ~1/3 of a pixel are one star recorded twice. BSC5 gives close binaries one HR
  number per component while writing the **system** magnitude on both rows:

  | star  | HR pair     | separation | V on both rows |
  | ----- | ----------- | ---------- | -------------- |
  | α Com | 4968 / 4969 | 0.2″       | 5.22           |
  | ε Ari | 887 / 888   | 1.5″       | 4.63           |
  | δ Ser | 5788 / 5789 | 3.9″       | 3.80           |

  Emitting both would draw one star twice and over-brighten it by 0.75 mag.
  3 rows collapsed at limit 5.5. Components with **distinct** magnitudes are
  deliberately kept — 16 such sub-0.01° pairs survive, which is what the naked
  eye actually sees.

### 6. Emit

Curated rows first, in their historical order with their name comments intact;
then the appended rows sorted **brightest-first** (ties broken by RA then Dec, so
the output is deterministic). Ordering is a readability and diff-stability
choice only — both starfield renderers draw with additive premultiplied blending
and depth writes disabled, so the composite is order-independent.

Precision: RA/Dec to 3 dp (≈3.6″, about 1/30 of a pixel), V and B−V to 2 dp —
matching the curated rows' existing style.

Missing B−V (**14** emitted rows) defaults to **0.00**, which is the _definition_
of the B−V zero point (A0 V / Vega): an uncoloured star renders as the
photometric system's reference white rather than being handed a fabricated
temperature. The count is recorded in the manifest.

Only the `const data = [...]` literal is rewritten; the module's docblock and
exports are left alone. The generated region sits between explicit markers and
re-running is **idempotent** (byte-identical second run).

---

## 5. The finding: 24 wrong rows in the hand-curated block

Reconciling the 263 curated rows against the source found **24 that place a
named star where no BSC5 star of that brightness exists.** They are transcription
errors, and the fingerprint is unmistakable: in 20 of the 24 the declination and
_both_ photometric values match a real BSC5 star exactly while the right
ascension is wrong; the remaining 4 are the same failure with a small
declination error or a mis-copied B−V alongside. Each was identified by
searching all 9,096 source stars for the row's (Dec, V, B−V) fingerprint, which
is **unique in every case**.

Displacements run from **0.07°** (ρ Per) to **29.5°** (ν Hya — an entire
constellation away). The affected stars:

ε Crv, θ Peg, α Del, κ Her, φ Sgr, μ Sgr, ρ Boo, δ Boo, θ Boo, φ Vel, β Pav,
ο¹ Eri, φ Eri, τ Pup, γ Hya, π Hya, ν Hya, ο Leo, ο Per, ρ Per, π⁴ Ori, λ Oph,
μ Ser, β Mus.

**Why this had to be fixed here rather than filed for later.** While the cubemap
painted every star, a misplaced sprite was a small extra dot on a sky that
already had the real star in it. Under DR-01 the cubemap no longer supplies the
star, so the wrong row _is_ the star — visibly in the wrong constellation. Worse,
deepening the catalogue makes the source supply the same star at its true
position, so leaving the rows alone would have drawn 24 named stars **twice**,
up to 29.5° apart. That is precisely the "no doubled bright stars" failure the
acceptance probe looks for, so correcting them is part of deduping, not scope
creep.

The corrections live in a pinned table in `bake-star-catalog.mjs`, keyed by the
erroneous position. Each is **validated against the source before it is applied**
— a star must exist at the target with the stated V and B−V, or the bake aborts.
Keying on the old position is also what makes re-running idempotent: once a row
is corrected it no longer matches, so nothing moves twice.

The curated rows' own photometry is otherwise left untouched (a few differ from
BSC5 in the second decimal, e.g. Canopus −0.74 vs −0.72). Snapping those is a
separate, larger change and is deliberately not folded in here.

---

## 6. Coupled constant — `MAG_CUTOFF`

`StarFieldMath.ts` zeroes the flux of any star fainter than `MAG_CUTOFF`. It is
**definitionally the faintest vendored magnitude**, so it moves with the bake:
left at 5.0, the 1,238 rows this ingest added between 5.0 and 5.5 would render at
exactly zero and the deepening would be inert.

`FAINT_ANCHOR_MAG` / `FAINT_ANCHOR_PEAK` deliberately do **not** move — they are
an exposure decision anchored to the M1 census detection floor, not to where the
catalogue ends. The derivation, and what re-anchoring would break, is in the
C12-09 block in `StarFieldMath.ts`.

Two specs pin the pair from both sides:
`Tools/visual-regression/starfield-psf.spec.mjs` (constant vs source file, and
constant vs faintest vendored star) and
`Tools/visual-regression/star-catalog-depth.spec.mjs`.

---

## 7. Run it

```bash
node Tools/star-catalog-bake/bake-star-catalog.mjs             # ship default (5.5)
node Tools/star-catalog-bake/bake-star-catalog.mjs --dry-run   # report, write nothing
node Tools/star-catalog-bake/bake-star-catalog.mjs --limit 6.0 # deeper band
node --test Tools/visual-regression/star-catalog-depth.spec.mjs
node --test Tools/visual-regression/starfield-psf.spec.mjs
```

`star-catalog-manifest.json` is regenerated alongside the table and is bound to
the emitted **numbers** by SHA-256 — a doc edit does not invalidate it, a data
edit does.

---

## 8. Deeper, if wanted

`--limit 6.0` is a one-flag change and needs no code edit beyond `MAG_CUTOFF`
(which the bake prints and both specs enforce):

All figures are LF-normalised (what git stores) and measured with
`esbuild --bundle --minify --format=esm` on the module alone. The 263-star
baseline is 19,704 B source / 6,419 B minified / 2,958 B gzip.

|                             | limit 5.5 (shipped) | limit 6.0  |
| --------------------------- | ------------------- | ---------- |
| stars                       | 2,868               | 5,058      |
| `BrightStarCatalog.js`      | 103,700 B           | 172,091 B  |
| minified                    | 69,276 B            | 121,783 B  |
| **minified delta**          | **+62,857 B**       | +115,364 B |
| gzip (of the minified form) | 28,657 B            | 49,365 B   |
| **gzip delta**              | **+25,699 B**       | +46,407 B  |
| brotli delta                | +22,312 B           | +40,479 B  |
| rows using the B−V default  | 14                  | 44         |

6.0 is the count the C12-09 queue row names ("~5,000 stars") and is the
conventional naked-eye limit; 5.5 is what this ingest shipped, on the explicit
instruction, and leaves the catalogue one magnitude short of the 6.5 reference
limit `StarFieldMath`'s own rural-sky claim cites. Both sit inside the accepted
~200 KB budget. Going deeper than 6.5 would need the exposure anchor re-derived:
past vmag 6.56 a star's peak pixel falls below 1/255 and the row renders into
nothing.
