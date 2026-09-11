# Ruling requests — 2026-09-08

## RR-2026-09-08-1 — Sharp smoke pipeline construction

**Pending; not an approval.** The newly captured `sharp-baseline-01` is an ordinary
native `FAIL 1`: the 4x2 transformed image has four channels instead of the required
three. Independent source review found that both installed Sharp versions execute
`removeAlpha` before `ensureAlpha`, irrespective of JavaScript chaining order;
the smoke put both flags in one pipeline. Fresh bounded 1x1 diagnostic controls
confirmed four channels with both flags and three when removal uses a second
pipeline, without changing the installed inputs. Request permission to finish the
existing resize/extract/ensure-alpha/composite pipeline, then call `removeAlpha`
on its completed PNG in a second Sharp instance. Preserve the existing 4x2x3
assertion, exact 24 RGB bytes, orientation and malformed-input checks, both
resolution contexts in the same process, native-selection checks, and every
historical failure. Rerun under a fresh identity after independent source review;
do not claim the complete pixel oracle has already passed. The separate Windows
root0.35.4-then-nested0.34.5 libvips error remains open: isolated versions and the
reverse order succeeded, but newer-then-older failed. The already approved scoped
dependency update still needs candidate proof and is not accepted by this request.

Evidence is retained in
`tmp/astra-dependency-implementation-20260908/_lane-out/`: the original
`root/sharp-baseline-01-*`, `root/sharp-isolation-*-01.jsonl`,
`root/sharp-isolation-result-01.json` (SHA-256
`29781339e8f074aa54ab2838ab5102bf371f8cbe3e91b657f3db7d85da53882a`),
and `galadriel/GALADRIEL_SHARP_BASELINE_DIAGNOSIS_01.md` (SHA-256
`a701c20741370ff003ca3af27d3a0d30f1244e2ff321931793e0cdd3ce865a3b`).
Authority is charter §1.1; this request does not pause the campaign or prevent
independent work on the approved documentation bridge.

## RR-2026-09-08-2 — Exact documentation comparison corrections

**Pending; not an approval.** Full documentation comparison01 is a retained
native `FAIL 1`. Independent review identifies327 footer-only false-reds because
the comparator excludes actual emitted filenames such as `global.html#ANNOTATIONS`,
and nine JSDoc4 anchor corrections across five named pages: whitespace is trimmed
from labels and unintended trailing `%20` is removed from URLs. Request a fresh,
independently reviewed successor comparator that recognizes HTML before a literal
`#` suffix, preserves the exact-one contextual footer checks, and permits only
the explicitly enumerated old/new anchors and occurrence counts in
ArcGisMapServerImageryProvider(two), ArcGisMapService(one), Cesium3DTileset(two),
GaussianSplat3DTileContent(two), and IntersectionTests(two). All other HTML,
hrefs, labels, file membership, declarations and types.txt bytes remain required
to match; no global whitespace or ordering normalization is proposed. The actual
ordering changes are being repaired in the template, not waived. Add negative
controls for extra/missing/moved footer tokens, fragment-named files with extra
content, changed anchor href/label/count and changes outside the exact listed
anchors. Preserve comparison01 unchanged and perform a new capture/comparison
after source review. This accepts a specific upstream link-rendering correction,
not undocumented API loss, a blanket generator-delta exception or browser proof.

Evidence under `tmp/astra-dependency-implementation-20260908/_lane-out/`:

- `root/docs-candidate-01/full-candidate-comparison-01.json`,369378 bytes,
  SHA256 `0a2ab46f8cf44f4533455809beb3f0e3ace4034c55520be1339ca4b14e865224`.
- `galadriel/GALADRIEL_FULL_DOCS_COMPARISON_DIAGNOSIS_01.md`,7389 bytes,
  SHA256 `4e4d2ed5ec678fcfd7cf7f0b3b57ecda11175cf282b34f59804386d6b5e35ddd`.
- `galadriel/ARWEN_DOCS_FRAGMENT_CLASSIFIER_REVIEW_01.md`,3096 bytes,
  SHA256 `cccf8ca683e7a687a1e0ddafe64fd9f7e31c6e5f9caa6b4908009af458af1b39`.

Authority is charter §1.1. This request does not pause the campaign, authorize a
comparator mutation, or block the separately approved ordering repair and
source-only downstream readiness work.
