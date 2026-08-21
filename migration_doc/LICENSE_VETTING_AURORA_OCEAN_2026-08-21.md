# License Vetting — Aurora, Ocean, Wind, and Space Weather

**Date:** 2026-08-21  
**Campaign scopes:** Campaign 14, Dynamic Ocean & Wind (`W0..W5`), and Campaign 15,
Aurora + Space Weather (`C15-00..08`, including the `C15-06P` and `C15-07H`
overlays).  
**Purpose:** pre-register every external reference on which the two ratified plans
may rely before externally derived code, shader structure, data, or assets enter the
fork.

## 1. Standing rule and licence baseline

The fork's shipped licence baseline is Apache-2.0: the root `LICENSE.md`,
`packages/engine/LICENSE.md`, and `package.json` (`"license": "Apache-2.0"`) agree.
Anything derived from an external source must be licence-compatible with that
distribution and attributed using the `L-24` Shota Matsuda / Takram convention. A
`Reference:` comment is scholarly credit; it does not replace a required third-party
notice, data-provenance entry, licence text, or dependency manifest entry.

The task statement's MIT-distribution claim remains an open framing item, routed to
maintainer ruling item 11 in `migration_doc/RULING_REQUESTS_2026-08-21.md`
(recommendation: confirm Apache-2.0); it is not a global intake blocker. On the
licence-compatibility axis, permissive inbound under MIT, BSD, ISC, Unlicense,
public-domain, and CC-BY terms is compatible with Apache-2.0 distribution when the
applicable licence and attribution obligations, including NOTICE-file attribution
under Apache-2.0 §4(d), are propagated. Copyleft and noncommercial terms remain
disqualified. Every per-row evidence hold, including missing licence text, unpinned
revisions, and unquoted terms, is independent of this baseline and stands unchanged.

This document is a pre-registration record, not legal advice and not a numbered
`L-xx` shipped-obligation determination. A numbered determination and the required
shipped notices are still due in the same landing that first incurs an obligation.

## 2. Method, evidence markers, and verdicts

The inventory deduplicates by external source identity, not by number of mentions.
Repeated links to one endpoint are one reference; a product page, its data feed, and
an upstream model are separate when their rights or intended uses differ. A vague
mention is retained as `UNRESOLVED-CITATION` rather than being guessed.

Evidence follows the C18-S0/L-24 hierarchy:

| Marker | Meaning in this pass |
| --- | --- |
| `VERBATIM-IN-REPO` | In-repo evidence reproduces operative licence or use text and identifies the source. |
| `DETERMINED-IN-REPO` | A prior numbered determination records a verbatim network read and closure. |
| `DECLARED-ONLY` | A plan or catalogue reports a licence, but the actual licence text is not present in the evidence read for this pass. File-level reuse is blocked. |
| `UNRESOLVED-CITATION` | The source is not identified precisely enough to vet. Derivation from it is blocked. |

The intended-use classification is load-bearing:

- `DERIVED-TECHNIQUE` means equations, facts, or an algorithmic idea are
  independently reimplemented. Copyright does not protect the method itself, but
  paper prose, figures, pseudocode, variable-name sets, and code listings remain
  protected expression and must not be copied or transliterated.
- `DERIVED-CODE` means source or shader expression is translated, adapted, or used
  as a structural port. The source licence governs; permissive code still requires
  its notice and attribution.
- `DATA/API` means live remote consumption, a frozen test fixture, and a bundled
  snapshot are three distinct uses. Permission to query a public endpoint does not
  by itself permit redistribution of a snapshot.
- `ASSET` means bytes or transformed bytes enter a distributable artifact. Exact
  provenance, transformation, attribution, and product-level terms are mandatory.

Required verdicts are used as follows:

| Verdict | Meaning |
| --- | --- |
| `CLEAR-TO-DERIVE` | No identified copyright restriction blocks the stated use; any normal provenance action remains stated in the row. |
| `ATTRIBUTION-REQUIRED` | The stated use is compatible only with the listed scholarly, licence, notice, or data-provenance credit. |
| `HOLD-LEGAL` | Licence text, source identity, provenance, component lineage, or the distribution baseline is not sufficiently established for the stated intake. |
| `DO-NOT-USE` | The planned use is incompatible, expressly excluded, obsolete, or restricted to a use the fork must not ship. |

Risk classes are limited to `public-domain`, `permissive`, `copyleft`,
`proprietary`, and `unknown`. For papers with no licence evidence, `unknown` applies
to the publication expression while the independently implemented method remains
uncopyrightable.

## 3. Attribution form

The L-24 convention requires the project, author, licence, URL, specific mechanism
adopted, the fork's independent expression, and an explicit no-copy statement. The
established form is:

```text
// Reference: <author>, <organisation> — <project or publication> (<licence>),
// <canonical URL> — <specific mechanism adopted>. <How this implementation
// differs or was independently derived>. Technique only — no source was copied.
```

For a paper, the publication title/venue/DOI replaces the project/licence fields and
the final sentence remains. For copied or adapted code, data, or an asset, the block
must state that fact instead of claiming no copy, and the corresponding notice and
full licence/provenance record must ship. The L-24 precedent states the distinction
directly: a reference block credits an author; it does not grant or reproduce a
licence.

## 4. Campaign 15 aurora and space-weather inventory

The source-document count is **27 distinct references**: 17 linked sources, six
named-but-unlinked sources, and four `UNRESOLVED-CITATION` records. Repeated uses
of an endpoint in §2/§2a are folded into its single row.

| ID | Source and queue location | Intended use | In-repo licence evidence and risk | Attribution owed | Online verification still owed before landing | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| A-01 | NCEI World Magnetic Model, §2 line 108 | `DERIVED-TECHNIQUE`: independently implement the centered-dipole frame; no code translation | `DECLARED-ONLY`; no terms quoted. Risk `unknown` | Yes, scientific-technique block | Current WMM2025 documentation/terms and the exact parameter source used | `ATTRIBUTION-REQUIRED` |
| A-02 | NCEI Wandering of the Geomagnetic Poles, §2 line 108 | Factual pole coordinates and inclination | `DECLARED-ONLY`; facts are not copyrightable, page expression is. Risk `unknown` | Yes, factual-source block | Page identity, authorship, and current reuse terms | `ATTRIBUTION-REQUIRED` |
| A-03 | NOAA SWPC Aurora, §2 line 109 | Factual shell bounds; no code or asset reuse | NWS public-domain rule quoted at A-16. Risk `public-domain` | Yes, source/provenance block | Confirm the product page has no contrary product-specific notice | `ATTRIBUTION-REQUIRED` |
| A-04 | NASA Auroras, §2 line 109 | Factual wavelength/altitude guidance; no code | No NASA terms quoted. Risk `unknown` | Yes, scientific-source block | Page authorship, exact statements, and reuse terms | `ATTRIBUTION-REQUIRED` |
| A-05 | NASA Red and Green Aurora Australis article, §2 lines 109 and 286–288 | Factual wavelength/altitude profiles | Not re-fetched in the recorded pass; no terms quoted. Risk `unknown` | Yes, scientific-source block | Canonical page, author/date, exact spectral claims, and reuse terms | `ATTRIBUTION-REQUIRED` |
| A-06 | SWPC Aurora 30-Minute Forecast product page, §2 lines 110 and 116 | Product documentation and provenance for live OVATION ingestion | NWS public-domain rule applies generally, but the queue denies any blanket claim over the JHU/APL model. Risk `public-domain` for NWS page, `unknown` for model | Yes, product/provenance block | Current page notice and exact separation of SWPC output from JHU/APL model rights | `ATTRIBUTION-REQUIRED` |
| A-07 | Latest OVATION JSON, §2 lines 110/115 and §2a | `DATA/API`: live ingestion and possible frozen fixtures/snapshots | General NWS public-domain quotation is not product-level snapshot clearance. Risk `unknown` for redistribution | Yes; `LICENSE.md` data-provenance entry if any bytes ship | Product-level output terms, attribution owner, snapshot/redistribution right, exact transformation statement | `HOLD-LEGAL` |
| A-08 | NOAA observed planetary K-index JSON, §2 line 111 and §2a | `DATA/API`: runtime ingest and frozen tests | General NWS rule only; product-specific fixture terms not quoted. Risk `unknown` for redistribution | Yes if fixture/data ships | Product terms, fixture redistribution, attribution, and source timestamp policy | `HOLD-LEGAL` |
| A-09 | NWS Service Change Notice 26-21, §2 lines 111–113 and §2a | `DERIVED-TECHNIQUE`: schema/lifecycle facts, not copied prose/figures/code | NWS public-domain quotation at A-16. Risk `public-domain` | Yes, document citation | Canonical notice revision/date and absence of a contrary notice | `ATTRIBUTION-REQUIRED` |
| A-10 | RTSW magnetometer JSON, §2 line 112 and §2a | `DATA/API`: live ingest and frozen fixtures | General NWS rule only. Risk `unknown` for redistributed bytes | Yes if fixtures ship | Product-level terms, source-satellite provenance, fixture redistribution, transformations | `HOLD-LEGAL` |
| A-11 | RTSW wind JSON, §2 lines 112/113/115 and §2a | `DATA/API`: live ingest and frozen fixtures | General NWS rule only. Risk `unknown` for redistributed bytes | Yes if fixtures ship | Same checks as A-10, including active-source attribution | `HOLD-LEGAL` |
| A-12 | RTSW ephemerides 1-hour JSON, §2 line 112 and §2a | Informational endpoint; current `C15-06` does not specify ingest | General NWS rule only; product use not fixed. Risk `unknown` | No while unused; yes if adopted | Confirm whether it is adopted, then product terms and fixture rights | `HOLD-LEGAL` |
| A-13 | SWPC GOES X-ray Flux page, §2 line 114 | Product/science facts and flare-state definitions | NWS public-domain quotation at A-16. Risk `public-domain` | Yes, product citation | Current page terms and a source that states the flux unit/threshold semantics | `ATTRIBUTION-REQUIRED` |
| A-14 | GOES primary 1-day X-ray JSON, §2 line 114 and §2a | `DATA/API`: runtime ingest and frozen fixtures | General NWS rule only. Risk `unknown` for redistributed bytes | Yes if fixtures ship | Product-level terms, fixture right, instrument attribution, transformations | `HOLD-LEGAL` |
| A-15 | GOES instrument-sources JSON, §2 line 114 and §2a | `DATA/API`: runtime metadata and possible fixture | General NWS rule only. Risk `unknown` for redistributed bytes | Yes if fixtures ship | Product-level terms and fixture/provenance requirements | `HOLD-LEGAL` |
| A-16 | NWS disclaimer, §2 line 116 | Terms evidence only | `VERBATIM-IN-REPO`: NWS web information public domain subject to three conditions. Risk `public-domain` | No engine-code block; quote/cite in provenance records | Re-read the current disclaimer and record retrieval date before relying on it | `CLEAR-TO-DERIVE` |
| A-17 | WDC Kyoto Data Usage Rules, §2 line 117 | Terms evidence for excluding Kyoto indices | `VERBATIM-IN-REPO`: commercial applications prohibited; DOI reference required. Risk `proprietary` | No, because no source bytes or provider may ship | Recheck only if a future maintainer proposes reopening the exclusion | `DO-NOT-USE` |
| A-18 | JHU/APL OVATION Prime model, §2 lines 110/116 | Consume SWPC output only; no model-code translation authorized | Queue says public-domain SWPC output is not a model licence. No precise paper/code licence. Risk `unknown` | Yes, model/product scholarly credit | Canonical paper/model version, authors, URL, licence, and output-rights relationship | `HOLD-LEGAL` |
| A-19 | Forecast Kp product `noaa-planetary-k-index-forecast.json`, §2 line 111 | Schema comparison and possible future ingest | Named but URL and terms are not pinned. Risk `unknown` | Yes if adopted | Canonical endpoint, owner, current schema, product terms, fixture rights | `HOLD-LEGAL` |
| A-20 | Removed `/products/solar-wind/*.json` family, §2/§2a and C15-00 | Explicitly obsolete endpoint family | Six paths are not individually identified and all measured 404. Risk `unknown` | No | None for current work; identify only for historical documentation | `DO-NOT-USE` |
| A-21 | SWPC `products/kyoto-dst.json` mirror, §2 line 117 | Explicitly excluded provider/snapshot | Mirror does not erase Kyoto's noncommercial source restriction. Risk `proprietary` | No, because unused | Recheck only under a maintainer-approved legal reopening | `DO-NOT-USE` |
| A-22 | `olawlor/AuroraRendererUnity`, §2b line 315 | Technique study for oval, curtains, and emission profile; possible code/shader adaptation | Queue reports `Unlicense (public domain) △`; actual file not read. Risk `unknown` until verified | Yes; technique block, plus shipped notice if any expression is adapted | Canonical repository/commit, verbatim licence, copyright/public-domain dedication, paper/code lineage | `HOLD-LEGAL` |
| A-23 | Full IGRF model, C15-02 line 442 | Explicit v1 non-goal; no derivation intended | No edition/source/licence identified. Risk `unknown` | No while excluded | None unless v1 scope changes; then identify the exact IGRF release and terms first | `DO-NOT-USE` |
| A-24 | Unidentified GPU aurora volume-rendering paper, §2b line 315 | `DERIVED-TECHNIQUE` only after identification; no code/pseudocode copying | `UNRESOLVED-CITATION`. Risk `unknown` for publication expression | Yes, once identifiable | Title, authors, venue, DOI/URL, version, and whether any listing/code is separately licensed | `HOLD-LEGAL` |
| A-25 | Fairbanks 2025 aurora observation/photograph/replay material, C15-07H lines 571–576 | `ASSET`/`DATA`: immutable historical offline replay; photograph context only | `UNRESOLVED-CITATION`: no source, photographer/data owner, archive, or terms. Risk `unknown` | Yes; asset/data owner, source, timestamp, transforms, licence | Canonical byte source, owner, exact licence, download record, hash, transformation and archival permission | `HOLD-LEGAL` |
| A-26 | Unidentified “second licensed aurora reference,” §2b lines 317–320 | Unknown; no derivation may be based on it | `UNRESOLVED-CITATION`; only one aurora reference is actually listed. Risk `unknown` | Cannot be formed | Identify the alleged second source or correct the plural claim | `HOLD-LEGAL` |
| A-27 | “Eclipse Explorer follow-up” solar-prominence state provider, C15-06P line 384 | `DATA/API`: located solar-prominence state for eclipse composition | `UNRESOLVED-CITATION`: the exact data owner and source identity are open, and “Eclipse Explorer” is not identified as a NASA product or an internal item. Risk `unknown` | Yes, provider/owner and data-provenance credit | Identify whether “Eclipse Explorer” refers to NASA's product or an internal item; then establish owner, endpoint, terms, and attribution form | `HOLD-LEGAL` |

### A-01 — NCEI World Magnetic Model

**What was found and classification.** The queue cites `[NCEI World Magnetic
Model]` and says, verbatim, `Valid 2025–2030.` The campaign intends an
independent centered-dipole transform, not WMM software translation or coefficient
file inclusion. That is `DERIVED-TECHNIQUE`; facts and mathematical methods may be
reimplemented, while any WMM code, tables, prose, or pseudocode remain protected
expression.

**Attribution and determination.** Use `Reference: NOAA NCEI — World Magnetic
Model 2025, <https://www.ncei.noaa.gov/products/world-magnetic-model> — epoch and
centered-dipole parameter authority. Reimplemented from published parameters; no
source code copied.` Current terms and the exact technical source must be checked
online before landing. Verdict: **ATTRIBUTION-REQUIRED**.

### A-02 — NCEI Wandering of the Geomagnetic Poles

**What was found and classification.** The queue quotes `"80.85°N geodetic
latitude"`, `"80.79°N geocentric"`, `"72.76°W"`, and `"The axis of the dipole is
currently inclined at 9.21° to Earth's rotation axis."` These are factual inputs;
no page text, figure, or code is intended to ship.

**Attribution and determination.** Use `Reference: NOAA NCEI — Wandering of the
Geomagnetic Poles, <https://www.ncei.noaa.gov/products/wandering-geomagnetic-poles>
— epoch-2025 centered-dipole pole and inclination facts. Reimplemented from stated
facts; no source code copied.` Re-read the page, author/date, and terms online.
Verdict: **ATTRIBUTION-REQUIRED**.

### A-03 — NOAA SWPC Aurora

**What was found and classification.** The queue quotes the source verbatim:
`"The aurora typically forms 80 to 500 km above Earth's surface."` The use is a
factual bound for an independently designed analytic shell, not code or imagery.
The in-repo NWS disclaimer supports public-domain treatment subject to its three
conditions.

**Attribution and determination.** Use `Reference: NOAA Space Weather Prediction
Center — Aurora, <https://www.spaceweather.gov/phenomena/aurora> — typical altitude
envelope used to bound the analytic shell. Technique only; no source was copied.`
Confirm no product-specific contrary notice. Verdict: **ATTRIBUTION-REQUIRED**.

### A-04 — NASA Auroras

**What was found and classification.** The queue's own citation text is `NASA
places green oxygen near 100–200/250 km and red oxygen above 200 km.` The campaign
uses scientific facts to design independent line profiles; no NASA code, figure, or
asset is authorized. No NASA licence text is quoted in-repo.

**Attribution and determination.** Use `Reference: NASA Science — Auroras,
<https://science.nasa.gov/sun/auroras/> — oxygen-emission altitude guidance.
Reimplemented as an independent analytic profile; no source code or media copied.`
Verify exact statements, author/date, and reuse terms online. Verdict:
**ATTRIBUTION-REQUIRED**.

### A-05 — NASA Red and Green Aurora Australis article

**What was found and classification.** The queue calls this the `NASA red/green
altitude reference` and later states, verbatim, `Ground-truth for the per-line
altitude profiles (427.8 / 557.7 / 630.0 nm) still rests on the NASA references
cited in §2, which were not re-fetched in this pass`. Scientific facts may be
reimplemented; article expression or media may not be copied without terms.

**Attribution and determination.** Use `Reference: NASA — Red and Green Aurora
Australis, <https://www.nasa.gov/image-article/red-green-aurora-australis/> —
wavelength-specific altitude guidance. Reimplemented from scientific facts; no
article text, image, or code copied.` Online verification of the page, author,
claims, and media terms remains mandatory. Verdict: **ATTRIBUTION-REQUIRED**.

### A-06 — SWPC Aurora 30-Minute Forecast product page

**What was found and classification.** The queue uses this page for OVATION product
behavior and quotes that an `"estimate of aurora viewing probability can be
derived"`; it also attributes the empirical model to JHU/APL. Product documentation
facts may guide an adapter, but they do not license the model or a redistributed
snapshot.

**Attribution and determination.** Use `Reference: NOAA SWPC — Aurora 30-Minute
Forecast, <https://www.spaceweather.gov/products/aurora-30-minute-forecast> —
operational OVATION product behavior and provenance. Adapter implemented from
documented facts; no source code copied.` Verify the current notice and the
SWPC-output/JHU-model boundary online. Verdict: **ATTRIBUTION-REQUIRED**.

### A-07 — Latest OVATION JSON

**What was found and classification.** The queue measures a 65,160-triple live
payload and explicitly says: `No downloaded snapshot enters the bundle until its
exact source, transformation, attribution, and terms are recorded in LICENSE.md.`
Live parsing is `DATA/API`; freezing those bytes into a fixture or historical replay
is an additional redistribution/asset act.

**Attribution and determination.** Any shipped bytes require a provenance block in
the form `Reference/Data source: NOAA SWPC — OVATION Aurora Latest JSON,
<https://services.swpc.noaa.gov/json/ovation_aurora_latest.json>; observation and
retrieval times; byte hash; transformations; product owner; licence.` The general
NWS disclaimer is not enough under the queue's own rule. Product-level terms and
the JHU/APL relationship must be verified online. Verdict: **HOLD-LEGAL** for
fixture/snapshot intake; a network adapter may be written independently without
copying payload bytes into the distribution.

### A-08 — Observed planetary K-index JSON

**What was found and classification.** The plan quotes the measured schema as
`{time_tag, Kp, a_running, station_count}` and intends runtime ingestion plus frozen
fixtures. Schema facts are not copyrightable; a fixture is copied data.

**Attribution and determination.** A shipped fixture needs `Reference/Data source:
NOAA SWPC — Planetary K-index JSON,
<https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json>; retrieval
time; covered rows; hash; transformations; product terms.` Product-specific
redistribution and attribution terms remain unquoted and must be checked online.
Verdict: **HOLD-LEGAL** for data inclusion.

### A-09 — NWS Service Change Notice 26-21

**What was found and classification.** The queue states the notice was read in full
and quotes the March 31 format restructure and April 30 RTSW removal. The intended
use is independent adapter logic based on lifecycle/schema facts, not reproduction
of the PDF, figures, or extended prose.

**Attribution and determination.** Use `Reference: NOAA/NWS, Service Change Notice
26-21 — Data Format Changes Impacting SWPC Products,
<https://www.weather.gov/media/notification/pdf_2026/scn26-21_Data_Format_Changes_Impacting_SWPC_Products.pdf>
— endpoint retirement and field-mapping facts. Adapter implemented independently;
no source code copied.` Confirm current revision and notice online. Verdict:
**ATTRIBUTION-REQUIRED**.

### A-10 — RTSW magnetometer JSON

**What was found and classification.** The queue records the replacement endpoint,
descending order, per-satellite rows, GSM/GSE fields, and `-9999` fill behavior.
Those observed schema facts may be independently encoded. Any frozen response is
copied data.

**Attribution and determination.** A fixture requires `Reference/Data source: NOAA
SWPC — RTSW magnetometer 1-minute JSON,
<https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json>; active source;
retrieval window; hash; redaction/transformation; licence.` Verify product-level
terms and source-satellite attribution online. Verdict: **HOLD-LEGAL** for fixture
or snapshot inclusion.

### A-11 — RTSW wind JSON

**What was found and classification.** The plan records `proton_density`,
`proton_speed`, and `proton_temperature`, descending order, active-source filtering,
and measured gaps. Independent schema adaptation is distinct from copying response
bytes into tests.

**Attribution and determination.** A fixture requires `Reference/Data source: NOAA
SWPC — RTSW solar-wind 1-minute JSON,
<https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json>; active source;
retrieval window; hash; transformations; licence.` Verify product-level terms and
provenance online. Verdict: **HOLD-LEGAL** for included data.

### A-12 — RTSW ephemerides 1-hour JSON

**What was found and classification.** The queue corrected the endpoint from the
nonexistent `_1m` name to `_1h`, but the implementation brief says, verbatim,
`Consume only the replacement rtsw_mag_1m.json and rtsw_wind_1m.json feeds.` No
ephemerides ingestion or fixture is currently authorized.

**Attribution and determination.** No block is owed while unused. If adopted, use
the same data-source form as A-10/A-11 with the canonical `_1h` URL and verify
product terms, ownership, and fixture rights online first. Verdict:
**HOLD-LEGAL** pending a defined use and terms.

### A-13 — SWPC GOES X-ray Flux product page

**What was found and classification.** The page guides a separate flare-state
adapter. The queue is explicit that `The flux unit for GOES X-rays (conventionally
W/m²) is not stated in the payload and the product page did not state it plainly
either` and forbids hard-coded flare thresholds until that gap closes.

**Attribution and determination.** Use `Reference: NOAA SWPC — GOES X-ray Flux,
<https://www.spaceweather.gov/products/goes-x-ray-flux> — product semantics for the
separate flare-state channel. Adapter implemented independently; no source code
copied.` Find an authoritative unit/threshold source and recheck page terms online.
Verdict: **ATTRIBUTION-REQUIRED**; the missing unit is a scientific intake blocker,
not permission to guess.

### A-14 — GOES primary 1-day X-ray JSON

**What was found and classification.** The queue measured the schema, interleaved
passbands, ascending order, and misspelled `electron_contaminaton` field. Those are
schema facts; a committed response fixture is copied data.

**Attribution and determination.** A fixture requires `Reference/Data source: NOAA
SWPC — GOES primary X-rays 1-day JSON,
<https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json>; instrument;
retrieval window; hash; transformations; licence.` Product-level redistribution
terms and instrument attribution must be checked online. Verdict: **HOLD-LEGAL**
for included bytes.

### A-15 — GOES instrument-source mapping

**What was found and classification.** The plan measured an array mapping primary
and secondary instruments and uses it to avoid hard-coding a satellite. Runtime
parsing from an observed schema is independent work; a frozen mapping is copied
data.

**Attribution and determination.** A fixture requires `Reference/Data source: NOAA
SWPC — GOES instrument-sources JSON,
<https://services.swpc.noaa.gov/json/goes/instrument-sources.json>; retrieval time;
hash; transformations; licence.` Confirm product terms and fixture rights online.
Verdict: **HOLD-LEGAL** for data inclusion.

### A-16 — NWS disclaimer

**What was found and classification.** The queue quotes the operative statement:
`"The information on National Weather Service (NWS) Web pages are in the public
domain, unless specifically noted otherwise, and may be used without charge for
any lawful purpose so long as you do not: 1) claim it is your own …, 2) use it in a
manner that implies an endorsement or affiliation with NOAA/NWS, or 3) modify its
content and then present it as official government material."` This is terms
evidence, not a technique or asset.

**Attribution and determination.** No engine `Reference:` block is owed for the
disclaimer itself. Every data provenance entry must nevertheless name NOAA/NWS,
state transformations, avoid endorsement, and never present modified content as
official. Re-read the live disclaimer and bank the retrieval date before first
reliance. Verdict: **CLEAR-TO-DERIVE** under the quoted conditions.

### A-17 — WDC Kyoto Data Usage Rules

**What was found and classification.** The queue quotes both `"The WDC Kyoto does
not allow commercial applications of the geomagnetic indices"` and the requirement
to include data DOIs in the Reference section. The noncommercial restriction is
incompatible with the task-directed MIT distribution.

**Attribution and determination.** No attribution block can cure the prohibited
commercial use. No built-in Kyoto provider, Dst snapshot, or Kyoto-derived fixture
may ship. A caller-owned numeric override remains outside this intake. Verdict:
**DO-NOT-USE**.

### A-18 — JHU/APL OVATION Prime model

**What was found and classification.** The queue says `The model is JHU/APL's
OVATION Prime` and calls it an empirical model `"developed at the Johns Hopkins
University, Applied Physics Laboratory by Patrick Newell and co-workers"`. It then
states the decisive boundary: `the public-domain status of the SWPC output is not a
licence claim over the model.` The campaign needs SWPC output, not model code.

**Attribution and determination.** If model context is retained, use `Reference:
Patrick Newell and co-workers, JHU/APL — <canonical OVATION Prime paper/model
version, DOI/URL> — scientific provenance of the model named by the SWPC product;
the fork consumes separately cleared SWPC output and does not derive from model
code.` Identify and verify the exact paper, version, licence, and output-rights
relationship online.
Verdict: **HOLD-LEGAL** for any model derivation; live-output handling remains
separately governed by A-06/A-07.

### A-19 — Forecast planetary Kp product

**What was found and classification.** The only citation is the unlinked filename
`noaa-planetary-k-index-forecast.json`, with the statement that it spells the field
`kp` and adds `observed`/`noaa_scale`. The source URL, product owner statement, and
terms are not pinned.

**Attribution and determination.** No complete block can be written yet. If
adopted, use `Reference/Data source: <verified NOAA/SWPC owner> — Planetary K-index
Forecast JSON, <canonical URL>; retrieval time; hash; transformations; licence.`
Verify all placeholders online before ingestion fixtures or bundled bytes land.
Verdict: **HOLD-LEGAL**.

### A-20 — Removed solar-wind endpoint family

**What was found and classification.** The queue says `every
/products/solar-wind/*.json path returns HTTP 404`, records `6 probed`, and directs
`ban the deprecated pre-2026 solar-wind endpoints`. The six names are not
individually recoverable from the queue, but no current implementation may call
them.

**Attribution and determination.** No attribution is owed because nothing may be
used. Historical documentation may retain the wildcard and SCN citation without
inventing six paths. Verdict: **DO-NOT-USE**.

### A-21 — SWPC Kyoto-Dst mirror

**What was found and classification.** The queue says `SWPC does mirror the index
at products/kyoto-dst.json` and immediately warns that the mirror `does not erase
the source restrictions`. The copied/reformatted data remains tied to Kyoto's
noncommercial restriction.

**Attribution and determination.** No notice can make the intended MIT distribution
compatible. Keep the provider and snapshot absent. Verdict: **DO-NOT-USE**.

### A-22 — `olawlor/AuroraRendererUnity`

**What was found and classification.** The queue describes this as `the GPU aurora
volume-rendering paper implemented by its own authors` and reports `Unlicense
(public domain) △`. It guides `C15-02` synthetic oval geometry and `C15-03` layered
emission, but the actual licence file was not read in the recorded pass. A clean-room
paper reimplementation and a shader/code adaptation have different obligations.

**Attribution and determination.** Once verified, the technique form is
`Reference: Lawlor & Genetti, UAF — AuroraRendererUnity (<verified licence>),
<canonical repository URL> — synthetic oval, curtain-footprint, and vertical
emission-profile guidance. Reimplemented independently; no source code copied.` If
code or shader expression is adapted, say so and ship the exact notice instead of
the no-copy sentence. Verify repository, commit, full dedication/licence, authors,
and paper/code lineage online. Verdict: **HOLD-LEGAL**.

### A-23 — Full IGRF model

**What was found and classification.** `C15-02` says, verbatim, `There is no
full-IGRF requirement for v1.` No edition, owner, source, data file, or terms are
identified, and v1 does not need them.

**Attribution and determination.** No block is owed while the model is excluded.
If scope changes, identify the exact IGRF generation, coefficients/data source,
software (if any), and terms before work starts. Verdict: **DO-NOT-USE** in v1;
this is a scope exclusion as well as an unresolved intake.

### A-24 — Unidentified GPU aurora volume-rendering paper

**What was found and classification.** The queue supplies only `the GPU aurora
volume-rendering paper implemented by its own authors`. It gives no title, venue,
DOI, URL, or publication terms. Algorithm ideas may be independently implemented,
but the paper's prose, diagrams, pseudocode, code listings, and distinctive
expression may not be copied merely because the method is uncopyrightable.

**Attribution and determination.** The eventual form is `Reference: <authors> —
<paper title, venue/year, DOI/URL> — <specific aurora-volume mechanism>.
Independently implemented; technique only — no source was copied.` It cannot be
completed until the source is identified. Verify any supplemental code under its
own licence. Verdict: **HOLD-LEGAL** and `UNRESOLVED-CITATION`.

### A-25 — Fairbanks 2025 aurora observation and replay material

**What was found and classification.** `C15-07H` calls for `the 2025-03-14
Fairbanks-area total lunar eclipse plus the independently photographed auroral
activity`. No photographer, data owner, archive, canonical bytes, URL, or terms are
named. An observation is a fact; a photograph, dataset, archive selection, and
frozen replay are protected/controlled materials with separate rights.

**Attribution and determination.** Intake needs `Reference/Data or image source:
<owner/photographer> — <title/archive>, <URL>; observation time/location; exact
licence; retrieved-byte hash; transformations; role as context only.` Verify
redistribution, derivative, archival, and attribution rights online before a single
byte is committed. Verdict: **HOLD-LEGAL** and `UNRESOLVED-CITATION`.

### A-26 — Unidentified second licensed aurora reference

**What was found and classification.** The queue says `both licensed aurora
references are dormant and no modern WebGPU aurora implementation exists anywhere`,
but its aurora table names only `AuroraRendererUnity`. The reference catalog repeats
the unexplained plural. No second source can be inferred safely.

**Attribution and determination.** No Reference block or licence verdict can be
formed. Identify the source or correct the plural statement; `satvis` and
`satellite.js` must not be silently substituted because neither document says they
are the missing aurora renderer. Verdict: **HOLD-LEGAL** and
`UNRESOLVED-CITATION`.

### A-27 — C15-06P solar-prominence state provider

**What was found and classification.** Queue evidence (verbatim): `Attributed,
located solar-prominence state provider for eclipse composition; never infer
image-plane location from GOES flux` and `exact data owner for the Eclipse Explorer
follow-up`. The queue does not establish whether “Eclipse Explorer” is a NASA product
or an internal item, and it gives no owner, endpoint, or terms. The intended use is
`DATA/API`; the source is an `UNRESOLVED-CITATION` with risk `unknown`.

**Attribution and determination.** Identify whether “Eclipse Explorer” refers to
NASA's product or an internal item; then establish the owner, endpoint, terms, and
required attribution form before intake. Verdict: **HOLD-LEGAL**.

## 5. Campaign 14 ocean and wind inventory

The source-document count is **59 distinct references**. GFS and RTOFS are
separate data products; aliases such as `cambecc/earth` and `earth (nullschool)`
are one source; a paper/model and an implementation of it are separate when the
campaign proposes different derivation routes. The source plan's NWS disclaimer,
SCN 25-81, and `wgrib2js` are counted separately from the products or service whose
status they support. External standards, algorithms, retired service paths, and
licence-policy sources are also separate identities; format words that merely
describe a named implementation (`GRIB2/NetCDF` within `fluid-earth`, `MLS-MPM/SPH`
within WebGPU-Ocean, and RGBA8/equirectangular encoding within the named flow-field
implementations) are not multiplied into sources without a distinct citation.

| ID | Source and plan location | Intended use | In-repo licence evidence and risk | Attribution owed | Online verification still owed before landing | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| O-01 | NOAA/NCEP GFS wind, lines 31/82/85/135 | Live `DATA/API` and transformed PNG/JSON `ASSET`; the shipped `gfs-wind-sample.png` + `.json` pair is `PRE-EXISTING` intake | The general NWS public-domain quotation is `VERBATIM-IN-REPO`, but product-specific snapshot terms are not quoted. Risk `public-domain` for live access, `unknown` for redistribution | Yes, data provenance | Product-specific terms, exact cycle/files, hash and transformations | `ATTRIBUTION-REQUIRED` for the live `DATA/API` leg; `HOLD-LEGAL` for new committed/bundled `ASSET` intake |
| O-02 | NOAA RTOFS currents, lines 83/85/135 | Live `DATA/API` and offline-decimated committed `ASSET` | The general NWS public-domain quotation is `VERBATIM-IN-REPO`, but product-specific snapshot terms are not quoted. Risk `public-domain` for live access, `unknown` for redistribution | Yes, data provenance | RTOFS product terms, source files/cycle, hash, decimation and navigation disclaimer if any | `ATTRIBUTION-REQUIRED` for the live `DATA/API` leg; `HOLD-LEGAL` for new committed/bundled `ASSET` intake |
| O-03 | NOAA NOMADS/grib-filter service, lines 31/82/85 | Offline retrieval/API tooling; no external code translation | General NWS public-domain evidence. Risk `public-domain` | Yes, service/data source in generated-asset provenance | Current endpoint, access/CORS terms, SCN 25-81 retirement state | `ATTRIBUTION-REQUIRED` |
| O-04 | NWS-MDL EDR CoverageJSON, line 86 | Runtime live wind service | Prototype endpoint, weak SLA, UGRD/VGRD availability and terms unconfirmed. Risk `unknown` | Yes if adopted | Canonical endpoint, supported parameters/levels, SLA, licence, caching/redistribution | `HOLD-LEGAL` |
| O-05 | ECMWF Open Data forecasts, line 136 | Stream or redistribute forecast data | `VERBATIM-IN-REPO`: CC-BY-4.0 and commercial redistribution with attribution. Risk `permissive` | Yes, CC-BY data credit | Current dataset terms, attribution wording, version, files/transforms | `ATTRIBUTION-REQUIRED` |
| O-06 | ERA5/CDS, line 137 | Registered historical data download/stream | Plan reports a 2025 transition to CC-BY-4.0 but quotes no primary licence text. Risk `permissive` as declared | Yes if adopted | Dataset-specific current licence, registration/export terms, attribution, redistribution | `HOLD-LEGAL` |
| O-07 | Copernicus Marine currents, lines 83/138 | User-supplied stream only; never bundled | Bespoke terms quoted; personal non-transferable login. Risk `proprietary` | Yes, prescribed Copernicus credit | Current terms/API, caching, derived-output and application-display permissions | `HOLD-LEGAL` |
| O-08 | OSCAR v2/PO.DAAC, lines 83/139 | User-supplied currents upgrade | No explicit dataset licence; Earthdata login; NRT source unconfirmed. Risk `unknown` | Yes if cleared | Exact FINAL/NRT product, DOI, licence, account, caching and redistribution terms | `HOLD-LEGAL` |
| O-09 | NASA MERRA-2, line 140 | Deprioritized user-supplied option | General open-sharing policy only; per-dataset wording unconfirmed. Risk `unknown` | Yes if adopted | Exact product licence, Earthdata terms, attribution and caching/redistribution | `HOLD-LEGAL` |
| O-10 | Phillips spectrum, lines 16/69/171 | `DERIVED-TECHNIQUE`: published-equation reimplementation; debug preset | Existing shader cites Tessendorf and says no code copied; publication terms otherwise unknown. Risk `unknown` for expression | Yes, paper/model citation | Canonical primary/model citation and confirmation no code/listing is used | `ATTRIBUTION-REQUIRED` |
| O-11 | JONSWAP spectrum, lines 19/69/171/198 | `DERIVED-TECHNIQUE` or code-guided implementation | Primary publication not identified. Risk `unknown` | Yes once identified | Canonical report/paper, authors/year/URL, equations used; no code/pseudocode copying | `HOLD-LEGAL` |
| O-12 | TMA spectrum/depth attenuation, lines 19/69/142/172/198 | `DERIVED-TECHNIQUE` or Godot code translation | Primary citation absent. Risk `unknown` | Yes once identified | Exact TMA/Kitaigorodskii source and separate Godot code/component licences | `HOLD-LEGAL` |
| O-13 | Horvath 2015 directional spreading, lines 69/142/198 | `DERIVED-TECHNIQUE` or code-guided implementation | Title/URL absent. Risk `unknown` | Yes once identified | Exact paper/version/DOI and any supplemental code licence | `HOLD-LEGAL` |
| O-14 | Hasselmann directional spreading, line 172 | Spectrum-model implementation through GodotOceanWaves | Primary publication absent. Risk `unknown` | Yes once identified | Exact model/publication and distinction from Horvath implementation | `HOLD-LEGAL` |
| O-15 | Jerry Tessendorf, *Simulating Ocean Water*, line 151 | `DERIVED-TECHNIQUE`: published math only | Plan says `published math, derive-don't-copy`; in-tree shader provides title and no-copy statement. Risk `unknown` for notes expression | Yes, paper citation | Canonical notes URL/version/year and confirmation no listing/code is translated | `ATTRIBUTION-REQUIRED` |
| O-16 | Bruneton et al. wind-dependent slope variance, line 65 | `DERIVED-TECHNIQUE` | `UNRESOLVED-CITATION`: plan says 2010; another repo doc says Bruneton & Neyret 2008. Risk `unknown` | Yes once reconciled | Correct title, authors, year, DOI/URL, exact mechanism | `HOLD-LEGAL` |
| O-17 | Monahan & O'Muircheartaigh 1980 whitecap relation, line 75 | Independently implement empirical coverage equation | Formula is quoted but bibliography is absent. Risk `unknown` for publication | Yes, paper citation | Exact title/venue/DOI and equation provenance/units | `HOLD-LEGAL` |
| O-18 | NWS Beaufort scale, line 76 | Derive thresholds and wind-aligned foam behavior from factual descriptions | NWS public-domain evidence. Risk `public-domain` | Yes, source citation | Canonical Beaufort page/version and exact quoted wording | `ATTRIBUTION-REQUIRED` |
| O-19 | Callaghan 2008 foam persistence, line 77 | Independently implement hysteresis/decay concept | `UNRESOLVED-CITATION`: title/work absent. Risk `unknown` | Yes once identified | Exact publication, authors, year, DOI/URL, mechanism used | `HOLD-LEGAL` |
| O-20 | Box-Muller Gaussian generation, line 67 | Standard algorithm for deterministic fixed noise; no source translation | Named mathematical algorithm; no source identified. Risk `unknown` for publication expression | Yes, canonical algorithm citation | Canonical publication and confirmation implementation is independent | `ATTRIBUTION-REQUIRED` |
| O-21 | Stockham FFT, line 173 | Independent FFT algorithm or `dli/waves` code translation | Algorithm route is distinct from declared-MIT code route. Risk `unknown` for publication, `permissive` as declared for code | Yes; paper block or MIT notice depending route | Canonical algorithm source; `dli/waves` exact licence/revision if code-guided | `ATTRIBUTION-REQUIRED` for clean-room math; O-37 holds code translation |
| O-22 | Unidentified 256² FFT performance envelope, line 113 | Performance-budget justification only | `UNRESOLVED-CITATION`; no source/artifact. Risk `unknown` | Yes if ever cited | Source, hardware/configuration, run artifact and comparability | `HOLD-LEGAL` |
| O-23 | Crest / Wave Harmonic, lines 65/67/72/141 | `DERIVED-CODE` or structural study of wind spectra/transitions/zones | `VERBATIM-IN-REPO`: MIT line and permission opening quoted. Risk `permissive` | Yes, MIT notice and L-24 mechanism block | Canonical repository/commit, complete licence, files/components used | `ATTRIBUTION-REQUIRED` |
| O-24 | “Atlas local injection,” line 72 | Local sea-state injection technique study | `UNRESOLVED-CITATION`: no owner/project/paper. Risk `unknown` | Cannot be formed | Identify the exact source or remove the claim | `HOLD-LEGAL` |
| O-25 | `2Retr0/GodotOceanWaves`, lines 72/142/172 | GLSL-to-WGSL/code translation for spectra, cascades and foam | `VERBATIM-IN-REPO`: MIT, Ethan Truong; OTFFT component lineage not rechecked here. Risk `permissive` with transitive `unknown` | Yes, MIT and component notices plus mechanism block | Canonical commit, complete licence, file boundaries, OTFFT licence/notice | `HOLD-LEGAL` for file-level translation |
| O-26 | SINTEF `gpuocean`, line 143 | Domain study only | GPL-3.0-or-later. Risk `copyleft` | No code notice because no code may enter | None unless a separate permissive paper source is chosen | `DO-NOT-USE` for code/pseudocode translation |
| O-27 | `cambecc/earth` / earth (nullschool), lines 144/182 | Velocity/projection/GRIB format study; possible code guidance | MIT reported from hosting API, not licence file; author surname conflicts (`Beccarino`/`Beccario`). Risk `permissive` as declared | Yes if used | Verbatim licence, canonical author spelling, repository/revision, files used | `HOLD-LEGAL` for code reuse |
| O-28 | `RaymanNg/3D-Wind-Field`, line 145 | Globe longitude/latitude particle integration | `DETERMINED-IN-REPO` L-12: MIT, copyright 2019 RaymanNg. Risk `permissive` | Yes, existing MIT notice and mechanism block | Only revision/file-specific check for new copying beyond vetted lineage | `ATTRIBUTION-REQUIRED` |
| O-29 | `hongfaqiu/cesium-wind-layer`, line 146 | Cesium wind-layer implementation reference | MIT/copyright reported, actual text not quoted. Risk `permissive` as declared | Yes if used | Canonical repo/revision, verbatim licence/copyright, transitive sources | `HOLD-LEGAL` |
| O-30 | `mapbox/webgl-wind`, lines 61/147/180 | Encoding, ping-pong advection and trail code/structure | `DETERMINED-IN-REPO` L-12: ISC, copyright 2016 Mapbox. Risk `permissive` | Yes, existing ISC notice and mechanism block | Revision/file check for any new copied/adapted expression | `ATTRIBUTION-REQUIRED` |
| O-31 | windy.com, lines 84/148 | Visual comparison only | Proprietary and plan-disqualified. Risk `proprietary` | No | None; do not fetch/copy code, media or assets | `DO-NOT-USE` |
| O-32 | *Horizon Forbidden West* SIGGRAPH 2022 Advances PDF, line 149 | Domain study only; plan says wrong model for open ocean | Published talk, no code. Risk `proprietary` for slides/expression | Yes if concept is cited | Canonical talk/PDF, authors, permitted quotation; no slides/listings copied | `ATTRIBUTION-REQUIRED` |
| O-33 | *Sea of Thieves* SIGGRAPH 2018 talk, line 150 | No current derivation; contradictory secondary accounts | Paywalled, specifics unconfirmed. Risk `proprietary` | Cannot be reliable yet | Canonical primary talk/paper, authors, access/quotation terms, exact claim | `HOLD-LEGAL` |
| O-34 | `gasgiant/FFT-Ocean`, lines 151/170 | FFT decomposition, packing, cascades and Jacobian foam | `DETERMINED-IN-REPO` L-13: MIT, copyright 2020 Ivan Pensionerov. Risk `permissive` | Yes, existing MIT notice and mechanism block | Revision-specific check for new code beyond determined lineage | `ATTRIBUTION-REQUIRED` |
| O-35 | `Popov72/OceanDemo`, lines 151/170 | Three-cascade compute FFT, packing, foam and buoyancy | `DETERMINED-IN-REPO` L-13: MIT notice resolved; port retains Pensionerov line. Risk `permissive` | Yes, dual Popov/Pensionerov lineage and MIT notice | Revision/file check; preserve upstream port attribution | `ATTRIBUTION-REQUIRED` |
| O-36 | `BarthPaleologue/WebTide`, lines 151/171 | WGSL FFT structure and spherical/triplanar wrap study | `DETERMINED-IN-REPO` L-13: MIT, copyright 2024 Barthélemy Paléologue. Risk `permissive` | Yes, existing MIT notice and mechanism block | Revision/file check for new copied/adapted expression | `ATTRIBUTION-REQUIRED` |
| O-37 | `dli/waves`, lines 125/151/173 | WebGL2 feasibility and possible Stockham code translation | MIT only `DECLARED-ONLY`. Risk `permissive` as declared | Yes if used | Verbatim licence/copyright, repository/revision, code lineage | `HOLD-LEGAL` for code translation |
| O-38 | EncinoWaves, line 151 | Ocean algorithm/code reference | Apache-2.0 reported; no licence text, copyright holder, NOTICE, or pinned revision is quoted in-repo. `RESEARCH_REGISTER_2026-07-06.md:133` records `EncinoWaves = Apache-2.0 (usable; prefer derive-from-paper to avoid NOTICE obligations).` Risk `permissive` as declared | Yes; propagate the Apache-2.0 NOTICE attribution | Verbatim licence text, copyright holder, NOTICE, pinned revision, and file provenance | `HOLD-LEGAL` |
| O-39 | `jbouny/fft-ocean`, line 174 | Projected-grid/clipmap-alternative study | MIT only `DECLARED-ONLY`. Risk `permissive` as declared | Yes if used | Verbatim licence/copyright, revision, lineage | `HOLD-LEGAL` |
| O-40 | three.js Water / Water2, line 175 | Flow-map dual normals and cross-fade for W2/inland water | MIT only `DECLARED-ONLY`; Bouny lineage noted. Risk `permissive` as declared | Yes if used | Exact addon files/revision, three.js licence, contributor/Bouny lineage | `HOLD-LEGAL` |
| O-41 | `evanw/webgl-water`, line 176 | Caustics/refraction study | MIT only in `index.html`; no licence file. Risk `unknown` | Yes only after grant established | Author-confirmed canonical grant, copyright, revision, files | `HOLD-LEGAL` |
| O-42 | `threejs-caustics`, line 177 | Arbitrary-mesh caustics technique/code study | BSD-3 only `DECLARED-ONLY`. Risk `permissive` as declared | Yes if used | Verbatim BSD-3 text/copyright, revision, source lineage | `HOLD-LEGAL` |
| O-43 | `matsuoka-601/WebGPU-Ocean`, line 178 | Future MLS-MPM/SPH interactive-water study; no current row | MIT only `DECLARED-ONLY`. Risk `permissive` as declared | Yes if later adopted | Verbatim licence/copyright, components/assets, exact future use | `HOLD-LEGAL` |
| O-44 | Omar Shehata Toon Water tutorial, line 179 | Shoreline depth-intersection foam concept | Plan says `UNKNOWN` and no code moves. Risk `unknown` | Cannot be complete | Canonical tutorial/code, author grant, asset/code licences | `HOLD-LEGAL` |
| O-45 | `byrd-polar/fluid-earth`, line 181 | W5/backend GRIB2/NetCDF-to-fp16 pipeline architecture/code | MIT only `DECLARED-ONLY`. Risk `permissive` as declared | Yes if used | Verbatim licence/copyright, repository/revision, backend dependencies/data terms | `HOLD-LEGAL` |
| O-46 | NWS disclaimer, line 135 | Terms evidence for NOAA/NWS products | `VERBATIM-IN-REPO`: NWS web information is public domain subject to three conditions. Risk `public-domain` | No engine-code block; retain provenance evidence | Re-read current disclaimer and pin retrieval date/product exceptions | `CLEAR-TO-DERIVE` |
| O-47 | NWS Service Change Notice 25-81, line 31 | Service-retirement fact governing NOMADS/OpenDAP design | Citation number only; covered generally by NWS rule but notice text/link absent. Risk `unknown` | Yes, document citation | Canonical notice, date/revision, exact retirement statement and page-specific terms | `ATTRIBUTION-REQUIRED` |
| O-48 | `wgrib2js`, line 208 | `DERIVED-CODE`/dependency for offline GFS decoding; known RTOFS grid gap | Additional in-repo register says MIT “verified” but quotes no licence text. `DECLARED-ONLY`; risk `permissive` as declared | Yes, MIT notice if adopted | Canonical package/repository/version, verbatim licence/copyright, dependency tree, files bundled | `HOLD-LEGAL` |
| O-49 | OpenDAP path, line 31 | Explicitly retired live-access route | Only `OpenDAP retired per SCN 25-81`; endpoint/specification not identified. Risk `unknown` | No while excluded | None unless a replacement or protocol implementation is proposed | `DO-NOT-USE` |
| O-50 | CoverageJSON, lines 34/86 | External response format for NWS-MDL EDR adapter | Format named, no specification/version/licence quoted. Risk `unknown` for specification expression | Yes, standards citation | Canonical specification/version/owner, licence/terms, schema facts used | `ATTRIBUTION-REQUIRED` |
| O-51 | METAR, line 34 | Existing weather-observation source/format carried by ingest pipeline | Source family only; provider/dataset/fixture rights not identified. Risk `unknown` | Yes for any data/fixture; standards credit for parser work | Exact provider/product or standard, data terms, fixture rights, specification/version | `HOLD-LEGAL` |
| O-52 | Inverse-distance weighting (IDW), line 34 | Existing interpolation algorithm for METAR fields | Algorithm named without a publication/source. `UNRESOLVED-CITATION`; risk `unknown` for expression | Yes once identified | Canonical mathematical source and confirmation no listing was translated | `HOLD-LEGAL` |
| O-53 | Web Coverage Service (WCS), line 34 | Existing standards-based weather-ingest path | Standard family named without version/specification/terms. Risk `unknown` for specification expression | Yes, standards citation | OGC standard/version/URL/licence and exact operations/schema used | `ATTRIBUTION-REQUIRED` |
| O-54 | FBM sea-state masking, line 72 | `DERIVED-TECHNIQUE` for spatial ocean randomness | `FBM` is a vague technique name with no source. `UNRESOLVED-CITATION`; risk `unknown` | Yes once a source is adopted | Identify exact source or document an entirely in-tree independent design | `HOLD-LEGAL` |
| O-55 | Curl-noise wind-field bake, line 81 | `DERIVED-TECHNIQUE`/reuse of an in-tree precedent | Only `curl noise` and an in-tree shader location; no external source identity. `UNRESOLVED-CITATION`; risk `unknown` | Yes only if an external source guides new work | Identify any external source, or establish solely in-tree lineage | `HOLD-LEGAL` for external derivation |
| O-56 | ECMWF forum licence-transition post, line 137 | Legal-change evidence for ERA5 | Only `forum.ecmwf.int/t/13464`; no post text/author/date quoted. Risk `unknown`; it cannot itself license ERA5 | Cite as evidence only if verified | Canonical post, author/date/text, and primary ERA5 licence source | `HOLD-LEGAL` |
| O-57 | PO.DAAC citation policy, line 139 | Citation/terms evidence for OSCAR | Mentioned but not linked or quoted. `UNRESOLVED-CITATION`; risk `unknown` | Yes if OSCAR is adopted | Canonical policy/version, prescribed citation and relationship to product licence | `HOLD-LEGAL` |
| O-58 | Unnamed NASA full/open-sharing policy, line 140 | General terms evidence for MERRA-2 | Partial quotation with no policy title, URL, date or scope. `UNRESOLVED-CITATION`; risk `unknown` | Cite only after identification | Exact policy and current MERRA-2 product-specific licence/terms | `HOLD-LEGAL` |
| O-59 | GitHub licence API, lines 144/145 | Secondary metadata evidence for `earth` and RaymanNg licences | API result is not the upstream grant and no response artifact is retained. Risk `unknown` as legal proof | No campaign-code attribution; upstream authors still owed | Verify actual repository licence files/revisions instead of relying on API labels | `DO-NOT-USE` as sole licence proof |

### O-01 — NOAA/NCEP GFS wind

**What was found and classification.** Plan evidence (verbatim): `NOAA GFS wind /
RTOFS currents (NWS)` and `The information on National Weather Service (NWS) Web
pages are in the public domain, unless specifically noted otherwise`. W4 proposes
offline retrieval, decoding, transformation, and a distributable sample. The live
query is a `DATA/API` use; committed transformed bytes are a separate `ASSET` use.
The current tree's `Apps/SampleData/wind/gfs-wind-sample.png` and
`Apps/SampleData/wind/gfs-wind-sample.json` are **PRE-EXISTING** intake, not a new
clearance. Risk: `public-domain` for live access on the quoted general evidence and
`unknown` for redistribution without product-specific terms.

**Attribution and determination.** The live `DATA/API` leg requires `Data source:
NOAA/NCEP — Global Forecast System, <canonical product/files URL>; cycle/files;
retrieval time; transformations; not an official NOAA product.` Verdict:
**ATTRIBUTION-REQUIRED** for that live leg. For a new committed or bundled asset,
add retrieved-byte hashes and encoding details and quote product-specific snapshot
and redistribution terms; the general NWS disclaimer is not enough under the same
rule applied at A-07. Verdict: **HOLD-LEGAL** for new `ASSET` intake. The shipped
sample pair remains a **PRE-EXISTING** intake, not clearance for new bytes.

### O-02 — NOAA RTOFS currents

**What was found and classification.** Plan evidence (verbatim): `Default =
offline-decimated committed RTOFS-derived sample (US-gov PD, committable)` and the
same quoted NWS public-domain rule as O-01. W4 would redistribute transformed
current-field bytes. Live access is a `DATA/API` use; committed transformed bytes
are a separate `ASSET` use, so the source product and transformation chain matter
even though the government information is reported public domain. Risk:
`public-domain` for live access and `unknown` for redistribution without
product-specific terms.

**Attribution and determination.** The live `DATA/API` leg requires `Data source:
NOAA/NCEP — Real-Time Ocean Forecast System, <canonical product/files URL>;
cycle/files; retrieval time; grid/depth selection; not an official NOAA product.`
Verdict: **ATTRIBUTION-REQUIRED** for that live leg. A new committed or bundled
asset also requires hashes, crop/decimation and encoding details, and quoted
product-specific snapshot, redistribution, and navigation/scientific terms. The
general NWS disclaimer is not enough under the same rule applied at A-07. Verdict:
**HOLD-LEGAL** for new `ASSET` intake.

### O-03 — NOAA NOMADS/grib-filter

**What was found and classification.** Plan evidence (verbatim): `Live browser
NOMADS fetch is impossible (no CORS, verified; OpenDAP retired per SCN 25-81)` and
`the only path to fresh GFS/RTOFS`. The campaign would call the service from an
offline tool; no NOMADS implementation is to be copied. This is `DATA/API`, with
the retrieved products separately governed by O-01/O-02. Risk: `public-domain` on
the general NWS evidence.

**Attribution and determination.** Generated-asset provenance must say `Data
source: NOAA/NCEP — NOMADS grib-filter, <canonical endpoint>; retrieved <time>;
request
parameters and response hash`, alongside the underlying product credit. Verify the
current endpoint, service/access terms, retirement notices, and allowed automated
use online. Verdict: **ATTRIBUTION-REQUIRED**.

### O-04 — NWS-MDL EDR CoverageJSON

**What was found and classification.** Plan evidence (verbatim): `prototype
endpoint, weak SLA` and `UNCONFIRMED whether it serves UGRD/VGRD and at which
levels`. W5 proposes live `DATA/API` consumption, not code translation. Neither a
canonical production endpoint nor product-level terms are quoted. Risk: `unknown`.

**Attribution and determination.** If cleared, use `Data source: NOAA/NWS MDL —
<named EDR collection>, <canonical URL>; parameters/levels, valid and retrieval
times, transformations, and licence.` Online intake must establish endpoint status,
supported fields/levels, SLA, CORS, caching, attribution, and snapshot or derived
output rights. Verdict: **HOLD-LEGAL**.

### O-05 — ECMWF Open Data

**What was found and classification.** Plan evidence (verbatim): `CC-BY-4.0; "the
data may be redistributed and used commercially, subject to appropriate
attribution"`. The proposed forecast stream or redistributed transform is
`DATA/API`/`ASSET`, not source-code reuse. The quoted declaration is permissive but
attribution-bearing. Risk: `permissive`.

**Attribution and determination.** Use `Data source: ECMWF — ECMWF Open Data,
<dataset/product URL>, licensed CC BY 4.0; cycle/files and hashes; variables/levels;
transformations; changes made.` Also carry the CC BY 4.0 link and prescribed credit
where displayed or bundled. Re-read the current product licence and attribution
wording online and pin the version/files. Verdict: **ATTRIBUTION-REQUIRED**.

### O-06 — ERA5 / Copernicus Climate Data Store

**What was found and classification.** Plan evidence (verbatim): `Bespoke
Copernicus licence replaced by CC-BY-4.0 effective 2025-07-02
(forum.ecmwf.int/t/13464)`. That is a secondary forum report rather than quoted
dataset licence text. Historical downloads or derived files are `DATA/API` and
possibly `ASSET`; registration does not itself grant redistribution. Risk:
`permissive` as declared, but unverified.

**Attribution and determination.** The eventual form is `Data source: Copernicus
Climate Change Service/ECMWF — ERA5 <exact product>, <DOI/URL>, <verified licence>;
request, files/hashes, variables, transforms, and changes.` Verify the exact
dataset's current primary terms, registration conditions, attribution wording,
derived-output rights, and redistribution online. Verdict: **HOLD-LEGAL**.

### O-07 — Copernicus Marine currents

**What was found and classification.** Plan evidence (verbatim): `"This Licence is
granted free of charge"; redistribution allowed with credit "Generated using E.U.
Copernicus Marine Service Information"; personal non-transferable logins
mandatory`. The plan restricts this to a user-supplied `DATA/API` stream and says
`never bundled`; it does not authorize credentials, snapshots, or transformed
assets in the fork. Risk: `proprietary` because bespoke contractual terms apply.

**Attribution and determination.** If a caller-configured adapter is later
approved, use `Data source: E.U. Copernicus Marine Service — <exact product,
DOI/URL>; dates and transformations; "Generated using E.U. Copernicus Marine
Service Information"; <verified licence>.` Verify current API terms, account handling,
caching, derived-output, display, and commercial application permissions online.
No bundled bytes may land on current evidence. Verdict: **HOLD-LEGAL**.

### O-08 — OSCAR v2 / PO.DAAC

**What was found and classification.** Plan evidence (verbatim): `No explicit
licence statement on dataset page (points to PO.DAAC citation policy); Earthdata
Login REQUIRED; FINAL record ends 2022-08-05, NRT variant UNCONFIRMED`. The proposed
use is a caller-supplied `DATA/API` currents option, never a code derivation. Product
identity and rights are incomplete. Risk: `unknown`.

**Attribution and determination.** No final block is possible. A cleared form must
name `NASA PO.DAAC — <exact OSCAR FINAL or NRT product>, <DOI/URL>, <licence>; time
range, files/hashes, access path and transformations.` Verify which product exists,
its licence/citation policy, Earthdata terms, caching, derivative and redistribution
rights online. Verdict: **HOLD-LEGAL**.

### O-09 — NASA MERRA-2

**What was found and classification.** Plan evidence (verbatim): `NASA policy:
"full and open sharing of Earth science data... There will be no period of
exclusive access"; per-dataset wording UNCONFIRMED; Earthdata Login`. Open-access
policy is not the exact licence for a chosen product. Any use would be
`DATA/API`/`ASSET`; the plan deprioritizes it. Risk: `unknown`.

**Attribution and determination.** If reopened, use `Data source: NASA GMAO/PO.DAAC
or GES DISC — MERRA-2 <exact product>, <DOI/URL>, <verified terms>; files/hashes,
variables, times, and transformations.` Verify the selected dataset's terms,
Earthdata account rules, required citation, caching, and redistribution online.
Verdict: **HOLD-LEGAL**.

### O-10 — Phillips spectrum

**What was found and classification.** Plan evidence (verbatim): `The Phillips
spectrum consumes windX/windZ` and `Phillips demoted to debug preset`. The campaign
already has an implementation and would retain/rework the published equations, not
translate a newly identified codebase. A mathematical spectrum is not
copyrightable; any paper prose, derivation layout, pseudocode, or listing is. The
primary citation remains implicit through Tessendorf. Risk: `unknown` for source
expression.

**Attribution and determination.** Use `Reference: <verified primary author(s)> —
<Phillips-spectrum publication/title, venue/year, DOI/URL> — wind-aligned spectral
energy model. Equations independently implemented for this ocean pipeline;
technique only — no source was copied.` Pin the canonical source and audit that no
listing was transliterated online/at intake. Verdict: **ATTRIBUTION-REQUIRED**.

### O-11 — JONSWAP spectrum

**What was found and classification.** Plan evidence (verbatim): `JONSWAP + TMA +
Horvath-2015 spreading, γ=3.3`. This names a model, not a publication or licence.
An independent equation implementation could be `DERIVED-TECHNIQUE`; following
GodotOceanWaves source would instead be `DERIVED-CODE` and invoke O-25. The model
ideas are not copyrightable, but a report's prose, figures, pseudocode, or listings
are. Risk: `unknown`.

**Attribution and determination.** The required form is `Reference: <authors and
institution> — <canonical JONSWAP report/publication, year, DOI/URL> — peaked wave
spectrum and parameterization. Independently implemented; technique only — no
source was copied.` Identify and verify that primary source and any supplemental
code before implementation. Verdict: **HOLD-LEGAL**.

### O-12 — TMA finite-depth spectrum

**What was found and classification.** Plan evidence (verbatim): `JONSWAP + TMA +
Horvath-2015 spreading` and `TMA spectrum + Hasselmann directional spreading`.
Neither the TMA paper nor a precise Kitaigorodskii/depth-attenuation source is
identified. Independent math and a Godot GLSL translation have different legal
consequences; the latter also requires O-25 clearance. Risk: `unknown`.

**Attribution and determination.** Use only after completing `Reference: <verified
authors> — <canonical TMA publication, year, DOI/URL> — finite-depth spectral
attenuation. Independently implemented; technique only — no source was copied.`
Verify the exact paper/equations and separately verify every code file if code
guides the implementation. Verdict: **HOLD-LEGAL**.

### O-13 — Horvath 2015 directional spreading

**What was found and classification.** Plan evidence (verbatim):
`Horvath-2015 spreading`. No title, venue, DOI, URL, author given name, or
supplemental-code terms appear. The planned spreading function may be independently
implemented as `DERIVED-TECHNIQUE`; a port of code is separately `DERIVED-CODE`.
Risk: `unknown`.

**Attribution and determination.** No honest complete block exists yet. It must be
`Reference: <verified full author> — <2015 title, venue, DOI/URL> — <specific
directional-spreading mechanism>. Independently implemented; technique only — no
source was copied.` Identify the publication, exact equations, and any code lineage
online before W3 lands. Verdict: **HOLD-LEGAL** and `UNRESOLVED-CITATION`.

### O-14 — Hasselmann directional spreading

**What was found and classification.** Plan evidence (verbatim): `TMA spectrum +
Hasselmann directional spreading + foam accumulate/decay`. “Hasselmann” is not a
precise citation and the plan does not distinguish the original model from the
GodotOceanWaves implementation. Mathematical ideas may be reimplemented; the
paper's and repository's expressions may not be copied without their respective
permissions. Risk: `unknown`.

**Attribution and determination.** Require `Reference: <verified authors> —
<canonical Hasselmann spreading publication, year, DOI/URL> — <specific spreading
law>. Independently implemented; technique only — no source was copied.` Verify the
publication and keep any repository-derived work under O-25. Verdict:
**HOLD-LEGAL** and `UNRESOLVED-CITATION`.

### O-15 — Jerry Tessendorf, *Simulating Ocean Water*

**What was found and classification.** Plan evidence (verbatim): `Tessendorf notes
= published math, derive-don't-copy`. This authorizes only the clean-room
`DERIVED-TECHNIQUE` route: equations and algorithmic ideas may be independently
implemented, while explanatory prose, diagrams, pseudocode, listings, and
distinctive source expression remain copyrightable. Risk: `unknown` for the notes'
publication expression, with no need to copy it.

**Attribution and determination.** Use `Reference: Jerry Tessendorf — Simulating
Ocean Water, <course/venue, year, canonical URL> — spectral initialization,
time evolution and inverse-FFT ocean method. Independently implemented in the
fork; technique only — no source was copied.` Verify the canonical version/year/URL
and audit derivation lineage online/at intake. Verdict: **ATTRIBUTION-REQUIRED**.

### O-16 — Bruneton wind-dependent slope variance

**What was found and classification.** Plan evidence (verbatim): `Prior art:
Bruneton et al. 2010 wind-dependent slope variance`. Another in-repo reference
describes Bruneton & Neyret 2008, so author set, year, title, and mechanism are not
reconciled. The intended route is `DERIVED-TECHNIQUE`; an independently implemented
model is distinct from copying paper prose, pseudocode, figures, or code. Risk:
`unknown`.

**Attribution and determination.** No complete block can be formed until it reads
`Reference: <verified authors> — <verified title, venue/year, DOI/URL> —
wind-dependent slope-variance mechanism. Independently implemented; technique only
— no source was copied.` Reconcile the 2008/2010 conflict and verify the exact
mechanism online. Verdict: **HOLD-LEGAL** and `UNRESOLVED-CITATION`.

### O-17 — Monahan and O'Muircheartaigh 1980 whitecap relation

**What was found and classification.** Plan evidence (verbatim): `coverage W =
3.84×10⁻⁶·U10^3.41 (Monahan & O'Muircheartaigh 1980)`. The empirical equation and
underlying observations are facts/method; the publication's prose, tables, figures,
and any code/listing remain protected expression. No title, venue, DOI, or URL is
provided. Risk: `unknown`.

**Attribution and determination.** Require `Reference: Monahan and
O'Muircheartaigh — <verified 1980 publication, venue, DOI/URL> — U10 whitecap
coverage relation. Equation independently implemented with documented units and
domain; technique only — no source was copied.` Verify bibliography, coefficient,
units, validity range, and equation provenance online. Verdict: **HOLD-LEGAL** and
`UNRESOLVED-CITATION`.

### O-18 — NWS Beaufort scale

**What was found and classification.** Plan evidence is expressly verbatim:
`Force 3 "Crests begin to break. Foam of glassy appearance"; Force 5 "many white
horses"; Force 8 "foam is blown in well-marked streaks along the direction of the
wind"`. The campaign derives factual thresholds and behavior; it need not copy the
wording into engine code or an asset. The plan also quotes the NWS public-domain
rule. Risk: `public-domain`.

**Attribution and determination.** Use `Reference: NOAA/NWS — Beaufort Wind Scale,
<canonical URL> — factual wind-force thresholds used to parameterize foam onset
and alignment. Threshold behavior independently encoded; no source code copied.`
Re-read the canonical page and check for a page-specific notice online. Verdict:
**ATTRIBUTION-REQUIRED**.

### O-19 — Callaghan 2008 foam persistence

**What was found and classification.** Plan evidence (verbatim): `Wind-history
hysteresis (Callaghan 2008): decaying seas keep foam longer`. No title, coauthors,
venue, DOI, URL, measured relation, or code is identified. The proposed
accumulate/decay concept may be independently expressed, but the citation is too
vague to establish what claim is actually derived. Risk: `unknown`.

**Attribution and determination.** Require `Reference: <verified Callaghan author
list> — <verified 2008 publication, venue, DOI/URL> — observed foam persistence or
decay mechanism. Independently parameterized; technique only — no source was
copied.` Identify the work and verify the claimed relationship online. Verdict:
**HOLD-LEGAL** and `UNRESOLVED-CITATION`.

### O-20 — Box-Muller transform

**What was found and classification.** Plan evidence (verbatim): `deterministic
Box-Muller upload`. The transform is a standard mathematical algorithm. The
campaign intends a fresh deterministic Gaussian-noise implementation, not a port
of an unidentified code listing. Algorithmic ideas and equations are not protected,
while a specific explanation, pseudocode, test vectors, or listing can be. Risk:
`unknown` for any publication expression.

**Attribution and determination.** Use `Reference: G. E. P. Box and Mervin E.
Muller — <canonical transform publication, year, DOI/URL> — independent Gaussian
sample generation for fixed ocean noise. Independently implemented; technique only
— no source was copied.` Confirm the canonical bibliographic record and code
lineage online/at intake. Verdict: **ATTRIBUTION-REQUIRED**.

### O-21 — Stockham FFT

**What was found and classification.** Plan evidence (verbatim): `minimal
fragment-shader Stockham FFT chain`. “Stockham FFT” may mean an independently
implemented algorithm or translation of `dli/waves`; the two routes cannot share a
licence conclusion. The algorithm is not copyrightable, but publication/listing
expression is; repository code is separately governed by O-37. Risk: `unknown` for
the publication and `permissive` only as declared for the repository.

**Attribution and determination.** Clean-room use requires `Reference: <verified
Stockham publication authors/title/year/URL> — autosort FFT structure.
Independently implemented; technique only — no source was copied.` Code-guided use
must instead carry the verified `dli/waves` MIT notice and describe adaptation.
Verify the selected route and source online. Verdict: **ATTRIBUTION-REQUIRED** for
clean-room math; O-37 remains the code-translation gate.

### O-22 — Unidentified 256² FFT performance envelope

**What was found and classification.** Plan evidence (verbatim): `external
envelopes say 256² is well under 1 ms on this machine class (60 fps on a GTX 1050 Ti
full chain)`. No benchmark source, implementation, hardware configuration, driver,
revision, trace, or URL is named. This is not derivation input, but it is an external
performance claim that the plan would use to justify a budget. Risk: `unknown`.

**Attribution and determination.** No Reference block can be formed. Identify the
benchmark owner/artifact and record configuration, revision, method, licence or
quotation basis, URL, and comparability; otherwise delete the external claim and
rely only on the planned local baseline. Verdict: **HOLD-LEGAL** and
`UNRESOLVED-CITATION`.

### O-23 — Crest / Wave Harmonic

**What was found and classification.** Plan evidence (verbatim): `"MIT License /
Copyright (c) 2019 Wave Harmonic and contributors / Permission is hereby granted,
free of charge, to any person obtaining a copy"`. Crest guides empirical spectra,
smooth wind transitions, zones, and spatial modulation. Studying an idea is
`DERIVED-TECHNIQUE`; translating code, shader structure, constants, or tests is
`DERIVED-CODE` and invokes MIT notice retention. Risk: `permissive`.

**Attribution and determination.** For independent technique use: `Reference: Wave
Harmonic and contributors — Crest (MIT), <canonical repository URL> — <specific
wind transition/spectrum/zone mechanism>. Re-expressed for Cesium's ocean pipeline;
technique only — no source was copied.` Any adaptation must replace the no-copy
claim with file/revision details and ship the MIT notice. Verify repository,
revision, full licence, and components online. Verdict: **ATTRIBUTION-REQUIRED**.

### O-24 — “Atlas local injection”

**What was found and classification.** Plan evidence (verbatim): `Atlas local
injection`. No project title, author, paper, repository, talk, version, URL, or
licence identifies “Atlas.” It is therefore impossible to tell whether the plan
means an uncopyrightable technique, code, a commercial implementation, or merely an
analogy. Risk: `unknown`.

**Attribution and determination.** No Reference block can be formed and no source
may guide implementation. Identify the exact source and the intended mechanism, or
remove the claim and design local sea-state injection independently from first
principles. Verdict: **HOLD-LEGAL** and `UNRESOLVED-CITATION`.

### O-25 — `2Retr0/GodotOceanWaves`

**What was found and classification.** Plan evidence (verbatim): `"MIT License /
Copyright (c) 2024 Ethan Truong"` and `TMA spectrum + Hasselmann directional
spreading + foam accumulate/decay`. Direct GLSL-to-WGSL or structural translation
is `DERIVED-CODE`, not merely learning an algorithm. The plan also notes component
lineage that requires a separate OTFFT check. Risk: `permissive` for the quoted
top-level declaration and `unknown` for unresolved components/file lineage.

**Attribution and determination.** After verification use `Reference: Ethan Truong
— 2Retr0/GodotOceanWaves (MIT), <repository and commit> — <files and mechanisms
adapted>. Ported/adapted into WGSL; source expression was used; see shipped MIT and
component notices.` Verify the full licence, commit, file history, OTFFT licence,
and all notices online. Verdict: **HOLD-LEGAL** for file-level translation.

### O-26 — SINTEF `gpuocean`

**What was found and classification.** Plan evidence (verbatim): `GNU GPL
v3.0-or-later` and `DISQUALIFIED for code bundling (copyleft); techniques/domain
reference only`. Translating its code, shaders, pseudocode-like implementation, or
distinctive structure would be `DERIVED-CODE` under incompatible copyleft for the
task's MIT distribution baseline. Risk: `copyleft`.

**Attribution and determination.** No Reference block can cure incompatible code
reuse. Do not inspect it as an implementation template or translate it. A separately
published paper could be evaluated as a new source and independently reimplemented,
but no such precise paper is adopted here. No online verification is owed unless
that route is proposed. Verdict: **DO-NOT-USE** for code or pseudocode translation.

### O-27 — `cambecc/earth` / earth (nullschool)

**What was found and classification.** Plan evidence (verbatim): `MIT,
"Copyright (c) 2014 Cameron Beccarino" (GitHub licence API)`; the catalog later says
`Cameron Beccario`. The campaign may study velocity encoding, projection-aware
advection, and GRIB format, but any source translation is `DERIVED-CODE`. A hosting
API declaration and conflicting surname do not establish a complete notice. Risk:
`permissive` as declared.

**Attribution and determination.** Once resolved: `Reference: Cameron <verified
surname> — cambecc/earth (MIT), <repository and commit> — <specific encoding,
projection, or format mechanism>. <Independent re-expression or exact adaptation
statement>; see shipped MIT notice.` Verify the repository licence file, copyright
spelling, revision, files, and dependencies online. Verdict: **HOLD-LEGAL** for code
reuse.

### O-28 — `RaymanNg/3D-Wind-Field`

**What was found and classification.** Plan evidence (verbatim): `MIT (c) 2019
(GitHub licence API; already credited in FlowFieldAdvect.wgsl header)`. The later
L-12 determination upgraded this to a verified MIT notice, copyright 2019
RaymanNg. The intended use is globe longitude/latitude particle integration and is
`DERIVED-CODE` or code-guided structure. Risk: `permissive`.

**Attribution and determination.** Preserve `Reference: RaymanNg — 3D-Wind-Field
(MIT), <canonical repository and vetted revision> — longitude/latitude flow-field
integration. Adapted for the fork's WGSL/RTE pipeline; see shipped MIT notice.` The
existing notice remains mandatory. Only a new revision/file-specific online check
is owed if intake goes beyond L-12's vetted lineage. Verdict:
**ATTRIBUTION-REQUIRED**.

### O-29 — `hongfaqiu/cesium-wind-layer`

**What was found and classification.** Plan evidence (verbatim): `MIT (c) 2024
Hongfa Qiu`. The project is a Cesium implementation reference, so translating its
source, shader, state layout, or tests is `DERIVED-CODE`; a declared label is not a
substitute for the actual licence and copyright notice. Risk: `permissive` as
declared.

**Attribution and determination.** If cleared use `Reference: Hongfa Qiu —
hongfaqiu/cesium-wind-layer (MIT), <repository and commit> — <specific mechanism>.
<Independent re-expression or adaptation statement>; see shipped MIT notice.` Read
the canonical licence verbatim, pin the revision/files, and trace any upstream or
asset dependencies online before reuse. Verdict: **HOLD-LEGAL**.

### O-30 — `mapbox/webgl-wind`

**What was found and classification.** Plan evidence (verbatim):
`mapbox/webgl-wind | ISC (prior in-repo verification, RESEARCH_REGISTER:84)`.
L-12 independently closes the ISC notice, copyright 2016 Mapbox. Encoding,
ping-pong advection, and trail structure can be `DERIVED-CODE`; the ISC notice and
mechanism attribution remain due. Risk: `permissive`.

**Attribution and determination.** Preserve `Reference: Mapbox — webgl-wind (ISC),
<canonical repository and vetted revision> — RGBA velocity encoding, texture-state
advection and/or trail accumulation. Adapted for the fork's WGSL renderer; see
shipped ISC notice.` Only a revision/file check is owed for copying or adaptation
beyond L-12's established lineage. Verdict: **ATTRIBUTION-REQUIRED**.

### O-31 — windy.com

**What was found and classification.** Plan evidence (verbatim): `windy.com |
Proprietary | DISQUALIFIED — technique reference only`. The plan uses it only as a
visual comparator and does not identify a reusable paper, API, code repository, or
asset licence. Copying its code, imagery, tiles, design assets, screenshots, or
distinctive expression into the fork would be proprietary reuse. Risk:
`proprietary`.

**Attribution and determination.** No Reference block is owed because nothing from
the service may be derived or bundled. Do not fetch or copy implementation or media;
ordinary uncited observation of broad product behavior does not create a source
intake. No online verification is owed unless the maintainer proposes a separately
licensed artifact. Verdict: **DO-NOT-USE**.

### O-32 — *Horizon Forbidden West* SIGGRAPH 2022 talk

**What was found and classification.** Plan evidence (verbatim): `Published talk;
no code` and `wrong model for open-ocean wind response (baked shoreline
flipbooks)`. The intended use is domain study, not slide, figure, video, or code
reuse. General algorithmic ideas may be independently implemented, while the talk's
slides, images, prose, pseudocode, and listings remain proprietary expression.
Risk: `proprietary` for that expression.

**Attribution and determination.** If the contrast is retained, use `Reference:
<verified authors/studio> — Horizon Forbidden West ocean presentation, SIGGRAPH
2022 Advances in Real-Time Rendering, <canonical URL> — baked shoreline-flipbook
comparison only. No slide, asset, or source expression copied.` Verify authors,
title, canonical PDF/talk, and quotation/use terms online. Verdict:
**ATTRIBUTION-REQUIRED** for the limited study/citation route.

### O-33 — *Sea of Thieves* SIGGRAPH 2018 talk

**What was found and classification.** Plan evidence (verbatim): `Talk paywalled;
implementation details conflict across secondary sources` and `UNCONFIRMED — do
not cite specifics in the design`. No reliable primary mechanism, author list,
accessible artifact, licence, or permissible quotation basis is established. Risk:
`proprietary`.

**Attribution and determination.** No implementation may derive from the disputed
secondary descriptions. If reopened, identify the canonical talk title, authors,
venue URL, accessible primary content, and exact claim; then use a domain-study
Reference block that expressly says no slide, asset, or source expression was
copied. Until that online verification is complete, verdict: **HOLD-LEGAL** and
`UNRESOLVED-CITATION` as to the claimed specifics.

### O-34 — `gasgiant/FFT-Ocean`

**What was found and classification.** Plan evidence (verbatim): `Already verified
in-repo (no re-verification needed) | gasgiant/FFT-Ocean` and `all MIT`. L-13
records the full MIT lineage and copyright 2020 Ivan Pensionerov. FFT decomposition,
packing, cascades, and Jacobian foam may be `DERIVED-CODE`; that route requires the
MIT notice and accurate adaptation disclosure. Risk: `permissive`.

**Attribution and determination.** Preserve `Reference: Ivan Pensionerov —
gasgiant/FFT-Ocean (MIT), <canonical repository and vetted revision> — <specific
FFT/packing/cascade/foam mechanism>. Adapted for the fork's compute/WGSL pipeline;
see shipped MIT notice.` Only revision/file-specific verification is owed if a new
intake exceeds L-13's resolved lineage. Verdict: **ATTRIBUTION-REQUIRED**.

### O-35 — `Popov72/OceanDemo`

**What was found and classification.** Plan evidence (verbatim): `MIT △ — port of
gasgiant/FFT-Ocean; verify the upstream licence and carry dual attribution before
any file-level reuse`. L-13 resolves the MIT notice and the retained upstream
Pensionerov lineage. Three-cascade compute FFT, packing, foam, or buoyancy reuse is
`DERIVED-CODE`, with both port and upstream provenance material. Risk:
`permissive`.

**Attribution and determination.** Preserve `Reference: Evgeni Popov and Ivan
Pensionerov — Popov72/OceanDemo, port of gasgiant/FFT-Ocean (MIT), <repositories
and vetted revisions> — <specific ported mechanism>. Adapted for this fork; see
shipped MIT notices and upstream lineage.` A new revision/file intake must be
checked online and dual attribution retained. Verdict: **ATTRIBUTION-REQUIRED**.

### O-36 — `BarthPaleologue/WebTide`

**What was found and classification.** Plan evidence (verbatim): `MIT △` and `the
only spherical planet-ocean with triplanar wrap found anywhere`. L-13 resolves MIT,
copyright 2024 Barthélemy Paléologue. WGSL FFT structure, selectable spectra, or
spherical/triplanar wrap adaptation is `DERIVED-CODE`, not a paper-only method.
Risk: `permissive`.

**Attribution and determination.** Preserve `Reference: Barthélemy Paléologue —
WebTide (MIT), <canonical repository and vetted revision> — <specific WGSL FFT or
spherical-wrap mechanism>. Adapted for Cesium's globe/ocean pipeline; see shipped
MIT notice.` Only revision/file-specific verification is owed for new expression
outside L-13's vetted lineage. Verdict: **ATTRIBUTION-REQUIRED**.

### O-37 — `dli/waves`

**What was found and classification.** Plan evidence (verbatim): `MIT △` and
`minimal fragment-shader Stockham FFT chain`. The triangle legend says a declared
licence `MUST be upgraded to ✔ at intake before any file-level reuse`. A feasibility
observation is technique study; translating shader stages, indexing, constants, or
packing is `DERIVED-CODE`. Risk: `permissive` as declared, not verified.

**Attribution and determination.** If cleared, use `Reference: David Li — dli/waves
(MIT), <repository and commit> — <specific Stockham/WebGL feasibility mechanism>.
Adapted or independently re-expressed as accurately stated; see shipped MIT
notice.` Read the actual licence/copyright, pin files/revision, and trace lineage
online before code reuse. Verdict: **HOLD-LEGAL** for code translation.

### O-38 — EncinoWaves

**What was found and classification.** Plan evidence (verbatim): `EncinoWaves
Apache-2.0`. Additional in-repo evidence records, verbatim, `EncinoWaves =
Apache-2.0 (usable; prefer derive-from-paper to avoid NOTICE obligations)`
(`RESEARCH_REGISTER_2026-07-06.md:133`). Apache-2.0 source entering this
Apache-2.0 fork is same-licence intake, the cleanest licence-compatibility case, and
requires propagation of NOTICE attribution under Apache-2.0 §4(d). Any code or
shader use is `DERIVED-CODE`. Risk: `permissive` as declared.

**Attribution and determination.** A cleared block must be `Reference: <verified
authors> — EncinoWaves (Apache-2.0), <repository and commit> — <specific adapted
mechanism>. Source expression adapted; see shipped Apache licence and NOTICE.`
The in-repo evidence quotes no actual licence text, identifies no copyright holder,
includes no NOTICE, and pins no repository revision. Verify those items and the
file provenance before intake. Verdict: **HOLD-LEGAL**.

### O-39 — `jbouny/fft-ocean`

**What was found and classification.** Plan evidence (verbatim): `MIT △` and
`screen-space projected grid (infinite horizon without a giant mesh)`. The triangle
is declared-only. Studying the broad projected-grid idea can be
`DERIVED-TECHNIQUE`; porting mesh construction, shaders, constants, or code is
`DERIVED-CODE` and needs the actual grant. Risk: `permissive` as declared.

**Attribution and determination.** If cleared, use `Reference: Jérémy Bouny —
jbouny/fft-ocean (MIT), <repository and commit> — projected-grid mechanism.
<Independent implementation or adaptation statement>; see shipped MIT notice if
source expression was used.` Verify licence/copyright, revision, files, and lineage
online before any code-guided work. Verdict: **HOLD-LEGAL**.

### O-40 — three.js `Water` / `Water2`

**What was found and classification.** Plan evidence (verbatim): `MIT △` and
`flow-map rivers/lakes: dual scrolling normals + cycle cross-fade`. The exact addon
file(s), revision, contributors, and Bouny lineage are not pinned. The general
dual-normal/cross-fade idea may be independently expressed; translation of addon
code or shaders is `DERIVED-CODE`. Risk: `permissive` as declared.

**Attribution and determination.** After verification use `Reference: three.js
authors, including verified Bouny lineage — Water/Water2 (MIT), <repository,
revision, files> — dual-normal flow-map cross-fade. <Independent re-expression or
adaptation statement>; see shipped MIT notice.` Verify exact files, history,
licence/copyright and contributor lineage online. Verdict: **HOLD-LEGAL**.

### O-41 — `evanw/webgl-water`

**What was found and classification.** Plan evidence (verbatim): `MIT △ — declared
only in an index.html header; there is no LICENSE file, so the ✔ upgrade requires an
author-confirmed source`. Caustics/refraction algorithm ideas can be independently
implemented, but copying code, shader expression, images, or demos requires a
reliable grant. An informal header without a complete licence file leaves the
intended `DERIVED-CODE` route unresolved. Risk: `unknown`.

**Attribution and determination.** No final block exists until it can identify
`Evan Wallace — webgl-water (<verified licence>), <canonical repository and commit>
— <specific mechanism>`, accurately stating independent derivation or adaptation
and shipping any required notice. Obtain author-confirmed terms, copyright, files,
revision, and asset provenance online. Verdict: **HOLD-LEGAL**.

### O-42 — `threejs-caustics`

**What was found and classification.** Plan evidence (verbatim): `BSD-3 △` and
`caustics projected onto arbitrary meshes`. The triangle is declared-only. The
algorithmic idea can be independently implemented, while source, shaders,
pseudocode, documentation expression, and assets require the BSD-3 grant and
notice. Risk: `permissive` as declared.

**Attribution and determination.** After verification use `Reference: Martin Renou
— threejs-caustics (BSD-3-Clause), <repository and commit> — arbitrary-mesh
caustics mechanism. <Independent implementation or adaptation statement>; see
shipped BSD notice if expression was used.` Read the licence/copyright verbatim,
pin revision/files, and trace code/asset lineage online. Verdict: **HOLD-LEGAL**.

### O-43 — `matsuoka-601/WebGPU-Ocean`

**What was found and classification.** Plan evidence (verbatim): `MIT △` and `No
current row; recorded so a future shoreline lane starts vetted`. MLS-MPM/SPH code,
shaders, or screen-space-fluid structures would be `DERIVED-CODE`; this campaign
currently derives nothing. The declared licence does not clear a future intake.
Risk: `permissive` as declared.

**Attribution and determination.** If a future row adopts it, use `Reference:
matsuoka-601 — WebGPU-Ocean (MIT), <repository and commit> — <specific particle or
screen-space mechanism>. <Independent re-expression or adaptation statement>; see
shipped MIT notice.` Verify the licence/copyright, components, assets, revision,
and exact intended use online first. Verdict: **HOLD-LEGAL** for any future reuse.

### O-44 — Omar Shehata Toon Water tutorial

**What was found and classification.** Plan evidence (verbatim): `UNKNOWN —
technique study only until cleared` and `No code moves under UNKNOWN`. A general
depth-intersection foam idea may be independently rediscovered, but the tutorial's
text, diagrams, screenshots, code, shaders, and assets cannot be used without an
identified grant. Risk: `unknown`.

**Attribution and determination.** No complete block exists. Clearance would
require `Reference: Omar Shehata — <exact Toon Water tutorial/project>, <verified
licence>, <canonical URL> — <specific shoreline mechanism>`, plus an honest
independent-versus-adapted statement and all required notices. Verify the tutorial,
code host, author grant, revision, and asset licences online. Verdict:
**HOLD-LEGAL**.

### O-45 — `byrd-polar/fluid-earth`

**What was found and classification.** Plan evidence (verbatim): `MIT △` and `the
only fully-open nullschool-class stack that includes the GRIB2/NetCDF → fp16-tile
pipeline`. Reusing backend architecture alone may be technique study; translating
pipeline code, schemas, tests, or configuration is `DERIVED-CODE`. Dataset and
dependency terms remain separate from the repository licence. Risk: `permissive`
as declared.

**Attribution and determination.** If cleared use `Reference: Byrd Polar Center,
The Ohio State University — fluid-earth (MIT), <repository and commit> — <specific
GRIB2/NetCDF-to-tile mechanism>. <Independent re-expression or adaptation
statement>; see shipped MIT notice.` Verify full licence/copyright, revision/files,
dependencies, and all input-data terms online. Verdict: **HOLD-LEGAL**.

### O-46 — NWS disclaimer

**What was found and classification.** Plan evidence (verbatim): `The information
on National Weather Service (NWS) Web pages are in the public domain, unless
specifically noted otherwise, and may be used without charge for any lawful purpose`
followed by three conditions against false ownership, implied endorsement, and
presenting modified content as official. This is terms evidence, not a technique,
codebase, dataset, or asset. Risk: `public-domain`.

**Attribution and determination.** No engine-code Reference block is owed for the
disclaimer itself. Product/asset provenance must cite the disclaimer retrieval date
and honor the three conditions; O-01/O-02/O-03 remain product-specific gates.
Re-read the current page and check for contrary product notices online before
reliance. Verdict: **CLEAR-TO-DERIVE** as terms evidence only.

### O-47 — NWS Service Change Notice 25-81

**What was found and classification.** Plan evidence (verbatim): `OpenDAP retired
per SCN 25-81`. The notice is used for a lifecycle fact that shapes the offline
NOMADS architecture. No title, URL, date, quoted notice text, or revision is
provided. The fact can be implemented without copying protected document
expression. Risk: `unknown` for the document expression.

**Attribution and determination.** Use `Reference: NOAA/NWS — Service Change Notice
25-81, <verified title/date/canonical URL> — OpenDAP retirement and replacement
service fact. Architecture independently designed; no notice text or source code
copied.` Verify the canonical notice, revision, exact claim, and page-specific terms
online. Verdict: **ATTRIBUTION-REQUIRED**.

### O-48 — `wgrib2js`

**What was found and classification.** Plan evidence (verbatim): `RTOFS (PD, but
wgrib2js lat-decode gap + 40-156 MB files needing offline decimation)`. The
additional research register says `wgrib2js` is `MIT (verified)` and proposes
`grib-filter → wgrib2js → PNG+sidecar`, but it does not reproduce the licence text.
Using the package in a shipped/dev tool or translating its decoder is
`DERIVED-CODE`; data output remains governed by O-01/O-02. Risk: `permissive` as
declared.

**Attribution and determination.** After verification use `Reference: <verified
author/owner> — wgrib2js (MIT), <package/repository and pinned version> — GRIB2
decoding in the offline wind-data pipeline. Dependency/source code used; see
shipped MIT notice.` Verify the canonical package, version, full licence/copyright,
dependency tree, bundled files, and notice placement online. Verdict:
**HOLD-LEGAL**.

### O-49 — retired OpenDAP path

**What was found and classification.** Plan evidence (verbatim): `OpenDAP retired
per SCN 25-81`. The plan intends no use; it selects the offline NOMADS path instead.
No endpoint, provider-specific OpenDAP service, standard version, client code, or
terms are cited. Risk: `unknown`.

**Attribution and determination.** No Reference block is owed while the path is
excluded. Do not restore or ship the retired integration from this citation. If a
different OpenDAP service or client is proposed, vet that precisely identified
service, standard and code as a new intake. Verdict: **DO-NOT-USE**.

### O-50 — CoverageJSON

**What was found and classification.** Plan evidence (verbatim): `EDR CoverageJSON`
and `NWS-MDL EDR CoverageJSON`. W5 would consume schema facts through existing
machinery; it need not copy specification prose, examples, pseudocode, or library
code. A data-format method/schema is distinct from code expression, but no standard
version or rights statement is named. Risk: `unknown` for specification expression.

**Attribution and determination.** Use `Reference: <verified standards body and
editors> — CoverageJSON <version/specification, licence, canonical URL> — response
schema interpreted by the EDR adapter. Parser independently implemented; no sample
code copied.` Verify the exact specification, version, licence, and fields used
online. Verdict: **ATTRIBUTION-REQUIRED**.

### O-51 — METAR

**What was found and classification.** Plan evidence (verbatim): `METAR IDW`. This
names an observation-message family but not a standard edition, issuing provider,
dataset, endpoint, or fixture source. Parsing format facts differs from bundling
actual observations; the latter is `DATA/API`/`ASSET` and needs product-specific
rights. Risk: `unknown`.

**Attribution and determination.** For parser work, identify and cite the exact
METAR specification/edition and independently implement its schema. For live or
frozen observations use `Data source: <provider/product, URL>; station/time range;
retrieval and byte hashes; transformations; licence.` Verify all identities and
terms online before any new C14 fixture/data lands. Verdict: **HOLD-LEGAL**.

### O-52 — inverse-distance weighting (IDW)

**What was found and classification.** Plan evidence (verbatim): `METAR IDW`. IDW
is a mathematical interpolation family, but no author, publication, variant,
equation, or source is cited. The method can be independently implemented; a
particular publication's explanation, pseudocode, listing, or test data cannot be
copied. Risk: `unknown` and `UNRESOLVED-CITATION`.

**Attribution and determination.** A source-based implementation needs `Reference:
<verified authors> — <canonical IDW publication/title/year/DOI> — <specific weighting
variant>. Independently implemented; technique only — no source was copied.` Either
identify that source online or document that C14 merely reuses existing in-tree code
with no new external derivation. Verdict: **HOLD-LEGAL** for new derivation.

### O-53 — Web Coverage Service (WCS)

**What was found and classification.** Plan evidence (verbatim): `WCS` in the list
of already shipped weather-ingest paths. The campaign may reuse standards-facing
in-tree code, but any new implementation based on an external specification should
cite its exact version and copy no prose/examples/listings. Risk: `unknown` for the
unspecified standard expression.

**Attribution and determination.** Use `Reference: Open Geospatial Consortium —
Web Coverage Service <verified version/specification and URL> — request/coverage
interchange contract. Adapter independently implemented; no sample code copied.`
Verify the exact version, licence/terms, operations and schemas online. Verdict:
**ATTRIBUTION-REQUIRED**.

### O-54 — FBM sea-state masking

**What was found and classification.** Plan evidence (verbatim): `sample a
sea-state texture or FBM per-vertex/pixel`. “FBM” is not expanded and no publication,
author, implementation, or URL is cited. A generic fractal-noise idea is an
algorithmic technique, but distinctive source code, shader structure, constants,
pseudocode or prose are protected. Risk: `unknown` and `UNRESOLVED-CITATION`.

**Attribution and determination.** An external route requires `Reference: <authors>
— <canonical FBM publication/project, licence or venue/year, URL/DOI> — low-frequency
sea-state modulation. Independently implemented for the ocean pipeline; technique
only — no source was copied.` Alternatively design solely from existing in-tree
primitives without an external derivation claim. Online source/licence verification
is owed for the external route. Verdict: **HOLD-LEGAL**.

### O-55 — curl-noise wind-field bake

**What was found and classification.** Plan evidence (verbatim): `bake a curl-noise
global wind texture` and `Precedents in-tree: curl noise`. No external paper or code
is cited; the intended implementation may simply reuse already shipped in-tree
logic. The mathematical technique is not protected, but any outside expression
would have its own lineage. Risk: `unknown` for an external source and
`UNRESOLVED-CITATION`.

**Attribution and determination.** No external block is needed for a demonstrably
in-tree-only reuse; preserve the existing file's shipped provenance. If an external
source guides new behavior, identify author/project or paper, licence/URL and exact
mechanism in an L-24 block after online verification. Verdict: **HOLD-LEGAL** for
external derivation; in-tree reuse is outside this intake.

### O-56 — ECMWF forum licence-transition post

**What was found and classification.** Plan evidence (verbatim):
`forum.ecmwf.int/t/13464`. The plan uses this secondary post to assert ERA5's 2025
licence transition, but quotes no post text and names no author/date. A forum post is
evidence, not the dataset licence and not derivation input. Risk: `unknown`.

**Attribution and determination.** If retained, cite `Reference/evidence: <verified
author> — <post title>, ECMWF Forum, <date/URL> — licence-transition announcement
only; primary ERA5 terms remain controlling` only as change history, while O-06 must cite
the primary current ERA5 terms. Verify both sources online; the forum post alone may
not clear data intake. Verdict: **HOLD-LEGAL**.

### O-57 — PO.DAAC citation policy

**What was found and classification.** Plan evidence (verbatim): `points to PO.DAAC
citation policy`. No policy title, URL, version, quotation, or prescribed citation
is given. It may describe attribution without granting product redistribution.
Risk: `unknown` and `UNRESOLVED-CITATION`.

**Attribution and determination.** No accurate block exists. Identify and read the
canonical policy online, record its version and required form, and connect it to the
exact OSCAR product and product licence under O-08. Verdict: **HOLD-LEGAL**.

### O-58 — unnamed NASA full/open-sharing policy

**What was found and classification.** Plan evidence (verbatim): `NASA policy:
"full and open sharing of Earth science data... There will be no period of
exclusive access"`. The ellipsis is not a complete operative term, and no policy
title, office, URL, date, or product scope is identified. General access policy is
not a MERRA-2 redistribution licence. Risk: `unknown` and
`UNRESOLVED-CITATION`.

**Attribution and determination.** After identification use `Reference/evidence:
NASA <office> — <policy title/date, canonical URL> — general Earth-science sharing
policy only; it is not the MERRA-2 product licence.` Then separately verify the
exact product under O-09. No dataset bytes may be cleared from the partial
quotation. Verdict: **HOLD-LEGAL**.

### O-59 — GitHub licence API

**What was found and classification.** Plan evidence (verbatim): `GitHub licence
API` for both `cambecc/earth` and `RaymanNg/3D-Wind-Field`. An API classification is
secondary metadata, not the repository's licence grant or an immutable evidence
artifact. It is not technique, code, data, or asset input. Risk: `unknown` as legal
proof.

**Attribution and determination.** No engine-code block is owed to the API. Read
and retain the actual upstream licence/copyright at a pinned revision, as L-12 later
did for RaymanNg; resolve the `earth` author spelling under O-27. The API label must
not be the sole clearance basis. Verdict: **DO-NOT-USE** as sole licence proof.

## 6. Supplemental `migration_doc/` search dispositions

The repository-wide Markdown search used the requested aurora/ocean/FFT/spectrum
terms and related implementation names. It found **24 additional named or unresolved
sources** that do not occur as adopted references in the two source plans: two C15
pattern guides plus two indirect C15 night-gate sources, six wind/tooling references,
six FFT/ocean references, and eight bathymetry/context references. They are not added to the
27-reference C15 or 59-reference C14 source-document counts, and they do not expand
campaign scope. They are recorded so a future intake cannot silently treat a
catalog mention as clearance.

Attribution owed **now** is `No` for every `S-xx` row because none is adopted by the
two source plans and this pass derives or includes nothing from it. The fourth
column and prose record the conditional author/data credit, L-24 block, or shipped
notice that would become owed if a future plan adopts and clears the source.

| ID | Additional source and in-repo location | Intended or possible use | Evidence, risk, and attribution | Online verification owed | Verdict |
| --- | --- | --- | --- | --- | --- |
| S-01 | `satvis`, `REFERENCE_VISUALS_CATALOG_2026-08-09.md:49` | C15-05/06 data-driven visualization pattern; possible code study | `USABLE MIT ✔` is asserted but licence text is not quoted. Risk `permissive` as declared; author Florian Mauracher owed | Canonical repo/revision, verbatim licence/copyright, files and dependencies | `HOLD-LEGAL` for code-derived work |
| S-02 | `satellite.js`, catalog line 50 | C15 SGP4/SDP4 foundation/pattern | `USABLE MIT ✔ (LICENSE.md, not LICENSE)` asserted without text. Risk `permissive` as declared; Shashwat Kandadai/UCSC owed | Canonical repo/version, verbatim licence/copyright, package/dependency lineage | `HOLD-LEGAL` for code-derived work |
| S-03 | Weacast, catalog line 65 and weather-ingest roadmap line 212 | GFS/ARPEGE downloader, tiling, API architecture/code | `USABLE MIT △`. Risk `permissive` as declared; Kalisio owed | Licence/copyright, repo/revision/files, dependencies and dataset terms | `HOLD-LEGAL` |
| S-04 | WeatherLayers GL, catalog line 69 and weather roadmap line 216 | C14 W4 grid/barb/particle technique study | `FILE-COPYLEFT MPL-2.0 dual-commercial △`; no wholesale copy. Risk `copyleft`; Petr Sloup owed only for an independently cited idea | Exact licence/version and a separate non-code technical source if the idea is adopted | `DO-NOT-USE` for file/code derivation |
| S-05 | `leaflet-velocity`, catalog line 70 and weather roadmap line 215 | grib2json interpolation/format reference | `UNKNOWN`, CSIRO variant, SPDX `NOASSERTION`; `no reuse until cleared`. Risk `unknown`; Dan Wild/CSIRO cannot yet be credited completely | Canonical fork/revision, actual grant, lineage and exact files | `DO-NOT-USE` under current evidence |
| S-06 | `hypatia-earth/zero`, `RESEARCH_REGISTER_2026-07-06.md:84` and three.js mine line 85 | Flow-field particle/advection implementation study | Register says MIT “verified” but quotes no text. Risk `permissive` as declared; author unknown in evidence | Canonical repo/revision, verbatim licence/copyright, files and dependencies | `HOLD-LEGAL` |
| S-07 | `pngjs`, research register line 84 | Possible PNG encoder dependency for offline wind assets | Register says MIT “verified” but quotes no text. Risk `permissive` as declared; owner notice owed | Canonical package/version, licence/copyright, dependency and bundled-code audit | `HOLD-LEGAL` |
| S-08 | `GarrettGunnell/Water`, research register line 133 | FFT/water implementation study | Register says MIT “re-verified” but quotes no text. Risk `permissive` as declared; Garrett Gunnell owed | Repository/revision, verbatim licence/copyright, source/asset lineage | `HOLD-LEGAL` |
| S-09 | OTFFT, research register lines 133/138 | Stockham shared-memory FFT component behind GodotOceanWaves | Only an `OTFFT MIT attribution` assertion; no precise repo/version or text. Risk `unknown`; author/owner unresolved | Exact OTFFT project/version, full licence/copyright, files and Godot lineage | `HOLD-LEGAL` |
| S-10 | `iamyoukou/fftWater`, research register lines 133/144 | Explicitly prohibited FFT-ocean code reference | `no license file (all rights reserved)` and `Never port`. Risk `proprietary`; no attribution because unused | None unless an owner supplies a compatible grant | `DO-NOT-USE` |
| S-11 | `codeagent/webgl-ocean`, research register lines 133/144 | Explicitly prohibited FFT-ocean code reference | `no license file (all rights reserved)` and `Never port`. Risk `proprietary`; no attribution because unused | None unless an owner supplies a compatible grant | `DO-NOT-USE` |
| S-12 | “Mastin,” `WATER_RENDERING_DESIGN.md:294` | Named FFT-ocean technique alongside Tessendorf | `UNRESOLVED-CITATION`; no title, author identity, URL, or licence. Risk `unknown`; attribution cannot be formed | Identify author/work/year/URL and distinguish paper math from code | `HOLD-LEGAL` |
| S-13 | `Three.js-Ocean-Scene`, catalog line 97 | Surface-over-procedural-seafloor integration | `USABLE MIT △`. Risk `permissive` as declared; Nugget8 owed | Repository/revision, actual licence/copyright, source and asset lineage | `HOLD-LEGAL` |
| S-14 | Cesium GPU-wind blog, `THREEJS_TECH_MINE_2026-07-05.md:85` | Globe flow-field technique study | Only a vague name; no title, author, URL, date, code or terms. `UNRESOLVED-CITATION`, risk `unknown` | Identify the exact post and any separately licensed sample code/assets | `HOLD-LEGAL` |
| S-15 | CTOD, catalog line 93 | COG-to-quantized-mesh bathymetry pipeline | `USABLE MIT △`. Risk `permissive` as declared; Sogelink Research owed | Repository/revision, licence/copyright, dependencies and input-data terms | `HOLD-LEGAL` |
| S-16 | `rio-rgbify`, catalog line 94 | DEM-to-Terrain-RGB bathymetry pipeline | `USABLE MIT △` only as a grouped declaration. Risk `permissive` as declared; Mapbox owed | Exact repo/version, licence/copyright, dependencies and data terms | `HOLD-LEGAL` |
| S-17 | `tilezen-joerd`, catalog line 94 | ETOPO-to-terrain-tile pipeline/code | Grouped `USABLE MIT △` does not quote this project's licence. Risk `permissive` as declared; Tilezen owed | Exact repo/version, licence/copyright, dependencies and code lineage | `HOLD-LEGAL` |
| S-18 | AWS Terrain Tiles, catalog line 94 | Hosted ETOPO1-inclusive terrain dataset/service | `still free` is not a licence. Risk `unknown`; service/data owner owed | Canonical service/product, owner, licence, provenance, caching and redistribution | `HOLD-LEGAL` |
| S-19 | GEBCO 2024 grid, `WATER_RENDERING_DESIGN.md:198` and catalog line 92 | Possible global bathymetry data asset | Catalog merely says `GEBCO/ETOPO grids are` open; no exact licence text. Risk `unknown`; GEBCO/data contributors owed | Exact grid/version/DOI, licence, attribution, download/hash and derivative terms | `HOLD-LEGAL` |
| S-20 | NOAA ETOPO / ETOPO1, catalog lines 92/94 | Possible bathymetry input/derived terrain asset | Called open/ETOPO-inclusive, but no product licence text or exact version. Risk `unknown`; NOAA/product credit owed | Exact product/version/DOI, licence, files/hashes, transforms and redistribution | `HOLD-LEGAL` |
| S-21 | CesiumJS World Bathymetry code stack, catalog line 92 | Existing upstream code/context, or future upstream merge | `USABLE Apache-2.0 △ — same license as fork, directly mergeable` is correct under the shipped baseline. Risk `permissive`; Cesium GS/upstream notice owed for new intake | Exact upstream revision/files and Apache licence/NOTICE pinning | `HOLD-LEGAL` for new external intake |
| S-22 | Cesium ion World Bathymetry data, catalog line 92 | Possible hosted bathymetry asset/service | Catalog expressly says `ion DATA not open`. Risk `proprietary`; no attribution because no intake is allowed | None unless Cesium supplies terms compatible with the intended distribution/use | `DO-NOT-USE` |
| S-23 | Unidentified zenith twilight-photometry μ ladder, `FEATURE_INVENTORY.md:686` | Indirect source behind the existing sky-brightness function C15's night gate will reuse | `published zenith twilight-photometry μ ladder` is not bibliographically identified. `UNRESOLVED-CITATION`; risk `unknown` | Identify publication/authors/DOI and existing code provenance if C15 copies rather than calls the in-tree implementation | `HOLD-LEGAL` for new external derivation |
| S-24 | Unidentified lunar `p^3.64` phase-flux law, `FEATURE_INVENTORY.md:686` | Indirect source in the same in-tree sky-brightness implementation | No source is identified for `p^3.64`. `UNRESOLVED-CITATION`; risk `unknown` | Identify publication/authors/DOI and audit the constant's existing lineage before new derivation | `HOLD-LEGAL` for new external derivation |

### S-01 — `satvis`

Catalog evidence (verbatim): `USABLE MIT ✔` and `C15-05/06 data-driven-viz
pattern`. Pattern study is not permission to translate code. A cleared block is
`Reference: Florian Mauracher — satvis (MIT), <repository and commit> — <specific
worker/property/pass-prediction mechanism>. <Independent or adapted statement>;
see shipped MIT notice if code was used.` The actual licence, copyright, files,
dependencies, and revision remain owed online. Verdict: **HOLD-LEGAL** for
code-derived work.

### S-02 — `satellite.js`

Catalog evidence (verbatim): `USABLE MIT ✔ (LICENSE.md, not LICENSE)` and `Standard
SGP4/SDP4 propagation`. C15 does not adopt this dependency in its queue. If it ever
does, use `Reference: Shashwat Kandadai / UCSC — satellite.js (MIT), <repository and
version> — <specific propagation use>. Dependency/source used; see shipped MIT
notice.` Verify the actual licence, copyright lineage, package version and
dependencies online. Verdict: **HOLD-LEGAL** for code-derived work.

### S-03 — Weacast

Catalog evidence (verbatim): `USABLE MIT △` and `GFS/ARPEGE GRIB2 downloaders,
tiling, probe API`. Backend architecture can be designed independently, while
source/configuration translation is `DERIVED-CODE`. If adopted, use `Reference:
Kalisio — Weacast (MIT), <repo/revision> — <specific mechanism>`, accurately stating
adaptation and shipping the notice. Verify licence, dependencies, and data-provider
terms online. Verdict: **HOLD-LEGAL**.

### S-04 — WeatherLayers GL

Catalog evidence (verbatim): `FILE-COPYLEFT MPL-2.0 dual-commercial △` and
`technique study only, no wholesale copy`. File or shader derivation would incur
MPL file-level obligations and is outside the intended MIT-only intake. A separately
identified paper or clean-room design could receive a scholarly Reference block,
but the repository itself must not be the code template. Verify only if that
separate route is proposed. Verdict: **DO-NOT-USE** for file/code derivation.

### S-05 — `leaflet-velocity`

Catalog evidence (verbatim): `UNKNOWN (CSIRO variant license, SPDX NOASSERTION) —
no reuse until cleared`. Neither ordinary project-name attribution nor a
`Reference:` comment creates permission. Identify the precise fork, author/CSIRO
lineage, revision, actual grant, and files online before reconsideration. Verdict:
**DO-NOT-USE** under current evidence.

### S-06 — `hypatia-earth/zero`

Additional evidence (verbatim): `hypatia-earth/zero ... = MIT (verified)`, but the
licence text, author and revision are absent. Any flow-field code/shader translation
is `DERIVED-CODE`. A future block must name the verified author/project, MIT licence,
URL/revision, exact mechanism, adaptation, and shipped notice. Complete that online
verification first. Verdict: **HOLD-LEGAL**.

### S-07 — `pngjs`

Additional evidence (verbatim): `pngjs = MIT (verified)`. Using a package in a
development tool is dependency/code intake even if only generated PNG bytes ship.
The package/version, copyright, complete licence, dependency tree, and distribution
of tooling must be verified online; then carry its normal dependency notice rather
than a false technique-only block. Verdict: **HOLD-LEGAL**.

### S-08 — `GarrettGunnell/Water`

Additional evidence (verbatim): `GarrettGunnell/Water` appears among `multiple
independently re-verified MIT sources`, but no licence wording, revision, or
mechanism is recorded. Code/shader translation therefore remains blocked. If
adopted, the block must name Garrett Gunnell, repository, MIT, commit, exact water
mechanism, adaptation, and shipped notice. Verify all of that online. Verdict:
**HOLD-LEGAL**.

### S-09 — OTFFT

Additional evidence (verbatim): `its OTFFT MIT attribution` and
`2Retr0/OTFFT`. This does not precisely identify an upstream repository/version or
quote its grant. OTFFT code or shader structure is `DERIVED-CODE`; the Stockham
algorithm itself can instead be independently sourced under O-21. Identify the
component, author, revision, full licence/copyright and exact Godot lineage online
before any component-guided work. Verdict: **HOLD-LEGAL**.

### S-10 — `iamyoukou/fftWater`

Additional evidence (verbatim): `no license file (all rights reserved —
reference-reading only, no code porting)` and `Never port from iamyoukou/fftWater`.
All-rights-reserved code, shaders, constants, pseudocode-like structure, and assets
may not enter the fork; attribution cannot cure the missing grant. No online work is
owed unless the owner supplies a compatible licence. Verdict: **DO-NOT-USE**.

### S-11 — `codeagent/webgl-ocean`

Additional evidence (verbatim): `codeagent/webgl-ocean have no license file (all
rights reserved — reference-reading only, no code porting)` and `Never port from
... codeagent/webgl-ocean`. No code, shader, pseudocode-like structure, constants,
tests, or assets may be translated or bundled. A citation does not substitute for
permission. No online work is owed unless the owner supplies a compatible grant.
Verdict: **DO-NOT-USE**.

### S-12 — “Mastin”

Additional evidence (verbatim): `FFT-based ocean (Tessendorf/Mastin)`. A surname
alone cannot identify a paper, author, implementation, edition, or URL and must not
be expanded by guesswork. If this is a published algorithm, its ideas may be
independently implemented while prose, pseudocode, figures and listings remain
protected. Identify the exact work, full author, year, mechanism, URL and any code
licence online before deriving from it. Verdict: **HOLD-LEGAL** and
`UNRESOLVED-CITATION`.

### S-13 — `Three.js-Ocean-Scene`

Catalog evidence (verbatim): `USABLE MIT △`, author `Nugget8`, and `Water surface
over procedural sea floor, chunked culling`. Code, shader or asset translation is
`DERIVED-CODE`/`ASSET`, not paper-method reuse. A cleared block must name Nugget8,
project, verified MIT licence, URL/commit, exact mechanism and adaptation, with the
notice and asset provenance shipped. Verify repository history, dependencies and
assets online. Verdict: **HOLD-LEGAL**.

### S-14 — Cesium GPU-wind blog

Additional evidence (verbatim): `Cesium GPU-wind blog`; no title, author, date, URL,
sample repository, or terms are given. That is an `UNRESOLVED-CITATION`, not a
licence determination. Identify the exact article and independently licensed code
or assets, if any; then distinguish high-level algorithm study from copying article
expression or samples in the Reference block. Verdict: **HOLD-LEGAL**.

### S-15 — CTOD

Catalog evidence (verbatim): `USABLE MIT △`, author `Sogelink Research`, and `COG →
quantized-mesh on demand (GEBCO/ETOPO → fork-consumable terrain)`. Pipeline source
reuse is `DERIVED-CODE`; input/output data rights remain separate. After online
verification, an L-24 block must identify project, owner, MIT, repository/revision,
specific mechanism and adaptation, and ship the notice. Also vet dependencies and
every bathymetry input. Verdict: **HOLD-LEGAL**.

### S-16 — `rio-rgbify`

Catalog evidence (verbatim): `rio-rgbify / tilezen-joerd | pipelines | USABLE MIT
△` and `DEM→Terrain-RGB encoding`. The grouped declaration does not prove this
project's exact grant or component lineage. Verify the canonical Mapbox repository,
version, complete licence/copyright, dependencies and source files online. Any code
adaptation requires a project-specific L-24 block and MIT notice; dataset provenance
is separate. Verdict: **HOLD-LEGAL**.

### S-17 — `tilezen-joerd`

Catalog evidence (verbatim): `rio-rgbify / tilezen-joerd | pipelines | USABLE MIT
△`. This grouped declaration does not quote `tilezen-joerd`'s actual licence or
identify a revision. Pipeline-code translation is `DERIVED-CODE`. Verify the
canonical repository/version, full licence/copyright, dependencies and files
online; then use a project-specific L-24 adaptation block and ship the notice.
Verdict: **HOLD-LEGAL**.

### S-18 — AWS Terrain Tiles

Catalog evidence (verbatim): `ETOPO1-inclusive AWS Terrain Tiles (still free)`.
“Free” is not a licence, and a hosted dataset/service is independent of
`tilezen-joerd` code. Verify the service and data owner, canonical product/version,
source-data lineage, licence, attribution, caching, redistribution and derivative
terms online. A cleared intake requires a data-provenance block with retrieval
hashes and transformations. Verdict: **HOLD-LEGAL**.

### S-19 — GEBCO 2024

Additional evidence (verbatim): `GEBCO 2024 at 15 arcsec` and `GEBCO/ETOPO grids
are` open. These statements do not quote the grid's actual licence, attribution,
version/DOI, or redistribution terms. Bathymetry bytes or derived terrain are
`ASSET` intake. Require `Data source: GEBCO — <exact grid/version/DOI/URL>, <exact
licence>; source hashes; crop/resample/mesh transforms; changes made.` Verify every
field online before bundling. Verdict: **HOLD-LEGAL**.

### S-20 — NOAA ETOPO / ETOPO1

Additional evidence (verbatim): `GEBCO/ETOPO grids are` open and
`ETOPO1-inclusive AWS Terrain Tiles (still free)`. Neither phrase identifies the
chosen NOAA product/version or grants rights in a third-party derived tile service.
Treat raw NOAA data and hosted terrain tiles separately. Verify product DOI/URL,
licence, attribution, source hashes, transformations and redistribution online;
then use a complete data-provenance block. Verdict: **HOLD-LEGAL**.

### S-21 — CesiumJS World Bathymetry code stack

Catalog evidence (verbatim): `USABLE Apache-2.0 △ — same license as fork, directly
mergeable`. That annotation is correct under the shipped Apache-2.0 baseline.
Existing inherited fork code is not a new intake; copying a newer upstream revision
is. Before such a merge, pin the files and revision and preserve the Cesium GS
copyright and Apache licence/NOTICE. Verdict: **HOLD-LEGAL** for new external intake
on revision and NOTICE pinning alone.

### S-22 — Cesium ion World Bathymetry data

Catalog evidence (verbatim): `ion DATA not open`. That is a hosted proprietary data
service/asset, not the Apache-licensed CesiumJS code in S-21. No amount of source
attribution creates bundling, redistribution, caching, or offline rights. Keep ion
data out of committed fixtures and distributable assets unless Cesium supplies
separate compatible terms and a maintainer opens a new intake. Verdict:
**DO-NOT-USE**.

### S-23 — unidentified zenith twilight-photometry μ ladder

Additional evidence (verbatim): `the published zenith twilight-photometry μ ladder`;
the same entry says `C15's aurora night-gate is to reuse` the existing shared
elevation function. No publication, author, title, DOI, URL, or licence is
identified. Calling the shipped implementation adds no new intake; copying its
external values or re-deriving a new curve from the unidentified publication would.
Identify and attribute the source and audit existing code lineage online before the
latter route. Verdict: **HOLD-LEGAL** for new external derivation and
`UNRESOLVED-CITATION`.

### S-24 — unidentified lunar `p^3.64` phase-flux law

Additional evidence (verbatim): `a full-moon term with a p^3.64 phase-flux law`.
No author, publication, formula source, DOI, URL, or licence is identified. The
mathematical law can be independently implemented once sourced, while a paper's
prose, pseudocode, figures or listings cannot be copied. Existing in-tree reuse adds
no new intake; any C15 re-derivation needs a paper-form L-24 block and online
lineage verification. Verdict: **HOLD-LEGAL** for new external derivation and
`UNRESOLVED-CITATION`.

## 7. Closing determination

### 7.1 Coverage and verdict counts

| Inventory | Source-document references | `CLEAR-TO-DERIVE` | `ATTRIBUTION-REQUIRED` | `HOLD-LEGAL` | `DO-NOT-USE` |
| --- | ---: | ---: | ---: | ---: | ---: |
| Campaign 15 queue | 27 | 1 | 8 | 14 | 4 |
| Campaign 14 ocean plan | 59 | 1 | 17 | 37 | 4 |
| Direct-plan total | 86 | 2 | 25 | 51 | 8 |
| Supplemental search-only watchlist | 24 | 0 | 0 | 19 | 5 |
| All records in this document | 110 | 2 | 25 | 70 | 13 |

The C15 count comprises 17 linked sources, six named-but-unlinked sources, and
four unresolved citations. The ocean count uses the strict source/work/algorithm
identity rule: named standards, algorithms, policy documents and retired services
are not silently folded into a dataset or codebase, while aliases and mere format
descriptors are deduplicated as explained in §5. Each of the 86 direct-plan
references has exactly one inventory row and exactly one matching prose
determination. The 24 search-only records have the same one-row/one-determination
shape but are not campaign dependencies until a plan adopts them.

`O-01` and `O-02` follow the A-07 split-count precedent: each source remains one
record and is counted once under the committed/bundled leg's row-level
`HOLD-LEGAL` verdict. Its live `DATA/API` leg remains `ATTRIBUTION-REQUIRED` and
does not create a second record.

### 7.2 Items blocking source-dependent implementation

The shipped baseline is Apache-2.0: `LICENSE.md`, `packages/engine/LICENSE.md`, and
`package.json` (`"license": "Apache-2.0"`) agree. The task statement's MIT claim is
the open framing item routed to maintainer ruling item 11 in
`migration_doc/RULING_REQUESTS_2026-08-21.md` (recommendation: confirm
Apache-2.0), not a global blocker. On the licence-compatibility axis, permissive
MIT/BSD/ISC/Unlicense/public-domain/CC-BY intake is compatible with Apache-2.0 when
its licence and attribution obligations, including NOTICE-file attribution under
Apache-2.0 §4(d), are propagated; copyleft and noncommercial intake remains
disqualified. Every row-specific hold for missing licence text, unpinned revisions,
unquoted terms, unresolved ownership, or absent NOTICE evidence is independent of
that baseline and stands unchanged.

For Campaign 15, the following records block the affected starts:

- `A-22`, `A-24`, and `A-26` block any AuroraRendererUnity/paper-derived geometry,
  curtain, or emission-kernel work until the repository, paper, missing second
  source, and code/paper boundary are verified.
- `A-07`, `A-08`, `A-10`–`A-12`, `A-14`, `A-15`, and `A-19` block committed
  endpoint snapshots and fixtures. Synthetic locally authored fixtures can support
  adapter scaffolding, but source bytes cannot land on the general disclaimer alone.
- `A-18` blocks OVATION Prime model/code derivation; only separately cleared SWPC
  output is in scope. `A-25` blocks the Fairbanks historical replay/photo asset.
  `A-27` blocks the C15-06P solar-prominence state provider until “Eclipse Explorer”
  is identified and its owner, endpoint, terms, and attribution form are established.
- `A-01`–`A-06`, `A-09`, and `A-13` allow independent factual/mathematical
  implementation only with the stated attribution and online source check before
  landing. `A-17`, `A-20`, `A-21`, and `A-23` are exclusions, not workarounds.

For Campaign 14, the following records block the affected starts:

- `O-11`–`O-14`, `O-16`, `O-17`, `O-19`, `O-24`, `O-52`, `O-54`, and `O-55`
  block source-guided W2/W3 model, spreading, foam, local-injection, IDW, FBM, and
  curl-noise work until the vague citations are resolved or the work is documented
  as wholly in-tree/independent.
- `O-25`, `O-27`, `O-29`, `O-37`–`O-45`, and `O-48` block new file-level code or
  dependency intake. `O-28`, `O-30`, and `O-34`–`O-36` may proceed only inside the
  already determined revisions/lineage with notices; new files or revisions require
  the stated delta check.
- `O-04` blocks the live EDR source; `O-06`–`O-09` block optional unverified
  streams/assets; `O-22` blocks use of the external FFT performance claim as a
  budget justification. `O-01` and `O-02` block new committed/bundled GFS/RTOFS
  asset legs until product-specific snapshot terms are quoted; their live `DATA/API`
  legs remain `ATTRIBUTION-REQUIRED`. The shipped GFS sample pair is
  **PRE-EXISTING** intake, not new clearance. W4's route still requires
  `O-01`–`O-03`, `O-46`, `O-47`, and `O-48` provenance/tool closure before new
  generated bytes or tooling land.
- `O-26`, `O-31`, and `O-49` are excluded code/service paths. `O-59` excludes an
  API label as sole licence proof. None may be used to bypass a hold.

Purely in-tree W0/W1 contract and baseline work that derives from no external
expression is not blocked by an item-level licence hold. Separate campaign-governance
holds, including the current Campaign 12 dependency, remain authoritative and are
not changed by this document.

### 7.3 Online verification owed

No online verification was performed in this pass. Before the corresponding code,
data, fixture, or asset lands, complete and retain the exact checks in each row for:

- C15: `A-01`–`A-16`, `A-18`, `A-19`, `A-22`, and `A-24`–`A-27`.
- C14: `O-01`–`O-25`, `O-27`–`O-30`, `O-32`–`O-48`, and `O-50`–`O-59`.
- Search-only sources, if adopted: `S-01`–`S-03`, `S-06`–`S-09`,
  `S-12`–`S-21`, and `S-23`–`S-24` (19 rows).

No current verification is owed for excluded `A-17`, `A-20`, `A-21`, `A-23`,
`O-26`, `O-31`, `O-49`, `S-04`, `S-05`, `S-10`, `S-11`, or `S-22` unless a maintainer
first reopens that source. Reopening is a new intake, not a change to the verdict in
this record.

## 8. Verification record

After the landing-blocking edits, the local structural checks were re-run and
confirmed all of the following:

- this file exists and contains one balanced fenced-code block;
- inventory rows and prose headings are each unique and contiguous at `A-01` through
  `A-27`, `O-01` through `O-59`, and `S-01` through `S-24`;
- all 110 references appear exactly once as an inventory row and exactly once as a
  matching prose determination;
- all six Markdown tables have internally consistent pipe-column counts, and no
  box-drawing characters or first-person drafting language occurs; and
- this documentation lane wrote no path other than
  `migration_doc/LICENSE_VETTING_AURORA_OCEAN_2026-08-21.md`.

The exact `git status --porcelain` control is intentionally not run here: the task
also states `No git commands`, and that explicit prohibition controls this lane.
Consequently this document records the single-path write audit but does not claim a
Git-derived worktree status.
