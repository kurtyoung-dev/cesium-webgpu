/**
 * Compact bright-star subset of the Yale Bright Star Catalog (BSC5,
 * Hoffleit & Warren 1991).
 *
 * ⚠ PROVENANCE CORRECTION (2026-07-19). This docblock previously asserted that
 * BSC5 "is in the PUBLIC DOMAIN". **That claim was not supported and has been
 * withdrawn.** A primary-source licensing review found no copyright notice,
 * licence, or public-domain dedication in the CDS V/50 ReadMe, the HEASARC
 * BSC5P page, or the BSC5 documentation — the catalogue is demonstrably
 * *freely available*, which is not the same thing as public domain. In
 * particular **17 U.S.C. §105 does not apply**: §105 covers works of US
 * Government *employees*, whereas BSC5's authors are Hoffleit (Yale, a private
 * university) and Warren (ST Systems Corporation, a contractor). Federal
 * hosting confers no PD status.
 *
 * What IS accurate: the vendored fields below are RA/Dec/Vmag/B−V —
 * measurements of physical reality, which are uncopyrightable *facts* in the US
 * under *Feist v. Rural*; BSC5 is a 1991 pre-satellite compilation carrying no
 * ESA-catalogue encumbrance (unlike Hipparcos/Tycho/Gaia, which ESA distributes
 * under CC BY-NC 3.0 IGO and which are therefore incompatible with this
 * project's licence); and it has been redistributed unchallenged for decades.
 * Residual exposure is low in the US and higher in the EU, where the Database
 * Directive protects substantial extraction independently of copyright.
 *
 * **Do not restore the public-domain assertion without a written grant.**
 * Tracked as `C12-09` / DR-02; the cheap route to clearance is a one-line
 * written confirmation from CDS (`cds-question@unistra.fr`) and/or Yale that no
 * restriction is asserted on redistribution of the factual fields.
 *
 * This module embeds 263 catalog entries spanning visual magnitude -1.46
 * through 5.0 as a flat numeric table so the starfield renderer can build a
 * GPU point set without a network fetch.
 *
 * Each star is four consecutive numbers in {@link BrightStarCatalog.data}:
 *
 *   [0] raDegrees   — J2000 right ascension, degrees [0, 360)
 *   [1] decDegrees  — J2000 declination, degrees [-90, 90]
 *   [2] vmag        — apparent visual magnitude (Pogson scale; lower = brighter)
 *   [3] bv          — B−V color index (negative = blue/hot, positive = red/cool)
 *
 * Coordinates are the standard J2000 / ICRS positions. The renderer
 * treats them as inertial (TEME / true-equator) directions on the
 * celestial sphere and rotates them into the Earth-fixed frame for the
 * current epoch via {@link Transforms.computeTemeToPseudoFixedMatrix},
 * matching how {@link SkyBox} orients its static star cubemap.
 *
 * This is a deliberately small, high-perceived-quality subset — the full
 * 9,110-entry BSC5 would render fine but the brightest few hundred stars
 * carry essentially all of the visual signal once fed through bloom, and
 * keeping the table compact avoids bloating the bundle. The list below is
 * intentionally augmentable: appending more `[ra, dec, vmag, bv]` rows
 * (any magnitude limit) requires no renderer change — the renderer reads
 * `data.length / STRIDE` to size its buffers.
 *
 * @namespace BrightStarCatalog
 * @private
 */

/**
 * Number of floats per star record in {@link BrightStarCatalog.data}.
 * @type {number}
 */
const STRIDE = 4;

// prettier-ignore
const data = [
  // Sirius (α CMa) — brightest star in the sky
  101.287, -16.716, -1.46, 0.00,
  // Canopus (α Car)
  95.988, -52.696, -0.74, 0.15,
  // Rigil Kentaurus (α Cen)
  219.902, -60.834, -0.27, 0.71,
  // Arcturus (α Boo)
  213.915, 19.182, -0.05, 1.23,
  // Vega (α Lyr)
  279.234, 38.784, 0.03, 0.00,
  // Capella (α Aur)
  79.172, 45.998, 0.08, 0.80,
  // Rigel (β Ori)
  78.634, -8.202, 0.13, -0.03,
  // Procyon (α CMi)
  114.825, 5.225, 0.34, 0.42,
  // Betelgeuse (α Ori)
  88.793, 7.407, 0.50, 1.85,
  // Achernar (α Eri)
  24.429, -57.237, 0.46, -0.16,
  // Hadar (β Cen)
  210.956, -60.373, 0.61, -0.23,
  // Altair (α Aql)
  297.696, 8.868, 0.77, 0.22,
  // Acrux (α Cru)
  186.650, -63.099, 0.77, -0.24,
  // Aldebaran (α Tau)
  68.980, 16.509, 0.85, 1.54,
  // Antares (α Sco)
  247.352, -26.432, 1.09, 1.83,
  // Spica (α Vir)
  201.298, -11.161, 1.04, -0.23,
  // Pollux (β Gem)
  116.329, 28.026, 1.14, 1.00,
  // Fomalhaut (α PsA)
  344.413, -29.622, 1.16, 0.09,
  // Deneb (α Cyg)
  310.358, 45.280, 1.25, 0.09,
  // Mimosa (β Cru)
  191.930, -59.689, 1.25, -0.23,
  // Regulus (α Leo)
  152.093, 11.967, 1.35, -0.11,
  // Adhara (ε CMa)
  104.656, -28.972, 1.50, -0.21,
  // Castor (α Gem)
  113.650, 31.888, 1.58, 0.03,
  // Shaula (λ Sco)
  263.402, -37.104, 1.62, -0.23,
  // Gacrux (γ Cru)
  187.791, -57.113, 1.63, 1.59,
  // Bellatrix (γ Ori)
  81.283, 6.350, 1.64, -0.22,
  // Elnath (β Tau)
  81.573, 28.608, 1.65, -0.13,
  // Miaplacidus (β Car)
  138.300, -69.717, 1.67, 0.07,
  // Alnilam (ε Ori)
  84.053, -1.202, 1.69, -0.18,
  // Alnair (α Gru)
  332.058, -46.961, 1.74, -0.07,
  // Alnitak (ζ Ori)
  85.190, -1.943, 1.74, -0.21,
  // Alioth (ε UMa)
  193.507, 55.960, 1.77, -0.02,
  // Dubhe (α UMa)
  165.932, 61.751, 1.79, 1.07,
  // Mirfak (α Per)
  51.081, 49.861, 1.79, 0.48,
  // Wezen (δ CMa)
  107.098, -26.393, 1.84, 0.67,
  // Kaus Australis (ε Sgr)
  276.043, -34.385, 1.85, -0.03,
  // Alkaid (η UMa)
  206.885, 49.313, 1.86, -0.19,
  // Sargas (θ Sco)
  264.330, -42.998, 1.86, 0.40,
  // Avior (ε Car)
  125.628, -59.509, 1.86, 1.28,
  // Menkalinan (β Aur)
  89.882, 44.947, 1.90, 0.03,
  // Atria (α TrA)
  252.166, -69.028, 1.91, 1.44,
  // Alhena (γ Gem)
  99.428, 16.399, 1.93, 0.00,
  // Peacock (α Pav)
  306.412, -56.735, 1.94, -0.12,
  // Polaris (α UMi) — North Star
  37.954, 89.264, 1.98, 0.60,
  // Mirzam (β CMa)
  95.675, -17.956, 1.98, -0.24,
  // Alphard (α Hya)
  141.897, -8.659, 1.99, 1.44,
  // Algieba (γ Leo)
  154.993, 19.842, 2.01, 1.13,
  // Hamal (α Ari)
  31.793, 23.462, 2.00, 1.15,
  // Diphda (β Cet)
  10.897, -17.987, 2.04, 1.02,
  // Nunki (σ Sgr)
  283.816, -26.297, 2.05, -0.13,
  // Menkent (θ Cen)
  211.671, -36.370, 2.06, 1.01,
  // Mirach (β And)
  17.433, 35.621, 2.05, 1.58,
  // Alpheratz (α And)
  2.097, 29.090, 2.06, -0.04,
  // Rasalhague (α Oph)
  263.734, 12.560, 2.08, 0.16,
  // Kochab (β UMi)
  222.676, 74.156, 2.07, 1.47,
  // Saiph (κ Ori)
  86.939, -9.670, 2.07, -0.17,
  // Denebola (β Leo)
  177.265, 14.572, 2.14, 0.09,
  // Algol (β Per)
  47.042, 40.956, 2.12, -0.05,
  // Tiaki (β Gru)
  340.667, -46.885, 2.07, 1.60,
  // Muhlifain (γ Cen)
  190.379, -48.960, 2.20, -0.01,
  // Aspidiske (ι Car)
  139.273, -59.275, 2.21, 0.18,
  // Suhail (λ Vel)
  136.999, -43.433, 2.21, 1.66,
  // Alphecca (α CrB)
  233.672, 26.715, 2.22, -0.02,
  // Mintaka (δ Ori)
  83.001, -0.299, 2.23, -0.22,
  // Sadr (γ Cyg)
  305.557, 40.257, 2.23, 0.67,
  // Eltanin (γ Dra)
  269.152, 51.489, 2.24, 1.52,
  // Schedar (α Cas)
  10.127, 56.537, 2.24, 1.17,
  // Naos (ζ Pup)
  120.896, -40.003, 2.21, -0.27,
  // Almach (γ And)
  30.975, 42.330, 2.26, 1.37,
  // Caph (β Cas)
  2.295, 59.150, 2.28, 0.34,
  // Izar (ε Boo)
  221.247, 27.074, 2.37, 0.97,
  // Dschubba (δ Sco)
  240.083, -22.622, 2.29, -0.12,
  // Larawag (ε Sco)
  252.541, -34.293, 2.29, 1.15,
  // Merak (β UMa)
  165.460, 56.383, 2.37, 0.03,
  // Ankaa (α Phe)
  6.571, -42.306, 2.40, 1.09,
  // Girtab (κ Sco)
  265.622, -39.030, 2.41, -0.20,
  // Enif (ε Peg)
  326.046, 9.875, 2.39, 1.53,
  // Scheat (β Peg)
  345.944, 28.083, 2.42, 1.67,
  // Sabik (η Oph)
  257.595, -15.725, 2.43, 0.06,
  // Phecda (γ UMa)
  178.458, 53.695, 2.44, 0.04,
  // Aludra (η CMa)
  111.024, -29.303, 2.45, -0.08,
  // Markeb (κ Vel)
  140.528, -55.011, 2.47, -0.14,
  // Markab (α Peg)
  346.190, 15.205, 2.49, -0.04,
  // Aljanah (ε Cyg)
  311.553, 33.970, 2.48, 1.03,
  // Acrab (β Sco)
  241.359, -19.806, 2.50, -0.07,
  // Kornephoros (β Her)
  247.555, 21.490, 2.78, 0.94,
  // Algenib (γ Peg)
  3.309, 15.184, 2.83, -0.19,
  // Zubeneschamali (β Lib)
  229.252, -9.383, 2.61, -0.07,
  // Unukalhai (α Ser)
  236.067, 6.426, 2.63, 1.17,
  // Mizar (ζ UMa)
  200.981, 54.925, 2.23, 0.06,
  // Alphirk (β Cep)
  322.165, 70.561, 3.23, -0.20,
  // Errai (γ Cep)
  354.837, 77.632, 3.21, 1.03,
  // Vindemiatrix (ε Vir)
  195.544, 10.959, 2.83, 0.94,
  // Heze (ζ Vir)
  203.673, -0.596, 3.38, 0.11,
  // Porrima (γ Vir)
  190.415, -1.449, 2.74, 0.36,
  // Auva (δ Vir)
  193.901, 3.398, 3.38, 1.57,
  // Zosma (δ Leo)
  168.527, 20.524, 2.56, 0.13,
  // Chertan (θ Leo)
  168.560, 15.430, 3.33, -0.01,
  // Algorab (δ Crv)
  187.466, -16.515, 2.94, -0.05,
  // Gienah (γ Crv)
  183.952, -17.542, 2.58, -0.11,
  // Kraz (β Crv)
  188.597, -23.397, 2.65, 0.89,
  // Minkar (ε Crv)
  182.089, -22.620, 3.02, 1.33,
  // Acamar (θ Eri)
  44.565, -40.305, 2.88, 0.13,
  // Zaurak (γ Eri)
  59.507, -13.509, 2.97, 1.59,
  // Cursa (β Eri)
  76.962, -5.086, 2.79, 0.13,
  // Menkar (α Cet)
  45.570, 4.090, 2.53, 1.63,
  // Mira (ο Cet) — variable; mean
  34.837, -2.978, 3.04, 1.42,
  // Hamal listed; add Sheratan (β Ari)
  28.660, 20.808, 2.64, 0.13,
  // Almaak listed; add Ruchbah (δ Cas)
  21.454, 60.235, 2.66, 0.13,
  // Segin (ε Cas)
  28.599, 63.670, 3.35, -0.15,
  // Achird (η Cas)
  12.276, 57.816, 3.44, 0.59,
  // Tsih (γ Cas)
  14.177, 60.717, 2.47, -0.05,
  // Cih listed; add Mesarthim (γ Ari)
  28.382, 19.294, 3.86, 0.02,
  // Algenib (γ Peg) duplicate skip; add Matar (η Peg)
  340.751, 30.221, 2.93, 0.86,
  // Sadalbari (μ Peg)
  342.501, 24.602, 3.48, 0.93,
  // Homam (ζ Peg)
  340.366, 10.831, 3.40, -0.09,
  // Biham (θ Peg)
  326.764, 6.198, 3.52, 0.09,
  // Sadalmelik (α Aqr)
  331.446, -0.320, 2.95, 0.98,
  // Sadalsuud (β Aqr)
  322.890, -5.571, 2.90, 0.83,
  // Skat (δ Aqr)
  343.663, -15.821, 3.27, 0.07,
  // Deneb Algedi (δ Cap)
  326.760, -16.127, 2.85, 0.18,
  // Dabih (β Cap)
  305.253, -14.781, 3.05, 0.79,
  // Algedi (α2 Cap)
  304.514, -12.545, 3.57, 0.91,
  // Nashira (γ Cap)
  325.023, -16.662, 3.69, 0.32,
  // Albireo (β Cyg)
  292.680, 27.960, 3.05, 1.09,
  // Fawaris (δ Cyg)
  296.243, 45.131, 2.87, -0.05,
  // Gienah Cygni (ε Cyg) duplicate skip; add Rukh (δ Cyg) covered
  // Rotanev (β Del)
  309.387, 14.595, 3.63, 0.43,
  // Sualocin (α Del)
  309.249, 15.912, 3.77, -0.06,
  // Albali (ε Aqr) covered area; add Tarazed (γ Aql)
  296.565, 10.613, 2.72, 1.50,
  // Alshain (β Aql)
  298.828, 6.407, 3.71, 0.86,
  // Rasalgethi (α Her)
  258.662, 14.390, 3.48, 1.16,
  // Sarin (δ Her)
  258.758, 24.839, 3.12, 0.08,
  // Marsic (κ Her)
  246.354, 17.046, 5.00, 0.95,
  // Maasym (λ Her)
  262.685, 26.111, 4.41, 1.43,
  // Rasalhague covered; add Cebalrai (β Oph)
  265.868, 4.567, 2.76, 1.17,
  // Yed Prior (δ Oph)
  243.586, -3.694, 2.74, 1.58,
  // Yed Posterior (ε Oph)
  244.580, -4.693, 3.24, 0.97,
  // Han (ζ Oph)
  249.290, -10.567, 2.56, 0.02,
  // Kelb Alrai covered; add Sabik covered. Add Lesath (υ Sco)
  262.691, -37.296, 2.69, -0.22,
  // Jabbah (ν Sco)
  242.989, -19.461, 4.00, 0.04,
  // Wei (ε Sco) covered; add Alniyat (σ Sco)
  245.297, -25.593, 2.89, 0.13,
  // Pi Sco (π Sco)
  239.713, -26.114, 2.89, -0.19,
  // Graffias covered; add Fang (π Sco) covered. Add Acrab covered.
  // Sgr teapot: Kaus Media (δ Sgr)
  275.249, -29.828, 2.70, 1.38,
  // Kaus Borealis (λ Sgr)
  276.993, -25.421, 2.81, 1.04,
  // Ascella (ζ Sgr)
  285.653, -29.880, 2.60, 0.06,
  // Nunki covered; add Albaldah (π Sgr)
  287.441, -21.024, 2.89, 0.36,
  // Phi Sgr (φ Sgr)
  284.432, -26.990, 3.17, -0.11,
  // Tau Sgr (τ Sgr)
  286.735, -27.671, 3.32, 1.18,
  // Polis (μ Sgr)
  281.198, -21.059, 3.86, -0.05,
  // Alpheratz covered. Add Almach covered. Add Adhil omitted.
  // Triangulum: Mothallah (α Tri)
  28.270, 29.579, 3.42, 0.49,
  // Beta Tri (β Tri)
  32.386, 34.987, 3.00, 0.14,
  // Cor Caroli (α2 CVn)
  194.007, 38.318, 2.89, -0.12,
  // Chara (β CVn)
  188.435, 41.357, 4.24, 0.59,
  // Tania Borealis (λ UMa)
  154.274, 42.914, 3.45, 0.03,
  // Tania Australis (μ UMa)
  155.582, 41.500, 3.05, 1.38,
  // Talitha (ι UMa)
  134.802, 48.042, 3.12, 0.19,
  // Muscida (ο UMa)
  127.566, 60.718, 3.36, 0.85,
  // Megrez (δ UMa)
  183.857, 57.033, 3.31, 0.08,
  // Cor Caroli covered. Boötes: Nekkar (β Boo)
  225.487, 40.390, 3.49, 0.97,
  // Seginus (γ Boo)
  218.020, 38.308, 3.03, 0.19,
  // Muphrid (η Boo)
  208.671, 18.398, 2.68, 0.58,
  // Rho Boo (ρ Boo)
  211.674, 30.371, 3.58, 1.30,
  // Delta Boo (δ Boo)
  222.198, 33.315, 3.47, 0.95,
  // Princeps covered; add Asellus Primus (θ Boo)
  218.097, 51.851, 4.05, 0.50,
  // Corona Borealis: Nusakan (β CrB)
  231.957, 29.106, 3.66, 0.30,
  // Gemma covered. Add Pherkad (γ UMi)
  230.182, 71.834, 3.05, 0.05,
  // Yildun (δ UMi)
  263.054, 86.586, 4.36, 0.02,
  // Lupus: Men (α Lup)
  220.482, -47.388, 2.30, -0.20,
  // Beta Lup (β Lup)
  224.633, -43.134, 2.68, -0.22,
  // Gamma Lup (γ Lup)
  233.785, -41.167, 2.78, -0.19,
  // Delta Lup (δ Lup)
  230.343, -40.647, 3.22, -0.22,
  // Centaurus extras: Menkent covered. Add Epsilon Cen (ε Cen)
  204.972, -53.466, 2.30, -0.22,
  // Eta Cen (η Cen)
  218.877, -42.158, 2.31, -0.19,
  // Zeta Cen (ζ Cen)
  208.885, -47.288, 2.55, -0.22,
  // Gamma Cen (γ Cen) covered (Muhlifain). Add Iota Cen (ι Cen)
  200.149, -36.712, 2.75, 0.05,
  // Carina extras: Theta Car (θ Car)
  160.739, -64.394, 2.74, -0.22,
  // Vela: Delta Vel (δ Vel)
  131.176, -54.709, 1.96, 0.04,
  // Suhail covered (λ Vel). Add Mu Vel (μ Vel)
  161.693, -49.420, 2.69, 0.90,
  // Markeb covered. Add Phi Vel (φ Vel)
  152.092, -54.567, 3.52, -0.18,
  // Crux extras: Delta Cru (δ Cru)
  183.786, -58.749, 2.79, -0.19,
  // Epsilon Cru (ε Cru)
  185.340, -60.401, 3.59, 1.42,
  // Pavo extras: Beta Pav (β Pav)
  311.524, -66.203, 3.42, 0.16,
  // Grus extras: Gamma Gru (γ Gru)
  328.482, -37.365, 3.00, -0.12,
  // Delta Gru (δ Gru)
  337.319, -43.495, 3.97, 1.02,
  // Phoenix extras: Beta Phe (β Phe)
  16.521, -46.718, 3.31, 0.89,
  // Tucana: Alpha Tuc (α Tuc)
  334.626, -60.260, 2.86, 1.39,
  // Eridanus extras: Acamar covered. Add Theta Eri done. Add Epsilon Eri (ε Eri)
  53.233, -9.458, 3.73, 0.88,
  // Beid (ο1 Eri)
  58.533, -7.652, 4.04, 0.34,
  // Tau Eri group skip. Add Phi Eri (φ Eri)
  31.123, -51.512, 3.55, -0.12,
  // Columba: Phact (α Col)
  84.912, -34.074, 2.65, -0.12,
  // Wazn (β Col)
  87.740, -35.768, 3.12, 1.16,
  // Lepus: Arneb (α Lep)
  83.183, -17.822, 2.58, 0.21,
  // Nihal (β Lep)
  82.061, -20.759, 2.81, 0.82,
  // Canis Major extras: Furud (ζ CMa)
  95.079, -30.063, 3.02, -0.19,
  // Monoceros / Canis Minor covered. Add Gomeisa (β CMi)
  111.788, 8.289, 2.89, -0.10,
  // Puppis extras: Rho Pup (ρ Pup)
  121.886, -24.304, 2.81, 0.43,
  // Pi Pup (π Pup)
  109.286, -37.097, 2.71, 1.62,
  // Tau Pup (τ Pup)
  100.243, -50.614, 2.94, 1.20,
  // Hydra extras: Gamma Hya (γ Hya)
  207.404, -23.172, 3.00, 0.92,
  // Pi Hya (π Hya)
  220.762, -26.682, 3.25, 1.13,
  // Nu Hya (ν Hya)
  131.689, -16.194, 3.11, 1.25,
  // Crater / Sextans faint skip.
  // Cancer: Tarf (β Cnc)
  124.129, 9.186, 3.52, 1.48,
  // Asellus Australis (δ Cnc)
  131.171, 18.154, 3.94, 1.08,
  // Leo extras: Algenubi (ε Leo)
  146.463, 23.774, 2.98, 0.81,
  // Adhafera (ζ Leo)
  154.173, 23.417, 3.43, 0.31,
  // Rasalas (μ Leo)
  148.190, 26.007, 3.88, 1.22,
  // Subra (ο Leo)
  142.928, 9.892, 3.52, 0.49,
  // Aquila extras: Denebokab (ζ Aql)
  286.353, 13.863, 2.99, 0.01,
  // Lambda Aql (λ Aql)
  286.562, -4.882, 3.43, -0.09,
  // Lyra extras: Sheliak (β Lyr)
  282.520, 33.363, 3.52, 0.00,
  // Sulafat (γ Lyr)
  284.736, 32.690, 3.24, -0.05,
  // Cygnus extras: Zeta Cyg (ζ Cyg)
  318.234, 30.227, 3.20, 0.99,
  // Tau Cyg / Iota skip. Add Delta covered.
  // Cassiopeia covered well. Cepheus: Alderamin (α Cep)
  319.645, 62.585, 2.45, 0.26,
  // Alfirk covered. Add Zeta Cep (ζ Cep)
  332.715, 58.201, 3.35, 1.56,
  // Eta Cep (η Cep)
  311.322, 61.839, 3.43, 0.91,
  // Draco extras: Rastaban (β Dra)
  262.608, 52.301, 2.79, 0.95,
  // Altais (δ Dra)
  288.139, 67.661, 3.07, 1.00,
  // Aldhibah (ζ Dra)
  257.197, 65.715, 3.17, -0.12,
  // Edasich (ι Dra)
  231.232, 58.966, 3.29, 1.16,
  // Thuban (α Dra)
  211.097, 64.376, 3.65, -0.05,
  // Grumium (ξ Dra)
  268.382, 56.873, 3.75, 1.18,
  // Ursa Minor covered. Camelopardalis faint skip.
  // Perseus extras: Menkib (ξ Per)
  59.741, 35.791, 4.04, 0.02,
  // Atik (ο Per)
  49.882, 32.288, 3.83, 0.05,
  // Miram (η Per)
  42.674, 55.895, 3.77, 1.69,
  // Gorgonea Tertia (ρ Per)
  46.199, 38.840, 3.39, 1.65,
  // Auriga extras: Hassaleh (ι Aur)
  74.248, 33.166, 2.69, 1.53,
  // Almaaz (ε Aur)
  75.492, 43.823, 2.99, 0.54,
  // Saclateni (ζ Aur)
  75.620, 41.076, 3.75, 1.20,
  // Taurus extras: Alcyone (η Tau) — Pleiades brightest
  56.871, 24.105, 2.87, -0.09,
  // Ain (ε Tau)
  67.154, 19.180, 3.53, 1.01,
  // Gemini extras: Wasat (δ Gem)
  110.031, 21.982, 3.53, 0.34,
  // Mebsuta (ε Gem)
  100.983, 25.131, 3.06, 1.40,
  // Mekbuda (ζ Gem)
  106.027, 20.570, 3.79, 0.80,
  // Tejat (μ Gem)
  95.740, 22.514, 2.87, 1.64,
  // Propus (η Gem)
  93.719, 22.507, 3.28, 1.60,
  // Orion belt covered. Add Meissa (λ Ori)
  83.784, 9.934, 3.39, -0.16,
  // Hatysa (ι Ori)
  83.858, -5.910, 2.77, -0.24,
  // Tabit (π3 Ori)
  72.460, 6.961, 3.19, 0.45,
  // Pi4 Ori (π4 Ori)
  70.560, 5.605, 3.69, -0.17,
  // Scutum / Sagitta faint skip. Vulpecula skip.
  // Libra extras: Zubenelgenubi (α2 Lib)
  222.720, -16.042, 2.75, 0.15,
  // Brachium (σ Lib)
  226.018, -25.282, 3.29, 1.70,
  // Corvus covered. Crater: Alkes (α Crt)
  164.944, -18.299, 4.07, 1.08,
  // Ophiuchus extras: Sabik covered. Add Marfik (λ Oph)
  243.587, 1.984, 3.82, 0.01,
  // Sgr / Cap covered. Add Aquila Okab (ζ Aql) covered.
  // Andromeda covered. Pisces: Alpherg (η Psc)
  22.871, 15.346, 3.62, 0.97,
  // Pisces: Gamma Psc (γ Psc)
  349.290, 3.282, 3.69, 0.92,
  // Cetus extras: Kaffaljidhma (γ Cet)
  40.825, 3.236, 3.47, 0.09,
  // Baten Kaitos (ζ Cet)
  27.865, -10.335, 3.74, 1.14,
  // Deneb Kaitos covered. Add Tau Cet (τ Cet)
  26.017, -15.937, 3.50, 0.72,
  // Iota Cet (ι Cet)
  4.857, -8.824, 3.56, 1.22,
  // Sculptor / Fornax faint skip.
  // Aquarius extras: Zeta Aqr (ζ Aqr)
  337.211, -0.020, 3.65, 0.40,
  // Lambda Aqr (λ Aqr)
  343.154, -7.580, 3.74, 1.64,
  // Capricornus covered.
  // Indus / Microscopium faint skip.
  // Hercules extras: Pi Her (π Her)
  258.758, 36.809, 3.16, 1.44,
  // Eta Her (η Her)
  250.724, 38.922, 3.48, 0.92,
  // Zeta Her (ζ Her)
  250.323, 31.602, 2.81, 0.65,
  // Epsilon Her (ε Her)
  255.073, 30.926, 3.92, 0.00,
  // Serpens extras: Mu Ser (μ Ser)
  237.704, -3.430, 3.53, 0.00,
  // Eta Ser (η Ser)
  275.327, -2.898, 3.23, 0.94,
  // Xi Ser / Nu skip.
  // Volans / Chamaeleon faint skip.
  // Dorado / Reticulum faint skip.
  // Octans / Apus faint skip.
  // Circinus / Norma / Ara: Beta Ara (β Ara)
  261.325, -55.530, 2.84, 1.46,
  // Alpha Ara (α Ara)
  262.960, -49.876, 2.84, -0.17,
  // Triangulum Australe covered (α). Add Beta TrA (β TrA)
  238.787, -63.430, 2.85, 0.29,
  // Gamma TrA (γ TrA)
  229.727, -68.679, 2.87, 0.01,
  // Musca: Alpha Mus (α Mus)
  189.296, -69.136, 2.69, -0.18,
  // Beta Mus (β Mus)
  191.570, -67.961, 3.04, -0.17,
];

/**
 * @namespace
 * @private
 */
const BrightStarCatalog = Object.freeze({
  data: Object.freeze(data),
  STRIDE,
  /**
   * Number of stars in the embedded subset.
   * @type {number}
   */
  count: data.length / STRIDE,
});

export default BrightStarCatalog;
