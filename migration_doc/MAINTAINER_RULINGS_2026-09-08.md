# Maintainer rulings — 2026-09-08

## R-2026-09-08-1 — GodRay fixture-identity repair

The maintainer answered the fixture-repair proposal with “1. okay then make this
happen next.” Repair only the test fixture so the object modified by the test is
the object read by the render closure. Preserve production behavior, all 29 test
names, missing-depth and no-work false assertions, and cleanup checks. Perform
scoped static validation, independent source review and a fresh full source test
capture; preserve the three historical 28/29 FAIL captures unchanged.

The accompanying dependency request asks for a concrete update explanation, not
adoption of unsupported overrides or a declaration-generator migration. Existing
September 7 controlled-install and justified-manifest authority is unchanged.
No commit, push, app build, browser run or broader goal-automation resume is
included in this bounded fixture repair. Execution is recorded in
[the fixture wave](branches/ASTRA_HRN_FIXTURE_2026-09-08.md).

## R-2026-09-08-2 — Scoped Sharp compatibility update and JSDoc 4 bridge

The maintainer approved both concrete dependency proposals: “OKay both are
approved, please continue. I will resume the goal as well.” Proceed with the
version-scoped Transformers4.2.0 Sharp0.35.4 override and the repository-local
tsd-jsdoc2.5.0-derived compatibility package for JSDoc4.0.5/Salty0.2.12, including
the custom HTML template migration. Preserve the generator's entrypoints/emitter,
public declarations, Sandcastle functionality and unrelated overrides. The local
fork must preserve upstream license/provenance and ship as a reproducible local
tarball, not an unproven directory link or invented published package.

R2's controlled install/recovery and script-review discipline remains in force.
Serialize dependency mutation and captures; require focused tests, generated-API
comparison, fresh identified build/browser checks and independent review before
acceptance. ONNX1.24.3 and Adm-Zip remain unchanged; no residual security finding
is waived. This is not permission for a forced upgrade or broad generator rewrite.
No commit/push is included in this bounded wave. The goal tool now reports active;
root did not synthesize its resume. See [the implementation wave](branches/ASTRA_DEPENDENCY_IMPLEMENTATION_2026-09-08.md).
