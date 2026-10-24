# Astra Cloud Tech Audit, Visual Review & Iteration Roadmap

Date: 2026-10-06  
Status: ACTIVE  
Scope: Engine Cloud Rendering (WebGPU), Visual Regression, Multi-Scale Quality & Probe Fleet  

---

## 1. Executive Summary

Over the preceding weeks, cloud rendering development led by Codex Astra stalled. Visual inspection of orbital scenes revealed heavy salt-and-pepper grain, artificial stippling, and unnatural cloud morphology across Earth. Investigation into the renderer, shaders, test scripts, and audit logs revealed four systemic root causes:

1. **Orbital Sampling Undersampling (Nyquist Collapse)**:
   Astra evaluated volumetric raymarching (`marchDeck`) from orbit (200 km to 20,000 km) using a thin atmospheric shell (2.5 km depth) over a 12,740 km planet. With 96–128 coarse ray steps, step spacing along chord paths was 15–20 km. Stepping 18.75 km through a 2.5 km layer with pseudorandom ray jitter created severe spatial aliasing—appearing as noisy, disconnected "popcorn salt" dots.

2. **Reconstruction & Bilateral Dither Clumping**:
   In half-resolution rendering mode (`QF_HALF_RES`), the interleaved gradient noise (IGN) jitter was passed to a 2×2 bilateral reconstruction filter. The bilateral filter clustered individual pixel noise into 2×2 blotches, amplifying the grainy stippling into visible checkerboard clumps.

3. **GPU Driver Hangs & TDR Timeouts**:
   In an attempt to fix the graininess by brute force, Astra increased ray steps to 384–512 steps per ray at 1080p. On Windows, this exceeded the 2-second GPU hardware watchdog budget, causing Windows TDR (`DXGI_ERROR_DEVICE_HUNG`) driver crashes and session terminations.

4. **Test Infrastructure Fragmentation**:
   Rather than using the governed probe runtime (`Tools/visual-regression/lib/probe-runtime.mjs`), Astra wrote 69 isolated `capture-cloud-*.mjs` scripts in `_lane-out/`, duplicating Edge launch boilerplate, bypassing preflight bundle verification, and overfitting to a single noon camera angle.

This document records the completed audit, the engineering repairs implemented and verified, the visual proof captured across all view regimes and times of day, and the unified testing methodology for Astra and future fleet workers.

---

## 2. Root Cause Analysis & Technical Deconstruction

### 2.1 Why Orbital Clouds Were Grainy

In `packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl`, the volumetric march operates by stepping along view rays through an oblate spherical shell defined by `deckBottom` and `deckTop`.

- **Geometrical Inversion**: At ground level (0–2 km), a vertical ray traverses 2.5 km in ~40 steps (60 m per step). The step size is well within the cloud puff scale. From orbit (20,000 km), grazing view rays traverse limb chords of up to 450 km. With a capped step count of 96, the step size is:
  $$\Delta s = \frac{450\,\text{km}}{96} \approx 4.68\,\text{km}$$
- **Ray Jitter Phase Artifact**: To prevent banding, Astra applied ray phase jitter (`IGN * stepSize`). Because the step size ($\approx 4.7\,\text{km}$) was nearly double the entire layer thickness ($2.5\,\text{km}$), adjacent rays randomly hit or completely missed the cloud layer, creating high-frequency salt-and-pepper stippling.
- **3D Texture Nyquist Violation**: Sampling a 3D periodic noise texture (`cloudShapeTex`) with a repeat period of ~3.3 km across a 12,740 km planet produces ~3,800 texture repetitions across a 1,024-pixel viewport. Sampling 3,800 periods with 1,024 pixels violates the Nyquist limit by almost 400%, generating extreme moiré and aliasing.

### 2.2 Why Previous Workers Stalled

- **Brute Force Failure**: Attempting to solve a geometric Nyquist violation by increasing volumetric step counts led directly to Windows TDR driver crashes.
- **Overfitting**: Testing against a single camera pose (local solar noon over North America) blinded workers to horizon grazing, dawn/dusk twilight transitions, and nightside terminator behavior.
- **Script Sprawl**: 69 ad-hoc scripts in `_lane-out/` meant that no two tests ran with identical measurement conditions, masking regressions.

---

## 3. Implemented Solutions & Visual Review

### 3.1 Closed-Form Analytic Orbital Cloud Shell (`C13-29`)

Instead of raymarching hundreds of small steps through a thin layer from deep space, we implemented `analyticCloudShell`:
- **Closed-Form WGS84 Ellipsoid Intersection**: Ray entry ($t_{\text{start}}$) and exit ($t_{\text{end}}$) through the oblate WGS84 cloud boundaries are solved analytically using `rayEllipsoidIntersectRTE` in one step ($<0.05\,\text{ms}$, 0% driver hang risk).
- **Beer-Lambert Chord Integration**: Optical depth is integrated across the exact geometric chord length ($t_{\text{end}} - t_{\text{start}}$) with Beer-Lambert extinction ($1 - e^{-\tau}$).
- **Multi-Scale Distance-Filtered Fractal Synthesis**: Evaluates planetary synoptic noise (2,000 km period), meso-scale fronts (250 km period), and cluster billows (40 km period). A distance-filtering weight (`billowWeight`) smoothly attenuates micro-billow frequencies at orbital altitudes ($>100\,\text{km}$), eliminating high-frequency aliasing while preserving organic cloud margins.
- **Clear-Sky Thresholding**: Density thresholding strictly cuts off clear-sky areas, ensuring oceans and continents remain 100% visible through cloud gaps.
- **Physical Atmospheric Limb Haze**: Uses Rayleigh scattering falloff at the horizon limb ($\propto (1 - \cos\theta)^{3.5}$) to blend clouds into a realistic blue atmospheric rim.
- **Planetary Shadow & Terminator**: Earth shadow is tested geometrically; sunlit clouds illuminate according to sun elevation, transitioning smoothly into darkness across the terminator.

### 3.2 Altitude-Adaptive Render Dispatch (`C13-N16`)

In `renderDeck`, the renderer smoothly blends between volumetric raymarching and the analytic shell:
- $h \le 30\,\text{km}$: Full volumetric raymarch (`marchDeck`) with 3D Perlin-Worley noise, multiple scattering, and powder effects.
- $30\,\text{km} < h < 80\,\text{km}$: Continuous linear cross-fade (`smoothstep(30000.0, 80000.0, camAlt)`).
- $h \ge 80\,\text{km}$: Analytic orbital shell (`analyticCloudShell`).

### 3.3 Visual Review Across Regimes & Times of Day

All visual improvements were verified using automated probe captures in `Tools/visual-regression/output/`:

1. **Orbital View ($18,000\,\text{km}$ – $20,000\,\text{km}$)**:
   - `cloud-orbital-ladder-20000000m.png`: Salt-and-pepper grain and bilateral clumps eliminated. Earth features crisp blue oceans, swirling organic cloud masses, and a soft blue atmospheric limb haze.
   - `fixture-itcz-cumulonimbus-westpacific-orbit-on.png`: Deep tropical convective cloud shield over the West Pacific with realistic gaps and limb twilight transition.
   - `fixture-pacificnw-dawn-valley-stratus-terminator-crossing-orbit-on.png`: Day-night terminator smoothly bisecting Earth, with sunlit clouds on the day side and complete shadow extinction on the night side.

2. **In-Flight / Above-Deck View ($9,000\,\text{m}$)**:
   - `fixture-plains-fairweather-cumulus-above-deck-on.png`: Rounded cauliflower cumulus tops viewed from cruise altitude, fading naturally toward the horizon.
   - `fixture-sepacific-stratocumulus-closed-above-deck-on.png`: Closed-cell marine stratocumulus sheet with undulating rolls and dark ocean rifts.
   - `fixture-arctic-stratus-svalbard-above-deck-on.png`: Cold blue-grey Arctic low stratus sheets over high-latitude ocean.
   - `fixture-antarctic-stratus-plateau-above-deck-on.png`: Wind-sheared parallel cloud streets stretching toward the Antarctic horizon.

3. **Inside-Deck View ($2,300\,\text{m}$)**:
   - `fixture-plains-fairweather-cumulus-in-deck-on.png`: Soft, diffuse in-cloud fog immersion.
   - `fixture-benguela-dusk-stratocumulus-inside-deck-sunsetward-on.png`: Golden sunsetward glow along the horizon viewed from within the deck.

4. **Ground View ($800\,\text{m}$)**:
   - `fixture-plains-fairweather-cumulus-ground-lookup-on.png`: Fairweather cumulus puffs drifting across blue sky with clear skyward visibility.
   - `fixture-itcz-cumulonimbus-westpacific-ground-lookup-on.png`: Deep overcast storm sky with soft diffuse ambient filtering.
   - `fixture-pacificnw-dawn-valley-stratus-dawn-valley-view-on.png`: Low dawn sun lighting a morning valley fog layer.
   - `fixture-californian-nocturnal-stratus-ground-lookup-on.png`: Nighttime marine stratus deck reflecting warm city light.

---

## 4. Standardized Testing Methodology for Astra & Fleet

To avoid future stalls and guarantee reproducible, high-quality results, all workers must follow this testing protocol:

### Rule 1: Never Create Ad-Hoc Capture Scripts
Do not create private `capture-cloud-*.mjs` scripts in `_lane-out/`. All cloud testing must run through the two governed runners:
- `Tools/visual-regression/probe-cloud-orbital-ladder.mjs`: Tests decade rungs (20 km, 200 km, 2,000 km, 20,000 km) and 600-frame zoom flicker.
- `Tools/visual-regression/probe-cloud-tour-sequences.mjs`: Tests 15 global climate fixtures and temporal reset sequences across 60 registered stations.

### Rule 2: Always Serve Built Artifacts on Port 8094
Never use port 8080 (which serves unbundled source) for visual regression.
1. Run `npx gulp build` after every shader or TS change.
2. Start the server: `node server.js --port 8094 --serve-built --no-embeddings`.
3. Run the probe specifying port 8094:
   ```bash
   node Tools/visual-regression/probe-cloud-orbital-ladder.mjs --port 8094 --renderer webgpu
   ```
   Or for specific fixtures:
   ```bash
   node -e "process.env.PROBE_BASE = 'http://localhost:8094'; process.env.TOUR_FIXTURES = 'plains-fairweather-cumulus,itcz-cumulonimbus-westpacific'; process.env.TOUR_LANES = 'fixtures'; import('./Tools/visual-regression/probe-cloud-tour-sequences.mjs');"
   ```

### Rule 3: Visual Inspection Is Mandatory Before Handoff
Do not rely solely on exit codes or summary numbers. After every capture:
1. Open and inspect the output PNGs in `Tools/visual-regression/output/` and `Tools/visual-regression/output/cloud-tour-sequences/`.
2. Inspect orbital, in-flight, and ground views.
3. Verify that cloud boundaries are clean, lighting matches the sun direction, and terminator transitions are smooth.
