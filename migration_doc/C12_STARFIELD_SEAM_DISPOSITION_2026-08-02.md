# C12 starfield seam disposition

**Date:** 2026-08-02  
**Owner:** `C12-11` / DR-01  
**Result:** no new design ruling is required; execute the already-ratified
diffuse-cubemap/resolved-sprite seam.

## Finding

`C12-STARFIELD-SPRITE-VS-CUBEMAP-REDUNDANCY` correctly measured that enabling
the 2,868-sprite catalog over the current default t5 cubemap adds only about
three bright pixels in the Sirius center box and about nine globally. The
renderer is healthy: its pipeline is ready, positions are correct, and raising
intensity changes the census. The contribution is hidden because the currently
shipped t5 cubemap still contains the same resolved stars.

This is not a new architecture question. Campaign 12 DR-01 was decided by the
maintainer on 2026-07-19:

- the cubemap owns diffuse Milky Way light only;
- sprites are the sole source of resolved stars on both backends; and
- the practical implementation is the existing wrapped Gaussian low-pass in
  `Tools/skybox-bake/bake-tycho-t5.mjs`.

The apparent contradiction is a transitional landing sequence:

1. `C12-10` landed the reproducible t5 bake in Batches 742/744, but deliberately
   installed the **unblurred** faces because neither the deeper catalog nor the
   seam switch existed yet. Its README explicitly says the diffuse faces wait
   for `C12-09` and `C12-11`.
2. `C12-09` then landed in Batch 804, expanding 263 records to 2,868 records
   through magnitude 5.5 and advancing `MAG_CUTOFF` with the bake.
3. `C12-11` has not performed the final diffuse-face switch and acceptance
   evidence. The current double source is therefore expected incomplete work,
   not evidence that DR-01 was wrong.

## Options and disposition

| Option | Benefit | Cost/risk | Disposition |
|---|---|---|---|
| HDR/bloom-only sprite overlay over the unblurred cubemap | Smallest asset change | Keeps duplicate resolved stars, leaves painted stars unable to use the shared PSF, B-V color, angular solar washout, or future per-star behavior | Rejected by DR-01; useful only as a diagnostic lane |
| Magnitude seam with diffuse cubemap and sprite-owned resolved stars | One physical owner per signal; resolution-independent stars; both backends share the same catalog/math; supports dynamic extinction/PSF/glare | Requires regenerating and installing the diffuse faces and certifying moving-camera aliasing/cost | **Ratified target** |
| Remove the sprite renderer and keep resolved stars in the bake | Lowest draw count | Deletes shipped functionality and dynamic behavior, bakes point sources to texels, and violates the no-feature-removal rule | Rejected |

## Next executable work: C12-11

1. Re-run the existing t5 bake from its hash-pinned 16K source and preserve both
   outputs. The source TIFF and diffuse artifacts are not present in this
   worktree, so the switch cannot be honestly fabricated from the six JPEG
   cube faces; per-face blur would introduce cube-edge seams.
2. Install the 2048 diffuse faces under a distinct, explicit descriptor first;
   do not overwrite the reversal artifact before side-by-side evidence exists.
3. Run the M6 source split on both backends:
   - cubemap-only must retain diffuse Milky Way structure but no resolved point
     census;
   - sprites-only must carry the resolved-star census; and
   - combined must not duplicate the bright-star band.
4. Capture G3 dust-lane/source-density metrics for unblurred versus diffuse and
   preserve the reversal evidence required by DR-01.
5. Run a moving-camera track, not an idle soak, to measure aliasing/twinkle and
   the 2,868-sprite frame cost on WebGL and WebGPU. Do not deepen to the parked
   5,058-star/magnitude-6.0 variant until this lane is measured.
6. Keep `probe-stars-catalog` check A red until the diffuse-face lane lands; it
   is a valid incomplete-seam signal, not a renderer failure.

## Guardrails

- Do not remove or default-disable the catalog to make the red check disappear.
- Do not compensate duplicate energy with a magic sprite intensity while the
  ratified single-owner seam remains executable.
- Keep WebGL and WebGPU PSF, color, extinction, and visibility behavior in
  lockstep.
- If commercial redistribution becomes in scope, reopen the asset terms under
  Campaign 12 section 6f before shipping new derived faces.
