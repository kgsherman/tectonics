# Worldgen — Architecture & Implementation Spec (rev 2, post design review)

A browser-based procedural planet generator:

1. **Plate tectonics** simulation you can play and watch evolve (mountains, rifts, ridges, trenches, island arcs, hotspots).
2. A **plate editor** to draw your own plates, paint continents and set plate motion, then simulate them.
3. A **climate model**: insolation → coupled seasonal energy balance → pressure & winds → wind‑driven **ocean currents**, upwelling & SST → moisture transport & **precipitation** → **Köppen** classification (monthly, 12 months), plus clouds for "weather".
4. A **satellite view**: terrain painted from the Köppen climate (continuous vegetation/soil attributes, seasonal snow, sea ice, rivers, relief, clouds) on a 3D globe or 2D map.

Stack: **TypeScript 7 + Vite 8 + Three.js 0.186**, simulation in **Web Workers**. All simulation and painting code is **DOM‑free pure TS**, so it also runs in Node (`tsx`) for tests and the headless PNG renderer.

Already implemented and tested (do not rewrite; extend only if you own it): `src/core/*` (mesh, grid, rng, noise, math), `src/tectonics/draft.ts` helpers, `src/climate/koppen.ts`, `tests/helpers/fixtures.ts`.

---

## 1. Repository layout & ownership

| Path | Owner | Notes |
|---|---|---|
| `src/core/**`, `src/climate/internal.ts`, `tests/helpers/**`, `vite.config.ts`, `package.json`, `tsconfig.json` | **contract** (lead) | Frozen. Ask in your report if you need a change. |
| `src/climate/koppen.ts` | contract (done) | classifier + class table |
| `src/tectonics/sim.ts` + private `src/tectonics/sim*.ts` | **tectonics-sim** | `TectonicSim` |
| `src/tectonics/generate.ts`, `src/tectonics/draft.ts`, private `src/tectonics/gen*.ts` | **tectonics-generate** | random worlds; draft helpers (keep existing tested functions intact; implement `finalizeDraft`, `resampleDraft`) |
| `src/climate/climate.ts` + private `src/climate/{dyn,energy,circulation,ocean,insolation,numerics,tuning}*.ts` | **climate-dynamics** | orchestrator `computeClimate`, `climateInputFromSnapshot`, `DynamicsResult` |
| `src/climate/hydrology.ts`, `src/climate/sample.ts` + private `src/climate/{hydro,moisture}*.ts` | **climate-hydrology** | `computeHydrology`, `sampleClimateAt` |
| `src/climate/earthInput.ts`, `scripts/**` | **headless** | Earth validation input, headless renderer, calibration harness |
| `src/render/paint.ts` + private `src/render/{paint,colormaps,terrain,satellite,rivers,layers,overlay,legend}*.ts` | **painter** | pure RGBA painting |
| `src/render/{globeView,mapView}.ts` + private `src/render/{view,globe,map,particles,clouds,shaders}*.ts` | **views** | Three.js globe & 2D map |
| `src/editor/**` | **editor** | plate drawing tool (`editorCore.ts` pure + DOM UI) |
| `src/main.ts`, `src/app/**`, `src/worker/**`, `src/styles.css`, `index.html` | **app** | shell, UI, workers, protocol |
| `tests/<module>*.test.ts`, `tests/perf/<module>*.test.ts` | each module | Vitest |

Rules:
* **Only create/edit files you own.** Need something else? Implement it privately in your module or note it in your final report. Never edit `src/core/**`, `src/climate/internal.ts`, `tests/helpers/**` or another module's files.
* Keep every exported contract signature exactly (you may add optional parameters and extra exports).
* No new npm dependencies. Installed: `three`, `delaunator`, `vite`, `vitest`, `tsx`, `pngjs`, `world-atlas`, `topojson-client`, `@types/*`. Three addons: `three/examples/jsm/...`.
* TypeScript strict + `verbatimModuleSyntax` (use `import type`), no `const enum`.
* `src/core`, `src/tectonics`, `src/climate`, `src/render/paint.ts` and its helpers must not touch DOM APIs (use `globalThis.performance?.now?.() ?? Date.now()` for timing).
* Hot loops: typed arrays, no per-element allocation/closures.
* Determinism: all randomness from `Rng` / `createNoise3` seeded; same inputs ⇒ same outputs.
* Tests run in parallel across agents: run **only your own** tests (`npx vitest run tests/<yours>`) and filter typecheck output to your paths (`npx tsc --noEmit -p . 2>&1 | grep -E "src/<yourdir>|tests/<yours>"`). Other modules may be mid-edit. Perf assertions go in `tests/perf/` (run with `npm run perf`, 1.5–2× slack).
* No jsdom is installed: keep DOM-heavy code thin and put logic in pure, tested modules (`viewUtil.ts`, `editorCore.ts`, app state reducers).

---

## 2. Conventions

* Unit sphere, z = north. `x = cos(lat)cos(lon)`, `y = cos(lat)sin(lon)`, `z = sin(lat)`. Radians internally.
* Grids: row‑major, **row 0 = north**, col 0 = lon −180°. `lat(r) = π/2 − (r+0.5)π/h`, `lon(c) = −π + (c+0.5)2π/w`. Longitude wraps. Consumers use `result.w/h`, never hard-coded sizes.
* Earth radius 6371 km. Time **Myr**. Plate speed km/Myr (50 km/Myr = 5 cm/yr). ω in rad/Myr, v = ω × p · R.
* Elevation m, datum sea level 0. **One sea level lives in app state**; `ClimateParams.seaLevel` and `PaintOptions.seaLevel` must equal it (changing it re-runs a fast climate).
* `MAX_PLATES = 32` (bitmask slots; use `(mask >>> k) & 1`). `LAPSE_RATE = 0.0065 °C/m`.
* Three.js mapping (views only): Three `(X, Y, Z) = (x, z, −y)` (Y up). Equirect textures on `SphereGeometry`: row 0 = north means **`texture.flipY = true`** for DataTextures (or flip v in the shader); satellite/base textures use `SRGBColorSpace`. Test: a marker at the north pole and lon +90° must appear there.

### 2.1 Identity, caching and transfers
* `WorldSnapshot.id` (sim: `simInstanceId * 2**20 + stepIndex`; draft snapshots: negative counter) and `ClimateResult.id` (+ `sourceSnapshotId`) are the cache keys. **Never key caches on object identity.**
* `sim.snapshot()` is memoized per step: returns the same object until the state changes. Anything a producer keeps (latest snapshot, keyframes, cached climate, drafts it will reuse) leaves a thread by **structured clone**, never transfer. Only freshly painted buffers (`PaintResult.rgba/heightMap`, overlays) are transferred. `PaintCache` never retains returned buffers. Editors call `onApply(cloneDraft(d))`.

---

## 3. Core (`src/core`) — DONE

`createSphereMesh(n)` (Fibonacci lattice + spherical Delaunay + CSR adjacency, 100k in ~100 ms), `nearestCell(x,y,z,hint?)` (exact, ~0.15 µs; ~0.05 µs with a good hint), `cellsWithinRadius`, `neighborsOf`, `vertexTriangles`; grid: `buildMeshGridMap` (2048×1024 in ~180 ms), `meshToGrid`, `meshToGridNearest`, `sampleGrid`, `gridToMesh`, `resampleGrid` (box-averages when downsampling ≥2×), `gridIndexAt`, `gridLat/Lon`, `latToRow/lonToCol`; `Rng` (sfc32, `fork(salt)`), `createNoise3/fbm3/ridged3`; math3 (quats, `omegaFromDirection`, `tangentBasis`, …).

Land-aware supersampling recipe: `buildMeshGridMap(mesh, k·w, k·h)` → `meshToGrid` → classify sub-samples → `resampleGrid` to w×h (box average) for land fraction and means.

---

## 4. Tectonics simulation (`src/tectonics/sim.ts`) — tectonics-sim

> The review lead prototyped §4.2 on real meshes (scratch scripts `exp3`–`exp10` in `C:/Users/sherm/AppData/Local/Temp/claude/C--kevin-js-worldgen-c/fdf8bba4-4bf1-4bb7-882e-28505c29a375/scratchpad/` — read them). The rules below include fixes validated there.

### 4.1 Representation — plate frames on a shared lattice
The mesh lattice is also every plate's reference lattice. Plate slot k (0..31; slots reused after a plate dies, with all its mask bits cleared) stores dense arrays of length n in **its own frame**: `owned:Uint8`, `crust:Uint8`, `elev:F32`, `age:F32`, `orogeny:F32`, `hint:Int32` (world cell that lattice cell j pushed to last substep). Plus quaternion `q_k` (plate → world, **accumulated forever, never reset**), `ω_k`, spec (id/name/color/frame). World position of plate cell j = `R(q_k)·s_j`. Crust is **never resampled**; only discrete edits (add/remove/modify cells). Allocate lazily, free on death. Report `PlateInfo.rotation = q_k ⊗ (spec.frame ?? identity)`; `toDraft()` writes it into `PlateSpec.frame`.

Construction from a `WorldDraft`: q = identity, plate k owns exactly its draft cells (orogeny from draft if present). Effective plate cap = `min(MAX_PLATES, max(params.maxPlates, draft.plates.length))`.

### 4.2 One step (dt Myr)
**Substeps**: `ns = clamp(ceil(max_k |ω_k|·R·dt·speedScale / (0.8·spacing·R)), 1, 8)` (warn if capped). Steps A–D run per substep; E–J once per step with the full dt.

**A. Move**: `q_k ← quat(ω̂_k, |ω_k|·dt_sub·speedScale) ⊗ q_k`, normalize.

**B. World pass (pull, per world cell i)**:
* Candidates: `prevTop(i)`, plus plates with bits in `presence_prev[i]` or `presence_prev[nbr]` for neighbors of i (presence is written in the plate pass). Fallback: all plates only if the cell had no previous top and no presence.
* For candidate k: `j = nearestCell(M_kᵀ s_i, hint)` (hint from `worldSrc_prev` of a neighbor with the same top, or from the plate's cached push data). k covers i iff `owned_k[j]`.
* 0 covering → gap (step D). 1 → top. ≥2 → overlap: **top** = continental beats oceanic *per cell*; otherwise (ocean–ocean, continent–continent) the plate with the higher **polarity rank** (per plate, §4.2 F) wins. Others become **losers**: `loser_cur[i] |= 1<<k`.
* Write `worldPlate`, `worldSrc[i] = j_top`, and (for display) copy props.
* All bitmask arrays (`loser`, `presence`) are **double-buffered** (prev/cur) and cleared every substep.

**C. Plate pass (push, per plate k, per owned lattice cell j)**: `i = nearestCell(M_k s_j, hint_k[j])`; store `hint_k[j] = i`; `presence_cur[i] |= 1<<k`.
* `worldPlate[i] == k` → at the surface (receives surface fields in E–H).
* Else if loser bit k at i **and `v_conv(i) > 3 km/Myr`** → consumed:
  * oceanic → **subduction**: remove (`owned=0`); record a sink volume at i (for collision/arc budgets) and count it.
  * continental (under continental or oceanic top) → **collision**: remove and add its crust "volume" `(max(0, elev+500)+...)·cellArea` to the collision budget at i; count shortening for the plate pair.
* Else if no cell within 1 ring of i has top == k and no loser bit → **buried orphan**: treat as loser under `worldPlate[i]` (same rule incl. the v_conv gate; if not converging leave it).
* Else: hidden edge alias — leave it.
* **v_conv(i)** = `max(0, −(v_loser − v_top)·n̂)` with n̂ the boundary normal estimated over **2 rings**: `n = Σ_a w_a (s_a − s_i)`, w = +1 for ring cells whose top/loser is the loser plate, −1 for top-plate cells; project to the tangent plane; if `|n| < 0.5·spacing` the normal is undefined → v_conv = 0 (no removal). This gate eliminates false subduction along transforms (prototype: 12% of the sphere falsely consumed in 100 Myr without it; 0 with it).

**D. Gaps (world cells with no covering plate)**: g = previous top of i (it just moved away), else most common top among neighbors. `j = nearestCell(M_gᵀ s_i)`.
* If `owned_g[j]` already → just mark top = g (no new crust).
* Classify via plate‑pair kinematics: distinct tops within 2 rings; for each pair the divergence `(v_a − v_b)·n̂` with the 2‑ring normal. If max divergence > 5 km/Myr → **new ridge crust** in g: oceanic, age 0, `elev = oceanDepthForAge(0)`.
* Otherwise (transform/aliasing noise, slow stretching) → **clone** crust/age/elev/orogeny from g's own nearest owned lattice neighbour of j (never from another plate); subtract 100–300 m if continental (rift basin).

**E. Fronts & interaction fields** (once per step, from persistent geometry, not removal events): a **subduction front** is a top cell i with a 1‑ring neighbour whose top or loser bit is a plate K below top by polarity with oceanic crust at the contact and `v_conv > 3`; a **collision front** likewise with continental crust on both sides. Sources carry v_conv (union/max over the step's substeps). Multi‑source Dijkstra on the world graph (edge = angle × R), restricted to the overriding plate's cells:
* **Subduction uplift**: rate `U_s·v_conv·f_s(d)`, f_s peaks at ~150–300 km (arc/cordillera), → 0 by ~1000 km. Oceanic overriding → island arc; arc cells rising above −500 m convert to continental (count as created). Current calibration (`simConstants.ts`, polish 2): U_s = 2.1 m/Myr per km/Myr on continental margins (cordillera kernel peak 230 km, rise 120 km, fall 240 km), arc rate kept at 3.5 m/Myr per km/Myr; a 50 km/Myr Andean margin builds a ~3.6 km crest in 40 Myr and ~4.8 km in 60 Myr.
* **Collision**: spread the accumulated collision volume budget over kernel `f_c(d)` (peak at the front, broad plateau to ~1000–1200 km), normalized so it integrates to the budget (≈ volume conserving). Soft cap: effective rate × `(1 − h/9000)`.
* **Trenches**: a *transient display offset* recomputed each step for subducting-side cells within ~150 km of a front (to ≈ −7500 m at the front, scaled by `min(1, v_conv/20)`), added to snapshot elevation only — never written into crust.
* **Hotspots** (world frame): saturating growth `elev += H·s·g(d)·dt·max(0, h_target − elev)/h_scale` with h_target ≈ +1500 m oceanic (3–4 km strong), ≈ +1000 m swell on continents.
* All uplift/field deltas are **intensive world fields gathered per plate cell via the push map**: for owned j of plate k with `i = hint_k[j]` and `worldPlate[i] == k`: `elev_k[j] += U[i]·dt; orogeny_k[j] += U[i]·dt`. (Scattering through worldSrc skips/doubles ~9% of cells after long rotation.)

**F. Polarity rank** (per plate, once per step): area‑weighted mean age of its oceanic crust near its boundaries (continental-dominated plates rank above oceanic), with hysteresis (flip an ordering only if the difference exceeds 15 Myr for ≥10 Myr). Total order ⇒ no cycles at triple junctions, no per-cell polarity zippers.

**G. Surface processes** (per owned plate cell):
* Oceanic: `age += dt`; subsidence `elev += oceanDepthForAge(age+dt) − oceanDepthForAge(age)` (features subside too); floor −11000.
* Continental: `age += dt`; erosion toward an **isostatic freeboard** `h_base ≈ +300…+500 m` (rising slightly with age for cratons): `h ← h_base + (h − h_base)·exp(−dt/τ)`, τ ≈ 150–300 Myr (currently 160 Myr), faster τ (≈ 40–80 Myr; currently 80 Myr) for the orogenic excess above h_base + 1 km. Submerged continental crust drifts slowly toward −200 m (shelves).
* **Hillslope diffusion in world space**: Laplacian of world elevation on the world graph (crossing plate boundaries), gathered back via the push map; κ tuned so belts broaden but survive ~100 Myr (currently κ = 40 km²/Myr: an inactive ~4.8 km cordillera keeps ground above 2 km for ~90 Myr and is down to ~1 km hills after ~200 Myr).
* `orogeny *= exp(−dt/50)`.

**H. Plate dynamics**:
* Collision resistance per plate pair grows with accumulated shortening: relax both plates toward the area-weighted mean `ω̄ = (A_a ω_a + A_b ω_b)/(A_a + A_b)` with unconditionally stable factors `ω_x ← ω̄ + (ω_x − ω̄)·exp(−κ·contacts·dt/A_x)`, so convergence stops within ~500–1500 km of shortening; then, if `mergePlates` and relative speed < ~5 km/Myr for ≥ ~10 Myr, **merge** smaller into larger by footprint (push the smaller plate's visible cells + 1‑ring into the larger frame, pull-fill those with hints; at doubly-owned cells keep whichever is currently top).
* Clamp only the maximum surface speed `|ω|·R ≤ 150 km/Myr`; guard all divisions. Optional slow slab-pull refit every ~10 Myr toward subducting fronts (20–50 Myr relaxation) so poles reorganize.

**I. Rifting** (Poisson, `riftRate` per 100 Myr, only below the cap): pick a plate weighted by area × (1 + continentalFraction); two far-apart seeds within it; split owned cells by noise-warped nearest seed (in its own frame); child copies q & spec.frame and masked arrays; `ω_{1,2} = ω ∓ Δω/2` carrying the halves apart at 20–60 km/Myr. New ids from `nextPlateId`.

**J. Housekeeping**: plates with 0 owned cells die (slot freed, bits cleared). Tiny plates (< ~20 visible cells): convert their visible cells to gaps (refilled by D) or merge into the neighbour with the longest non-convergent shared boundary. time += dt; stepIndex++.

**Randomness**: per-step `new Rng(seed).fork(stepIndex)` (counter-based) so `step(k)` ≡ k × `step(1)` and resumes are reproducible.

### 4.3 Outputs
* `snapshot()` (memoized per step): `plate`/`crust` nearest (categorical); **`elev`/`age`/`orogeny` interpolated barycentrically inside the top plate's lattice at `M_kᵀ s_i`** (containing triangle searched in the vertex fan of `worldSrc[i]` — the exact nearest lattice vertex from the world pass — with the exact walk from j_top as fallback; renormalize over owned vertices; display only — removes lattice-snap jitter) plus transient trench offsets; `boundary` classified; `plates: PlateInfo[]` compacted (index = value in `plate[]`) with `rotation`; `id`.
* `toDraft()`: world state + `orogeny`, `nextPlateId`, `stepIndex`, plate `frame`s. `stats()` incl. continental created/destroyed.

### 4.4 Acceptance (tests; perf in tests/perf)
* Construction: snapshot.plate equals the draft's plates exactly.
* Invariants every step: every world cell has a top; no NaN; plates ≤ cap; ids unique.
* **Transform** (`twoPlateDraft(mesh,'transform')`, 100 Myr): < 0.5% of cells lost; no young (<20 Myr) crust band along the equator beyond 2% of equatorial cells.
* **Cap** (`'cap'`): trailing edge grows ridge crust (age < 5 Myr cells exist there); leading edge: rest plate (oceanic) subducts under a continental cap (cap owned count stable ±5%, rest loses cells) and elevation near the front rises (cordillera).
* Continent on a rotating plate keeps its area within ±3% over 100 Myr with no oceanic speckles (oceanic cells whose neighbours are all continental < 0.1% of continental cells).
* From `generateRandomDraft` (12 plates), 300 Myr: continental fraction within ±40% of initial; land fraction 15–50%; max elevation 3–9 km concentrated near convergent boundaries.
* Resume: `new TectonicSim(mesh, sim.toDraft())` continues without jumps; `step(10)` equals 10 × `step(1)`.
* Perf (n = 100k, 12–20 plates, dt 1): steps A–D ≤ 25 ms per substep, full step ≤ 60 ms (Node).

---

## 5. Random world generation (`generate.ts`, `draft.ts`) — tectonics-generate

* Plates: `plateCount` (clamped to [3, MAX_PLATES − 2]) well-separated seeds; weights for a realistic size distribution; **plates grown by a noise-weighted multi-source flood fill in which crossing continental crust costs ~4×** so boundaries prefer ocean; connectivity enforced (`enforceConnectivity`). Plates sharing a continent get correlated ω (relative speed < 10 km/Myr) — avoid t = 0 collision shocks through continents.
* Continents: mask covering ≈ `continentalFraction`. `'scattered'` 3–7 continents (warped fbm + low-frequency blobs), `'supercontinent'` one large mass + fragments, `'archipelago'` many small masses. Elevation: base +300…+500 m with noise, older/higher cratonic cores, shelves to −200 m at edges, a few old eroded ranges; ~70–80% of continental crust above sea level.
* Oceanic crust: age from distance to the divergent boundaries of the chosen motions (0–180 Myr), elevation `oceanDepthForAge`.
* Motions: continental plates 15–40 km/Myr, oceanic 40–100 km/Myr, × `plateSpeed/50`; Euler poles mostly 60–90° from the plate centroid; small spin.
* Hotspots: `hotspotCount`, strength 0.5–1.5, radius 1.5–3°.
* `nextPlateId`, `stepIndex = 0`, `revision = 0` set; frames undefined.
* **`finalizeDraft(mesh, draft, seed, keepElevation?)`** (editor "Simulate this world" + app): compact; split disconnected plate components into separate plates (fragments < ~20 cells merge into a neighbour); zero-motion plates get a random 30–60 km/Myr motion; oceanic age from distance to divergent boundaries of the current motions and depth from `oceanDepthForAge` except `keepElevation` cells; continental shelves/coastal slopes. **`resampleDraft(from, to, draft)`**.
* Budget: `generateRandomDraft` ≤ 600 ms at n = 100k.

---

## 6. Climate (`src/climate`) — climate-dynamics + climate-hydrology

Output grid `gridW×gridH` (default 360×180). **Dynamic core runs on a 2° grid (180×90)** (3°, 120×60, in `fast` mode); 1° diagnostics (land mask, lapse downscaling, moisture/orographic precipitation) where needed. 12 months. All outputs finite everywhere (§ClimateResult docs). Keep all tunable constants in one `src/climate/tuning.ts` (dynamics) / `hydroTuning.ts` (hydrology).

### 6.1 Dynamics (climate-dynamics) → `DynamicsResult` (`src/climate/internal.ts`)
1. **Input**: `climateInputFromSnapshot` with land-aware supersampling (§3 recipe). Lapse uses `max(0, elev − seaLevel)`.
2. **Insolation**: daily-mean TOA insolation evaluated at each time step's orbital longitude (smooth in time), declination from `axialTilt`, `solarMultiplier`. Robust for tilt 0–90°.
3. **Coupled seasonal energy balance** (one integrator; ~5‑day steps; land, ocean mixed layer, sea-ice surface):
   * Budyko–Sellers: `C dT/dt = Q(1−α) − (A + B·T) + ∇·(D∇T) + ocean heat convergence`; start from North et al. (1981): A = 203.3 W/m², B = 2.09 W m⁻²K⁻¹ (T in °C), **planetary** albedo ≈ 0.30 + 0.08·P₂(sinφ) snow-free, ≈ 0.62 ice/snow, snow/ice albedo from the *previous* step with a ≥ 10 K ramp.
   * Heat capacities: land ≈ atmosphere column (~1e7 J m⁻²K⁻¹), ocean mixed layer 30–50 m (calibrate lag 6–8 weeks, maritime range 10–15 °C).
   * **Numerics (mandatory)**: finite-volume flux form on the lat-lon grid (meridional face flux ∝ cosφ_face, pole faces zero flux; zonal term D/cos²φ); operator split, **backward Euler throughout**: local implicit radiative step, then implicit periodic tridiagonal per row (Thomas + Sherman–Morrison), then implicit tridiagonal per column. No explicit diffusion; no Crank–Nicolson/Peaceman–Rachford. State D in unit-sphere W m⁻²K⁻¹ and convert explicitly.
   * Spin-up: implicit annual-mean steady solve → analytic periodic local solution init → 2–3 model years with Aitken extrapolation of the annual drift. Monthly outputs = averages over steps in the month.
   * Sea ice: SST ≥ −1.8 °C; excess heat loss grows ice fraction (Semtner‑0 style or fraction model); separate ice-surface temperature with small C; air T = (1−ice)·T_ocean-coupled + ice·T_ice; albedo blends.
   * Two outer passes: pass 1 without currents → pressure/winds/ψ; pass 2 with currents & upwelling.
   * **Land ice** (`energyIce.ts`, once per model year): glacier margins from the annual mass balance in budget form (each connected sheet's accumulation surplus vs ablation deficit; advance onto best-placed bare land, retreat of the most strongly ablating cells; nucleation where snow survives the year). A grown sheet raises its surface (Nye profile, isostasy) and is decoupled from the surrounding air like a high polar plateau; a melting glacier keeps wet-snow albedo while its seasonal snow lasts. Cold start: land ice where the first-guess climate is cold enough, starting with ice albedo; the core of a cold-start sheet (> `glacierCoreKm` ≈ 400 km inside its initial margin) is kept, so large polar continents stay glaciated although pass 1 (no advection) is biased warm. Glacier state is derived the same way from scratch in fast and full mode.
4. **Pressure** (hPa): zonal belts following a per-longitude thermal equator (temperature-max latitude, smoothed over ~30° of longitude, clamped to ±min(tilt, 25°)); belt positions/amplitudes scaled by the zonal-mean meridional T gradient (robust to tilt 0–90). Thermal term `ΔP = −k·(T_slr − T_ref(lat))`, k ≈ 0.6–0.8 hPa/K, T_slr = sea-level-reduced T (T + Γ·height), T_ref = zonal ocean mean with fallbacks (all-cell mean, then interpolation from rows with ocean). Smooth with running-sum box blurs (3 passes; zonal half-width = L/(R cosφ Δλ), capped at the full row).
   * **Land monsoon trough** (`pressureTuning.landTrough*`): the belts follow the *oceans'* thermal equator (land cells enter the search with their row's ocean reference T); over continents the equatorial trough moves toward the lagged solar declination (≈ 20–23° in peak summer: Sahara, Arabia/Pakistan, Australia, Chaco heat lows) and widens (12°), weighted by the smoothed **lowland** land fraction (terrain < 1.5 km), so coasts in front of high ranges (Peru/Chile) and plateaus do not carry it. Land heats with the sun at little lag; the ocean lags and its thermal equator stays near 5–10°.
   * **Shallow vs deep pressure.** Heat lows (land warmer than the ocean reference, below ~3 km: elevated heat sources such as Tibet or the Altiplano convect deeply) and the land trough beyond its rain belt are shallow circulations (a 1–3 km inflow layer under divergent, subsiding air). The full pressure drives the winds and the moisture-carrying steering flow (monsoon inflow, the flow from the Amazon into the Chaco low); the `ascent` field comes from a *deep* pressure without them, whose land trough lies `landRainShare` (0.15) of the way from the ocean ITCZ toward the heat low, where the inflowing moist layer is deep enough for convection (monsoon rain belts equatorward of the dry heat lows). Rain in heat lows comes only from the moisture they converge (humidity gate), which keeps desert heat lows dry while monsoon margins downstream of moist air get their summer rain.
5. **Winds**: single Rayleigh-friction balance valid at all latitudes: `u = −(r∇p + f k×∇p) / (ρ(r² + f²))`, signed `f = 2Ω sinφ·(retrograde ? −1 : 1)`, r_ocean ≈ 3.7e‑5 s⁻¹, r_land ≈ 7e‑5 s⁻¹ smoothed across coasts (~300 km). Polar filter poleward of ~60° (zonal smoothing widening as 1/cosφ); cap |u| ≤ 30 m/s. Targets: trades 5–8 m/s, monthly-mean westerlies 5–8 m/s (deepen ocean subpolar lows to ~−15 hPa if needed). Steering wind for moisture: rotate halfway back toward geostrophic, ×1.2. `ascent` from compact FV −∇²p (smoothed), `baroclinic` = smoothed |∂T/∂y| × max(0, westerly).
6. **Ocean currents** (Stommel only): `(r/R²)[(1/cosφ)∂φ(cosφ∂φψ) + (1/cos²φ)∂λλψ] + (2Ω_signed/R²)∂λψ = curl τ/(ρ₀H)`, curl in flux form `[∂λτ_v − ∂φ(τ_u cosφ)]/(R cosφ)` smoothed 1–2 passes; τ with gustiness `ρ_a C_d sqrt(|u|²+σ²) u`. δ_S = r/β_eq ≈ 250–300 km physically. **Islands**: label land components on the solver grid; the largest (merged with the |φ| = 75° walls) is ψ = 0; every other component gets one unknown ψ_k updated from the circulation condition `r∮u·dl = (1/ρH)∮τ·dl`; islands < ~6 cells are treated as ocean in the solve. Periodic longitude. **Zonal line relaxation** (tridiagonal per row, β term implicit, red-black rows), coefficients precomputed per land mask; cold-solve the annual mean, warm-start months (≤ 30 sweeps, stop at max|Δu| < 1 mm/s). Velocity from ψ with a fixed effective depth calibrated once on Earth, clamped ≤ 2.5 m/s (no per-world normalization; `oceanCurrents` scales heat transport). Add Ekman drift from the regularized transport `M = (r_E τ − f k×τ)/(ρ₀(r_E² + f²))`, r_E ≈ f(3°). **Upwelling** `w = ∇·M` in finite-volume form with M·n = 0 on land faces; w⁺ = max(w, 0).
7. **SST & air temperature**: SST advected by currents (semi-Lagrangian, **departure points in 3D**: `p_d = normalize(p − dt(uê + vn̂))` with 2 midpoint iterations; sub-step ≤ 1 cell; per-month precomputed 4-index/4-weight stencils); internally extend SST under land by nearest-ocean fill (jump flood); upwelling cooling `∝ w⁺·(SST − T_sub(lat))`, T_sub ≈ zonal annual SST − 6 K (≥ −1.8). Air temperature advected by the wind with the same machinery and relaxed toward the surface; lapse to the surface height.
8. **Budget** (Node, 360×180 output): dynamics ≤ 2.5 s full; `fast` ≤ 0.5 s (coarser/fewer years, warm start).

### 6.2 Hydrology (climate-hydrology) → `HydrologyResult`
* Column water W advected by the steering wind (3D semi-Lagrangian, precomputed stencils per month); eddy diffusion K ≈ 0.5–1.5e6 m²/s peaking in storm tracks.
* `W_sat = ρ_a·H_w·q_sat(T_s)` (H_w ≈ 2.2 km; T_s lapse-corrected, so plateaus hold little water); column RH `r = W/W_sat`.
* **Humidity-gated precipitation** (Bretherton et al. 2004): `P = (W/τ_p)·min(1, exp(a(r − r0)))·M`, a ≈ 15, r0 ≈ 0.75–0.8, τ_p ≈ few days; `M = max(0.05, 1 + c_c·Asc⁺ − c_s·Asc⁻ + c_f·Baro + c_o·Oro − c_st·Stab)` where Asc from `ascent` (local pressure field, not latitude), Baro from `baroclinic` (seasonal storm track → Mediterranean winter rain, wet NW coasts), **Oro** = `max(0, u·∇h⁺)` with `h⁺ = max(0, elev − seaLevel)` smoothed ~150–200 km and the undeflected wind, plus lee suppression `exp(−k·max(0, −u·∇h⁺))`, **Stab** = `max(0, T_ref(lat) − SST_upwind)` (cold upwelling coasts dry). r0 is lowered over land (diurnal / convective RH variance) and in storm tracks; a stable marine layer off cold water (Stab) caps both the land lowering and the orographic lift (× `exp(−Stab/2 K)`): marine air coming ashore on the Peruvian, Namib or Baja coasts gives fog, not rain. Apply P as an **implicit sink** inside the transport iteration: `W ← (W_adv + dt·E)/(1 + dt·P/W)`.
* Ocean evaporation `E = ρ C_E sqrt(|u|²+σ²)·max(0, q_sat(SST) − r·q_sat(T_a))·(1 − ice)·moisture`, σ ≈ 3–6 m/s. Land ET = `min(PET(T), β·P_prev)`, β ≈ 0.5–0.65, 0 below 0 °C, fixed-point iterated.
* Warm-start month m from m−1; stop when max relative ΔP < 1%. Report global |P−E|/E (target < 5%).
* **Snowpack** (monthly): accumulate precipitation falling at T < ~0 °C, melt by degree-days; snow cover fraction from SWE. **Clouds**: from column RH and precipitation (0..1).
* `sampleClimateAt` (`sample.ts`): nearest cell; optional lapse correction to an elevation override and class recomputation.
* Budget: hydrology ≤ 2 s full (360×180), ≤ 0.4 s fast.

### 6.3 Orchestrator & Köppen (climate-dynamics)
`computeClimate(input, params, onProgress?, warmStart?)` runs dynamics then hydrology, fills all ClimateResult fields finite (nearest-valid fill for ocean-only fields under land and vice versa), `koppen` (land only; 0 ocean) and `koppenAll` (every cell) via `classifyKoppen`, annual means, `id` (hash of input + params), `sourceSnapshotId/Time`, stats (global means, P−E error, Köppen group areas over land).

### 6.4 Calibration & tests (both climate owners; headless supplies Earth input)
Staged: freeze T → winds → currents → precipitation. Earth-independent tests using `idealContinentElevation`:
* east coast 25–35° P ≥ 3× west coast 25–35°; west coast 20–30° in group B; west coast 35–42° Cs; west coast 45–60° Cfb/Cfc; interior 45–50° (≥ 1500 km inland) P ≤ 0.5× west coast; land ITCZ shifts ≥ 10° seasonally; lee of the 3 km ridge ≤ 0.5× windward P.
* Aquaplanet: zonal std of T/P < ε, no stripes at ±10°, N/S symmetric at tilt 0. Retrograde: mirror symmetry. Extreme params (tilt 0/90, no land, 70% land): finite, sane ranges.
* Earth (`buildEarthClimateInput`): zonal-mean T RMSE small; global P ≈ 1000 ± 150 mm; Köppen group areas near A 19 / B 28 / C 14 / D 22 / E 17 % of land; reference-city hit rate ≥ 75% by group, ≥ 45% by full code. Fast vs full: ≥ 85% of land cells agree on Köppen group.
* Total budget: full ≤ 5 s, fast ≤ 1 s (Node, 360×180 / 180×90 respectively).

---

## 7. Painting (`src/render/paint.ts` + private helpers) — painter

Pure functions producing equirectangular RGBA (row 0 north). `PaintCache` keyed by value (§2.1), bounded in bytes.

* **Land/sea rule**: at display resolution, land iff `heightMap > opts.seaLevel`, for every layer (satellite, Köppen, coastlines). Climate provides only continuous fields and `koppenAll` (plus dilated land attributes for coastal pixels on climate-ocean cells).
* **Height map (`paintHeightMap`)**: smoothed display base (1–2 Laplacian iterations on a display copy of the mesh field, barycentric to the grid, separable metric-correct Gaussian σ ≈ 0.6 cell spacing — removes TIN facets) + procedural detail **sampled in each plate's material frame** (`R(rotation_k)ᵀ·p` for the top plate(s) of the pixel's barycentric triangle, blended by barycentric weight → detail travels with the plates, no crawling coasts). For speed precompute static detail (per size/seed/detail) and sample it rotated. Detail: ridged multifractal scaled by mountainousness (elevation, orogeny, relief), gentle fbm on plains, zero-mean **coastline breakup**, abyssal hills. Octaves band-limited to the pixel size; identical low octaves at every resolution/quality (preview and full coasts match).
* **Satellite** (showcase): Köppen drives it through **attributes, never interpolated class IDs**. Per class endmembers (soil RGB, vegetation RGBs broadleaf/needleleaf/grass, max cover, rockiness); per climate cell attributes modulated by continuous fields (cover from a smooth aridity ratio P/P_threshold, vegetation hue from T_warm/T_cold, monthly phenology from T > 5 °C & P > ~40 mm; drought leaf-drop only in frost-free climates); blur ~1 cell; sampled through a low-frequency isotropic 3D domain warp (~1.5 cells, itself B-spline upsampled) — colours bilinearly, the thresholded scalars (cover, tree fraction, temperatures, snow, desert, ice sheet) by **C² cubic B-spline**, so no climate-cell outline survives. **Mosaics, not linear blends**: each sub-grid fraction (vegetation, trees, snow, glacier ice; sea-ice floes) becomes patches by thresholding a plate-anchored patch score at the fraction's quantile with anti-aliased soft edges. The forest score is fractal (multi-scale patch noise + broad lithology tracts) and **mean-preserving** (wooded area ≈ tree fraction); contrast and edge softness depend on cover (strongest, softest at intermediate cover — savanna, forest-steppe; near-continuous closed humid canopy with faint shrubby openings; crisp stand structure under snow). Patches follow terrain (humid-forest openings in hollows/valleys; gallery forests in drylands and at the cold margin) and drawn rivers through dry steppe/savanna get riparian strips. Blend in linear light, encode sRGB at the end. Per pixel lapse correction vs the box-filtered height map (`dT = −LAPSE_RATE·(h_pix − h_ref)`) → alpine belts (re-classify when |dT| > 1 °C: treeline, rock by slope, permanent snow). **Snow** = smoothstep(+1, −5, T_pix(m))·min(1, cold-season precip/50 mm)·(1 − 0.6·treeCover), or the climate `snow` field lapse-adjusted. Ocean by depth (turquoise shelves → navy), **sea ice** by month, **rivers & lakes** (full quality only; metric-correct D8/D∞ routing with lon wrap, runoff = P − evap, traced polylines Chaikin-smoothed, anti-aliased, width ∝ log flow, mouths snapped to the output coast; lakes only where filled area ≥ k px and inflow·runoff > evaporation; arid endorheic → salt pans). Annual view: mean/max greenness over months (no hemisphere switching). Hillshade baked only when `opts.hillshade` (the globe uses GPU normals instead).
* **Other layers**: elevation (hypsometric + hillshade), plates (plate colors; categorical boundaries from a Gaussian 2-ring membership vote per mesh cell, interpolated barycentrically and thresholded to an anti-aliased signed-distance contour — smooth, no hex jaggies), crust (same), crust age (Müller-style; 20 Myr isochrons in full quality), temperature, precipitation (log), pressure (isobars + H/L centres), SST, wind speed, **currents** (speed shading, warm/cold by SST anomaly vs zonal mean, arrow glyphs), Köppen (standard colors on land pixels: per-pixel classification from B-spline-interpolated Köppen statistics of land-extended climate cells, height-corrected to the displayed height). Climate fields are split into land- and sea-extended grids, B-spline resampled and chosen per pixel by the height map. No climate → neutral fallback.
* **Quality**: `'preview'` ≤ 35 ms at 1024×512 for any layer given a cached grid map (target; the satellite preview currently measures ~50 ms on a new snapshot and its perf test allows 70 ms) (static detail cache, no rivers, cheap shading); `'full'` 2048×1024 satellite ≤ 2.5 s cold, month change with warm caches ≤ 150 ms (1024×512) / ≤ 500 ms (2048×1024).
* `paintOverlay`: boundaries (convergent red, divergent yellow, transform white; type = the `classifyBoundaries` rule evaluated per pixel with a smoothed boundary normal), graticule, coastlines traced on the same height map. `getLegend` for every layer.

---

## 8. Views (`globeView.ts`, `mapView.ts` + private) — views

### 8.1 GlobeView (Three.js)
* WebGLRenderer (antialias, DPR ≤ 2, `preserveDrawingBuffer` not needed: `toDataURL` renders then reads synchronously). OrbitControls: damping, zoom limits, rotate speed ∝ zoom, **pan disabled, RIGHT = ROTATE**.
* Surface: one **ShaderMaterial** sampling base (sRGB), overlay and height (**R16F/HalfFloat**, `flipY` per §2) textures in one pass; **object-space normals from the height texture in the shader** with the 1/cosφ metric (no tangent frames); optional vertex displacement by `reliefScale` (sea floor clamped to sea level for display); brush ring & graticule drawn analytically in the shader (fwidth AA). High-segment SphereGeometry (≥ 512×256) or a cube-sphere; texture anisotropy max.
* Lighting via `setLighting`: `flat` (exact legend colors), `relief` (camera-relative light, 35° up-left), `sun` (subsolar latitude = declination; night side dim with subtle city-less darkness). The app's default choice `auto` (`src/app/lighting.ts`) maps data layers to `flat`, satellite/elevation to `relief`, and the satellite in a specific month on the globe to `sun`. **Sun glint** on open water only (not sea ice): a small warm-white microfacet image of the sun — two Beckmann lobes with Cox–Munk wave-slope variance from the cloud layer's smoothed wind (+3 m/s gustiness; 6 m/s with clouds off), Fresnel, soft-capped, dimmed under cloud.
* Atmosphere Fresnel shell; subtle starfield. **Clouds** (on by default, display density 0.4 ≈ Earth-like): a shell above the surface. A per-cell coverage fraction thresholds domain-warped noise drifting along the wind (regimes: stratocumulus, deep convection, shallow cumulus, storm-track cyclones, cirrus). Storm-track cyclones travel as an evenly spaced wave train per hemisphere (they never merge), wind up from open waves into occluded commas (swirl 0.4 → 4 rad) and weaken over dry climates; their frontal / comma cloud is a bright, continuous sheet. Deep convection is sorted into ~360 km clusters (a zero-mean coverage bias from the Worley cell volume, sized by an independent noise, outlines roughened by the detail) with clear gaps, textured at the fine scales; cirrus is a veil striated by two octaves of zonally stretched streaks (coarse bundles resolved at the default zoom and in the map's world raster, fine fibres up close). Opacity grows smoothly from the cloud outline (`(excess/ref)^2.5`, slow saturation) with a per-cell thickness that rises with how cloudy the climate is, plus a thin wispy veil around cloud masses, so most cloud is thin and translucent (at 0.4: ≈ 45–50 % of the disk has some cloud, ≈ 15–20 % is bright and opaque); shadows only under thick cloud. The CPU model (`cloudsModel.ts`/`cloudsField.ts`, used by the map raster) mirrors the shader. All expensive cloud work (cover/regime grids, noise volumes, the map raster) runs in the **cloud worker** (`src/render/cloudsWorker.ts`, a module worker created by `cloudsWorkerClient.ts` through the literal `new Worker(new URL('./cloudsWorker.ts', import.meta.url), { type: 'module' })` so Vite bundles it). `GlobeClouds.set()` / `MapClouds.set()` are asynchronous: the globe updates ~10–150 ms later with a 0.9 s crossfade; the map ~0.3–1.5 s later through `MapClouds`' `onUpdate` callback (MapView marks its base dirty). A `MapClouds` without `onUpdate` falls back to a synchronous 768×384 raster. HD map clouds are tiled: a quadtree of 256² equirect tiles (level L: π/2^L rad a side, a 1-px apron for seamless relief shading) with every detail octave their resolution resolves; at any zoom the visible tiles of the level matching the screen (≥ 0.85 of its device resolution, capped at 1.5 px per CSS px, always finer than the 1536-px world raster; ≤ ~50 tiles per view) are rasterized by the worker one at a time, nearest the view centre first, once the view has rested 220 ms (`MapClouds.setView` on every redraw, `drawCopy` per world copy); then, optimistically, the next finer level under the view (≤ 200 tiles) and the next coarser level over twice its extent, so a slow zoom crosses each breakpoint onto tiles already made. Tiles are cached per cloud spec (LRU, 320 tiles). Each part of the view shows its own level only, so the picture changes at zoom breakpoints and never when a prefetched tile lands; other cached levels stand in (coarse to fine, finer ones downscaled up to 4×, coarser ones up to 3 levels up) only where the view's own tile is missing. Zooming or panning back is instant; the previous clouds' tiles stay on screen until the new world raster lands.
* **Cloud quality** (`CloudSpec.quality`, `CloudQuality`): `'standard'` is a cheaper tier — globe regime grids box-averaged to ≤ 180 cells wide in the worker (~2 ms instead of ~13 ms), only the two coarse detail octaves (`uOctaveMask` on the shader's footprint fade: the finer two are not fetched), a 768×384 map raster (~60 ms instead of ~220 ms) and no map tiles. `'high'` (the default when unset) is the full model, which the app sends on every climate / month / density change; `ViewSync` uses `'standard'` only while the seasons play on the map (re-tiling a zoomed map every month cannot keep up: its tiles would flicker), and full quality again when the playback stops. Views report completion through `WorldView.onCloudsShown(handler)`, called with the very spec object given to `setClouds()` once its clouds are on screen. Debug aid: `?cloudDebug` in the URL (`src/render/cloudsDebug.ts`) replaces the globe's clouds by 15° tiles showing the effective detail octaves rendered there (footprint fades × quality mask, 0–4) over the cloud grid width, and labels map sections with their source raster (W world / Tn the finest tile, level n), its size, octaves and on-screen stretch.
* Arrows: instanced great-circle shaft+head geometry with polygonOffset. Markers: screen-space sprites. Particles: CPU advection in 3D on the tangent plane `p ← normalize(p + (uê + vn̂)·k·dt)`, area-uniform spawning, randomized lifetimes, respawn on NaN/land/low speed; rendered as `LineSegments` with a ring buffer of 6–10 history points per particle and per-vertex alpha; display speed factor per kind; colored by speed. ≥ 45 fps with 8k particles.
* `pick`: ray vs unit sphere, then 2–3 iterations against `r = 1 + s·h(p)`.

### 8.2 MapView (2D canvas)
Equirectangular, pan (drag) & zoom (wheel toward cursor), horizontal wrap, vertical clamp; base + overlay + particles (canvas fade; drop segments with |Δlon| > π) + arrows + markers + geodesic brush ellipse; `pick/project` consistent with wrap. Clouds optional translucent.

### 8.3 Pure helpers & tests
`src/render/viewUtil.ts`: lat/lon ↔ uv ↔ Three world ↔ screen math, wrap handling, arrow geometry, particle advection step. Unit-test round trips (incl. north pole & lon +90° marker placement).

---

## 9. Plate editor (`src/editor`) — editor

* Pure `editorCore.ts` (tested): brush application with **slerp stroke interpolation** (step ≤ radius/2, short way across the antimeridian, strokes break on null picks), always include the nearest cell, min radius = 1 spacing; flood fill; split along a stroke; lasso → new plate; seeds → `voronoiPlates`; disconnected-component auto-split (fragments < 20 cells merge into a neighbour); plate add/delete (cells merge into the neighbour with the longest shared boundary); motion from arrow drag: anchor = the plate's interior point (max BFS distance to its boundary; fallback when |centroid| < ε), `ω = (a × v)/R + spin·a`; undo/redo (≥ 30 steps; diff or snapshot).
* Tools: Select, Plate brush, Continent brush (fbm-based elevation with a shelf profile; ocean brush restores age-based depth), Raise/Lower, Fill, Split, Lasso, Seeds (markers via `setMarkers`), Motion (drag arrows; while dragging show a sparse field of small ω×p arrows and live-reclassified boundaries), Smooth boundaries; "Randomize motions".
* Plate list: swatch, editable name, area %, speed (cm/yr), direction (compass °), spin, delete; add plate (disabled at the cap, default random motion 30–60 km/Myr, new id from `nextPlateId`).
* Start: Blank / Random / From current simulation via `requestDraft`. Mesh change clears undo.
* **Preview** fast path ≤ 16 ms per update at 1024×512: keep `nearest` pixel→cell (from a grid map), recolor only pixels of changed cells (cell→pixel inverse list), boundaries drawn in the same pass, no noise; full repaint debounced on stroke end. Navigation in paint mode: right-drag, or Space/Alt + left-drag.
* "Simulate this world" → `onApply(finalizeDraft(mesh, cloneDraft(d), seed, keepElevationMask))`.

---

## 10. App (`src/main.ts`, `src/app`, `src/worker`) — app

* **Workers**: (1) *sim worker*: mesh, `TectonicSim`, keyframes, climate inputs; (2) *paint worker*: `PaintCache`, climates, painting — posts frames straight to main — plus 0–3 *playback paint helpers* that paint every other preview frame (`src/app/workers.ts`: 1 by default on ≥ 6 cores and ≥ 4 GB, `?paintHelpers=N` overrides); (3) *climate worker*: only `computeClimate` (cancel = `terminate()` + respawn; one pending job, latest wins; warm start from the previous result on the same grid); (4) *cloud worker* (views-owned, created lazily by `src/render/cloudsWorkerClient.ts`, §8.1): globe cloud grids/volumes and the map cloud raster, per-channel latest-wins; (5) the plate editor's full-render worker (`src/editor/fullRender.worker.ts`, debounced full repaint on stroke end). `MessageChannel`s link sim ⇄ paint (snapshots out, `taken` credits back) and climate → paint; a copy/subset of each climate goes to main. Playback is pipelined (sim steps k+1 while paint paints k) with `frameAck` backpressure at the paint worker, so pause/hover state may run 1–3 steps ahead of the displayed frame. The main thread builds its own mesh (deterministic, ~100 ms at 100k) for the editor/hover.
* **Protocol** (`src/worker/protocol.ts`): discriminated unions with `{ reqId, epoch }`; ≤ 1–2 playback frames in flight (`frameAck`); paint/climate requests coalesced (latest wins); stale epochs dropped (epoch bumps on pause/load/editor entry). While the editor is active, worker frames are not pushed into the view; on exit, re-push the cached frame.
* **Playback**: each frame = up to k steps (speed = steps per frame, never dt) → preview-quality paint of the current layer at 1024×512 (+ height map, overlay) → transfer. With **Smooth fast playback** (Simulate tab, default on) the speed is an upper bound: when a full batch would take longer than ~125 ms a frame goes out as soon as a paint worker is free, with steps per frame chosen so snapshot + hand-over cost stays ≤ ~15 % of stepping time; off = full batches (maximum simulation rate). Pause → full-quality repaint (2048×1024, rivers). Target ≥ 20 display fps and ≥ 5 steps/s at 100k.
* **Persistence** (`src/app/worldStore.ts`): the live simulation state is saved to IndexedDB when it settles (load, pause, step, history branch, every ~20 s of playback, tab hidden; ~1.5 MB at 100k). A reload of the same tab restores its world (toast with "Start fresh"); a fresh visit generates the World-tab world and only offers the latest saved world; worlds the World-tab settings would regenerate exactly are never saved or offered; `?fresh` disables restore and saving. History keyframes, climate and editor drafts are not saved.
* **Live climate** toggle: during playback request a fast climate (180×90) every N Myr in the climate worker (never blocks the sim); full climate on pause. **Play seasons**: auto-advance month (0.5–1 s/month) with sun, snow, sea ice, particles and clouds following.
* **Clouds follow the state**: `ViewSync` sends full-quality clouds whenever the climate, month or cloud density changes (standard ones while the seasons play on the map, see Cloud quality).
* **History**: keyframe snapshots every K Myr in the sim worker, capped by bytes (~256 MB: drop every other keyframe, double K); scrub shows keyframes (elevation/plates render, or satellite with the nearest older climate + fast climate request); "Play from here" → `new TectonicSim(draftFromSnapshot(kf))`, truncating later keyframes.
* **Layout** (dark, polished, responsive): header (title, tabs *World / Plates / Simulate / Climate / View*), left panel (tab content), center viewport (Globe/Map toggle, layer quick-picker), right panel (layers, overlays, legend, **hover inspector** with climograph — monthly T line + P bars, Köppen code/name, elevation, plate, crust age), bottom **timeline** (play/pause, step, speed, time Myr, history scrubber, month slider + play seasons).
* Hover data on main: mesh (own), latest snapshot clone (on pause and ≤ every 250 ms during play), latest climate (clone of needed fields), last height map → `sampleSnapshotAt`, `sampleClimateAt(…, elevOverride = displayed height)`.
* Export PNG (equirectangular RGBA of the current layer, and globe screenshot). Keyboard: Space play/pause, G/M globe/map, 1–9 layers, [ ] month. Progress indicators for long tasks; errors as toasts. Settings persisted in localStorage (try/catch).

---

## 11. Headless tooling (`scripts/`, `src/climate/earthInput.ts`) — headless

* **Priority 1** `src/climate/earthInput.ts`: `buildEarthClimateInput(w, h)` from `world-atlas/land-50m.json` (topojson-client `feature`, polygon rasterization with land-aware supersampling → landFraction), elevation = continental base + hand-authored major ranges/plateaus/ice sheets (Himalaya–Tibet, Andes, Rockies/Sierra/Cascades, Alps, Zagros/Anatolia/Iran, Ethiopian & East African highlands, Brazilian highlands, Appalachians, Urals, Scandinavian, Great Dividing Range, Greenland & Antarctic ice sheets, …) as polylines/polygons with widths and heights; ocean shelves/abyss. `REFERENCE_CITIES` (~80, all groups/continents, Beck codes). Plus `scripts/earthPreview.ts` writing elevation/land PNGs.
* `scripts/png.ts` (RGBA → PNG with pngjs; grayscale/colormap helpers).
* `scripts/headless.ts`: `--seed --n --myr --out --layers --size --month --climate full|fast|none` → generate → simulate → climate → paint; PNGs + `stats.json` (land fraction, elevation stats, Köppen areas, timings). Must degrade gracefully while modules are stubs (catch & report).
* `scripts/earth.ts`: run `computeClimate` on the Earth input; write Köppen/T/P/SST/currents/wind PNGs and a report (zonal means, group areas vs targets, city hit rates).
* `scripts/calibrate.ts`: parameter sweep harness over the tuning constants (imports tuning modules if present).

---

## 12. Quality bar
* Visual: satellite view reads as a believable planet at a glance (organic coastlines moving with the plates, mountain ranges where plates converge, deserts in the right places, rainforests at the equator, ice at the poles, clouds).
* Interaction: 60 fps navigation; playback ≥ 20 display fps; no main-thread stalls > 50 ms.
* Robustness: no NaN, no crashes on extreme params (tilt 0–90°, 3 or 30 plates, 5% or 70% continents, retrograde, no land).
