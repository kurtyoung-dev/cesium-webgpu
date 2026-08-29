# Maintainer rulings — 2026-08-28

**Authority and character.** Two rulings were taken in session on 2026-08-28 at approximately
06:12 ET, at the close of the wave-3 fix campaign against `main` @ `af9c42a052` (Batch 1212),
in answer to the two questions the W3-A prototype lane returned with its stage-1 packet
(recorded in [AUDIT_2026-08-27_SOL_WAVE_AND_PROJECT_SWEEP.md](AUDIT_2026-08-27_SOL_WAVE_AND_PROJECT_SWEEP.md)'s
wave-3 close). They are **operative**, per the convention of the prior rulings files.

**Add-only.** Ruling IDs are never renumbered or reused. Supersessions are stated inside the
superseding ruling's own section and nowhere else.

**Scope note.** This file is the record. The R9 preregistration remains the frozen execution
authority for the prototype repair wave; these rulings direct how it is amended, and nothing
here silently rewrites its frozen text.

---

## R-2026-08-28-1 — The unmasked arity defect is HELD for a full R9 amendment round

**Question.** W3-A's preregistered gate separation (P-8) exposed a pre-existing defect the
source gate had masked for the prototype's entire recorded life: three call sites pass a
zero-arity reader to a two-pass API whose validator requires arity one, so neither pass ever
ran. R9 §1 freezes P0B-21 as permanently red on the explicit premise that "both tests stopped
at the 820-line gate before behavioural adjudication" — a premise the separation has now
falsified by measurement. With the one-line arity correction, P0B-21 passes for the first time
in its recorded history (proven in a derived image with a pristine-tree control; nothing
landed). The fix sits outside R9's sixteen preregistered repair rows.

**Ruling: hold.** The fix does not land until a review-round amendment re-freezes R9 with the
corrected premise. The maximally conservative option was chosen deliberately: the campaign's
value rests on the preregistration discipline, and a frozen "permanently red" scoring row does
not flip to green through the landing seat, however decisive the isolating control. The
amendment round follows the same reviewer pre-commitment pattern the R9 convergence loop used.

**Consequences, stated so nobody re-derives them wrongly later:**

- Stage 2 proceeds around the held fix. `R9A-20`'s 360/360 terminal figure is unreachable
  until the amendment lands; interim stage-2 packets report against the pre-amendment
  expectation and say so.
- The defect's isolation evidence (pristine-spec-against-pristine-helpers control reproducing
  `0 !== 2`, and the derived-image green) is banked with the W3-A stage-1 packet and MUST NOT
  be re-derived from scratch by the amendment round — it is the amendment's exhibit.
- P0B-22 is untouched by this ruling: its red has a separate cause inside the mutation
  machinery and stays governed by R9's frozen text.

## R-2026-08-28-2 — P-1 reads raw bytes by extending SPEC_IMPORTS, with the topology pin moved in the same amendment

**Question.** R9 §4 requires the provenance-core spec to walk all 31 paths reading raw
Buffers, but the spec has no `node:fs` import and its import list is pinned to exactly four
specifiers by both its own source gate and the topology test's exact assertion, while the
file-reading harness is a frozen unchanged anchor. R9 does not say which side gives.

**Ruling: extend the pins, on the record.** `SPEC_IMPORTS` gains `node:fs`, and the topology
assertion is updated to match, both in the same explicit R9 amendment — the two pins move
together or not at all, because a round where one gate admits the import and the other rejects
it certifies nothing. The alternative (routing bytes through the frozen harness) was declined:
the lane did not confirm the harness exposes a raw read, and bending a frozen anchor's usage
to avoid an honest pin change is the wrong trade. The descope option was declined as the
weakest evidence form.

**Sequencing.** Both rulings feed the same amendment round: the round carries the P0B-21
premise correction (R-2026-08-28-1) and the SPEC_IMPORTS/topology extension (this ruling) as
its two exhibits, is reviewed under the pre-commitment pattern, and re-freezes R9 before
stage-2's P-1 arm executes.

---

## Second sitting, ~07:45 ET - the visual wave

Three further rulings were taken the same morning, during visual-wave planning against
`main` @ `1f724e17b6` (Batch 1213), after the backlog sweep (14-agent workflow: 321
candidates, 121 at impact >= 4, 24 premise-verified) and the night-side code investigation
recorded in [QUEUE_2026-08-28_VISUAL_WAVE.md](QUEUE_2026-08-28_VISUAL_WAVE.md). Operative.

## R-2026-08-28-3 - Night-side rendering defaults ON, with a bundled public-domain night pyramid

**Question.** The day/night machinery (per-layer day/night alpha ramp, WebGPU night-lights
emission, procedural darkening) is landed but gated behind `enableLighting = false` and no
night texture ships, so the night side renders as full-bright day imagery by default.

**Ruling: library default ON.** After the Night-Earth epic decouples the night blend from
`enableLighting` and adds the `globe.nightImagery` convenience, the night appearance is the
DEFAULT in this fork - a deliberate, recorded divergence from upstream default behaviour,
ruled by the maintainer with the bundling questions answered in session: the night layer
ships OFFLINE like Natural Earth II does (`Assets/Textures/NaturalEarthII` is 540 KB / 42
tiles, levels 0-2, TileMapServiceImageryProvider over buildModuleUrl), sourced from NASA
Black Marble (Suomi NPP VIIRS composite) which is US-government PUBLIC DOMAIN - legally
clean to bundle in an MIT repository, with a courtesy attribution line (NASA Earth
Observatory / NOAA NGDC) in the asset folder and README. **Size gate:** the bundled pyramid
at levels 0-2 is expected at or under ~0.5 MB (night JPEG compresses better than day); a
deeper level 3 variant (~2 MB) may ship only if the wave re-measures all three build
variants and the maintainer accepts the delta. No implicit network fetch: the default layer
is the bundled pyramid; ion asset 3812 (Black Marble 2017, higher resolution) stays an
opt-in swap for token holders.

**Compatibility bounds, stated now so the epic cannot drift:** the WebGL backend must show
the same default night appearance (both-backends-simultaneously per the parity principle);
`globe.nightImagery = false` (or undefined provider) must restore byte-identical upstream
behaviour; and existing applications that already manage their own imagery layers must not
have a night layer injected into a non-default imagery stack - the default applies to the
default base-layer path only.

## R-2026-08-28-4 - Visual wave composition: the Night-Earth epic arms alone

Of the four lanes offered (Night-Earth epic; C12 close-out sprint; celestial water
reflection C11-163; vegetation V1), the maintainer armed the **Night-Earth epic only** for
this wave. The other three are STAGED in the wave queue with their premises verified and
their gates recorded, not armed. Nothing in this ruling modifies R4 (aurora hold), the C14
launch bar, or any campaign gate.

## R-2026-08-28-5 - Two maintainer sessions scheduled

Both maintainer-only items are scheduled for the next working session: the Milky Way
4096/face re-bake ordered by R-2026-08-10-4 (a manual maintainer session; also C12 exit-gate
item G3, so executing it advances the C12 close-out even though that lane is not armed), and
the four C11-163 celestial-water-reflection sub-decisions (C11 queue section 7.0), taken
together so the water lane is dispatchable the moment it arms.

## R-2026-08-28-6 - The lunar Earth-shadow appearance arms in the visual wave

Taken ~08:45 ET, third sitting of the morning, when the maintainer asked for a demo preset
recreating the 2026-08-28 deep partial lunar eclipse (the previous night's event). The
preset landed in the eclipse-explorer gallery, engine-ephemeris-derived and cross-checked
against NASA SVS 5672 and EclipseWise: greatest 04:12 UTC, umbral magnitude 0.9319,
partial phase 02:33-05:52 UTC, best spot Porto Velho, Rondonia, Brazil (Moon at the zenith,
sub-lunar point 9.4S 63.1W at greatest). Confronted with the disclosed gap that nothing
renders Earth's shadow ON the lunar disc (NEW-LUNAR-ECLIPSE-EARTH-SHADOW-APPEARANCE, OPEN,
premise-verified in the morning sweep) and that EclipseState's scene-light factor is
solar-only by contract, the maintainer ruled: **arm the Earth-shadow appearance in this
wave**, amending R-2026-08-28-4's Night-Earth-only composition. The wave queue gains the
VW-L rows: umbral/penumbral geometry projected on the lunar disc with chromatic umbral
coloring, moonlight dimming through the umbral window (an explicit, recorded amendment to
the EclipseState solar-only contract), goldens pinned to the published 2026-08-28
circumstances, and the new preset as the Edge acceptance scene.

## R-2026-08-28-7 - Quiet hours temporarily lifted for 2026-08-28 (single day)

Taken ~10:20 ET, in the maintainer's own words during the session: the maintainer took the
day off and lifted the weekday quiet-hours window FOR TODAY ONLY - "Go ahead and land
anything that we need to. This is a temporary lifting of the quiet hours. Quiet hours start
again on Monday." Effect: commits and pushes on Friday 2026-08-28 daytime are authorized;
the weekend was already unrestricted; the standing hard rule resumes unchanged on Monday
2026-08-31. The pre-push landing guard has, by its own recorded design, no bypass flag -
pushes under this lift use git's --no-verify, every NON-time rule is verified per commit
via HOOK_EXPLAIN before each such push, and this ruling is the authorization the re-checked
landed range points back to. The guard itself is NOT modified for a one-day exception.

---

## Fourth sitting, ~21:45 ET - post-restart resumption

Three rulings taken after the machine restart, in answer to the questions the visual wave's
acceptance sweep and the lane packets returned. Operative.

## R-2026-08-28-8 - Night values ratified: nightDarkness 0.15 and the level-three pyramid

The acceptance sweep measured 0.15 as the street-altitude darkness that reads as night without
crushing detail (sampled over one bright city; the tranche-3a onset sweep confirms in pixels),
and the deeper bake measured 455.4 KB - inside the half-megabyte gate of R-2026-08-28-3, not
the ~2 MB the queue row assumed. Both ratified: globe.nightDarkness defaults to 0.15 for the
procedural-only mode (the identity-default reasoning of Batch 1231 is superseded for the
DEFAULT only; nightImagery false must still restore byte-identical upstream behaviour, which
the continuous handover of Batch 1239 preserves because a globe with no night layer and
nightDarkness at its default is the fork's chosen default, not upstream's - the byte-identity
bound applies to the explicit opt-out path, restated here so the two are not confused), and
the bundled pyramid ships at levels zero through three (455 KB), halving the texel size and
lowering the full-fade altitude from ~42 km to ~21 km.

## R-2026-08-28-9 - City lights default ON, with WebGL parity

The WebGPU emissive night-lights branch (enableNightLights, WebGPU-only by its ratified
contract) turns ON by default now that night imagery is default-on, and the ratified
WebGPU-only contract is amended: WebGL gains a mirroring emission term so both backends glow.
Queued as wave row VW-N11. The parity principle governs the implementation - one law, two
shaders, the WGSL branch is the reference.

## R-2026-08-28-10 - Three staged lanes arm; vegetation stays staged

Amending R-2026-08-28-4: the C12 close-out sprint arms (the gate to the aurora hold and the
dynamic-ocean launch bar; the G3 re-bake remains a maintainer session per R-2026-08-28-5), the
celestial water reflection lane C11-163 arms CONDITIONALLY on its four sub-decisions being
taken in the sitting that follows, and the R9 amendment round arms under the reviewer
pre-commitment pattern carrying the two exhibits of R-2026-08-28-1 and -2. Vegetation V1
stays staged.

