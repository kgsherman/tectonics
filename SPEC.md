# Worldgen — Architecture & Implementation Spec

A browser-based procedural planet generator:

1. **Plate tectonics** simulation you can play and watch evolve (mountains, rifts, ridges, trenches, island arcs, hotspots).
2. A **plate editor** to draw your own plates, paint continents and set plate motion, then simulate them.
3. A **climate model**: insolation → temperature → pressure & winds → wind‑driven **ocean currents** & SST → moisture transport & **precipitation** → **Köppen** classification (monthly, 12 months).
4. A **satellite view**: terrain painted from the Köppen climate (plus snow, sea ice, rivers, relief) on a 3D globe or 2D map.

Stack: **TypeScript + Vite + Three.js**, simulation in a **Web Worker**. All simulation and painting code is **DOM‑free pure TS** so it also runs in Node (`tsx`) for tests and the headless PNG renderer.

---

## 1. Repository layout & ownership

| Path | Owner (module) | Notes |
|---|---|---|
| `src/core/types.ts`, `src/core/constants.ts` | **contract** | Shared types. Change only with coordinated updates. |
| `src/core/{math3,rng,noise,sphereMesh,grid}.ts` | core | Foundation used by all. |
| `src/tectonics/sim.ts` (+ private `src/tectonics/sim*.ts`) | tectonics-sim | `TectonicSim` |
| `src/tectonics/{generate,draft}.ts` (+ private `src/tectonics/gen*.ts`) | tectonics-generate | random worlds + draft helpers |
| `src/climate/**` except `koppen.ts` | climate | `computeClimate` |
| `src/climate/koppen.ts` | koppen | classifier + class table |
| `src/render/paint.ts` + private `src/render/{colormaps,terrain,satellite,rivers,layers,overlay}*.ts` | painter | pure RGBA painting |
| `src/render/{globeView,mapView}.ts` + private `src/render/{particles,viewUtil}*.ts` | views | Three.js globe & 2D map |
| `src/editor/**` | editor | plate drawing tool |
| `src/main.ts`, `src/app/**`, `src/worker/**`, `src/styles.css`, `index.html` | app | shell, UI, worker protocol |
| `scripts/**` | headless | headless pipeline, PNG output, Earth validation |
| `tests/<module>.*.test.ts` | each module | Vitest |

Rules:
* **Only edit files you own.** If you need something from another module that the contract doesn't provide, write it privately in your own module (or note it in your final report). Never edit `src/core/types.ts` or another module's files.
* Keep every exported contract signature exactly (you may add optional parameters or extra exports).
* No new npm dependencies (already installed: `three`, `delaunator`, `vite`, `vitest`, `tsx`, `pngjs`, `world-atlas`, `topojson-client`, types). Three addons are available as `three/examples/jsm/...`.
* TypeScript strict; `verbatimModuleSyntax` (use `import type` for types). No `const enum`.
* Everything under `src/core`, `src/tectonics`, `src/climate`, `src/render/paint.ts` and its private helpers must not touch `window`, `document`, DOM APIs or `performance.now` assumptions beyond `globalThis.performance?.now()`.
* Hot loops: typed arrays, no per-element allocation, no closures in inner loops.
* Determinism: all randomness from `Rng`/`createNoise3` seeded; same inputs ⇒ same outputs.

Commands: `npm run typecheck`, `npm test` (vitest), `npx vitest run tests/<file>`, `npm run dev` (Vite), `npx tsx scripts/<file>.ts`.

---

## 2. Conventions

* Unit sphere, z = north. `x = cos(lat)cos(lon)`, `y = cos(lat)sin(lon)`, `z = sin(lat)`. Radians internally.
* Grids (lat‑lon rasters): row‑major, **row 0 = north**, col 0 = lon −180°. `lat(r) = π/2 − (r+0.5)π/h`, `lon(c) = −π + (c+0.5)2π/w`. Longitude wraps; latitude clamps.
* Earth radius R = 6371 km. Time in **Myr**. Plate speed km/Myr (= mm/yr; 50 km/Myr = 5 cm/yr). Angular velocity ω rad/Myr, surface velocity v = ω × p · R.
* Elevation meters, datum sea level 0. Display sea level `seaLevel` offsets the shoreline only.
* Three.js mapping (views only): Three world `(X, Y, Z) = (x, z, −y)` (Y up). An equirect texture on `THREE.SphereGeometry` then lines up with lon/lat (u = (lon+π)/2π, v from north).

---

## 3. Core (`src/core`)

### 3.1 Sphere mesh
* **Spherical Fibonacci lattice**: point i ∈ [0,n): `z = 1 − (2i+1)/n`, `φ = 2π·frac(i·(Φ−1))` with Φ the golden ratio, `r = sqrt(1−z²)`, `(x,y) = r(cos φ, sin φ)`.
* **Spherical Delaunay** via Delaunator on a stereographic projection (Red Blob Games method): rotate so that point 0 (or any point) is at the projection pole, project the others stereographically, triangulate with `delaunator`, then close the hull by fanning hull edges to the pole point. Output triangles CCW seen from outside; build CSR adjacency (neighbors sorted CCW around each vertex is a nice-to-have). Verify Euler: `T = 2n − 4`, every vertex degree ≥ 3, adjacency symmetric.
* `spacing` = mean neighbor angular distance (≈ 1.05·sqrt(4π/n)); `cellArea = 4π/n`.
* **nearestCell(x,y,z,hint)**: exact. Start from `hint` if given, else from a lat‑lon lookup table `lut` (lutW×lutH ≈ ≥4 px per cell, each px storing its nearest cell), then greedy walk: move to any neighbor strictly closer (max dot) until none; on a Delaunay graph this terminates at the true nearest neighbor. Must be exact against brute force on 10k random queries (tests).
* `cellsWithinRadius(center, r)`: BFS from `nearestCell(center)` over neighbors whose dot ≥ cos r.
* Budget: `createSphereMesh(100_000)` < 400 ms in Node; `nearestCell` with good hint < 0.2 µs amortized, without hint < 1 µs.

### 3.2 Grid helpers
* `buildMeshGridMap(mesh, w, h)`: per pixel center direction → containing Delaunay triangle (walk from nearest cell's incident triangles) → barycentric weights (spherical: planar barycentric on the triangle's plane after projecting the ray; clamp negatives to 0 and renormalize). Also nearest cell. Budget: 2048×1024 < 1.5 s in Node, 1024×512 < 400 ms.
* `meshToGrid` / `meshToGridNearest` / `sampleGrid` (bilinear, lon wrap) / `gridToMesh` / `resampleGrid`.

### 3.3 Rng / noise
* `Rng`: sfc32 or mulberry32 seeded via a splitmix of the numeric seed. `fork(salt)` derives an independent stream without advancing the parent.
* `createNoise3(seed)`: 3D simplex (permutation table shuffled by `Rng`). `fbm3` normalized by amplitude sum. `ridged3` classic ridged multifractal in [0,1].

---

## 4. Tectonics simulation (`src/tectonics/sim.ts`)

### 4.1 Representation — "plate frames on a shared lattice"
The mesh (fixed world cells) doubles as the **reference lattice of every plate frame**. Plate k stores its crust in *its own frame* as dense per‑lattice‑cell arrays of length n:

```
owned:   Uint8Array   // 1 if plate k has crust at lattice cell j (in k's frame)
crust:   Uint8Array   // CRUST_OCEANIC | CRUST_CONTINENTAL
elev:    Float32Array // m
age:     Float32Array // Myr
orogeny: Float32Array // m, recent uplift (decays, e-fold 50 Myr)
hint:    Int32Array   // cached world cell that lattice cell j mapped to last step (for fast nearestCell)
```
plus `q_k` (quaternion, plate frame → world frame, **accumulated forever, never reset**), `omega_k` (world frame, rad/Myr), id/name/color.
World position of plate cell j = `R(q_k)·s_j`. Plate crust is **never resampled/interpolated**: no numerical diffusion, no "stuck slow plate" artefacts. Only discrete edits happen (add a cell, remove a cell, modify props). Memory: ~18 bytes × n × plates (≈ 43 MB for n = 100k, 24 plates) — acceptable; allocate lazily and free when a plate dies.

At construction from a `WorldDraft`: every plate gets `q = identity`, and owns exactly the cells the draft assigns to it.

### 4.2 One step (dt Myr; substep so that max per‑substep displacement ≤ 0.8·spacing)
1. **Move**: `q_k ← quat(ω̂_k, |ω_k|·dt·speedScale) ⊗ q_k`; normalize. `M_k = mat3(q_k)`.
2. **World pass (pull, per world cell i)** — determine who covers i:
   * Candidate plates = previous‑step top plate of i and of its neighbors, plus i's previous losers (small set; usually 1). Fallback to all plates if the candidate set yields nothing *and* the cell had no previous owner.
   * For candidate k: `j = nearestCell(M_kᵀ s_i, hint)` (hint: previous result for the same plate at i or at the neighbor that nominated k). k covers i iff `owned_k[j]`.
   * 0 covering → **gap** (step 4). 1 → top. ≥2 → **overlap**: top = most buoyant: continental > oceanic; among oceanic the *younger* is more buoyant; ties → larger plate. Others are **losers** at i: record `loserMask[i] |= 1<<k` (Uint32; maxPlates ≤ 32) and the convergence rate `v_conv = max(0, −(v_k − v_top)·n̂)` (or simply |v_k − v_top| projected on the vector between their centroids at i; any sound estimate).
   * Write world arrays: `worldPlate[i]`, `worldSrc[i] = j_top`, and copy top's props into `worldElev/crust/age/orogeny`.
3. **Plate pass (push‑check, per plate k, per owned lattice cell j)**: `i = nearestCell(M_k s_j, hint_k[j])`.
   * If `worldPlate[i] == k`: cell is at the surface — apply surface effects later (steps 5–6).
   * Else if `loserMask[i]` has bit k: the cell is **under** another plate:
     * oceanic → **subduction**: remove (`owned=0`). Mark i as a subduction front for overriding plate `worldPlate[i]` with rate `v_conv`.
     * continental under continental → **collision**: transfer mass: `elev[top cell] += c_col · max(0, elev_j + 500)` (thickening; cap e.g. 9 km) and remove; mark collision front; accumulate contact count for plate pair (k, top).
     * continental under oceanic (rare; buoyancy rule normally prevents) → treat as collision/accretion: *transfer the cell to the top plate* only if the top plate doesn't own the target lattice cell; else thicken.
   * Else: hidden by lattice aliasing at an edge — leave it (it will resurface or be consumed later). **Do not delete** cells that are merely aliased; that would erode every plate edge each step.
4. **Gaps** (divergence & aliasing holes): for gap world cell i choose plate g = previous top of i (the plate that just moved away), else the most common top plate among neighbors. New crust at `j = nearestCell(M_gᵀ s_i)` in g's frame:
   * If relative divergence speed between g and the neighbor plate across the gap is > ~5 km/Myr, or no continental neighbor → **new oceanic crust**: `age = 0`, `elev = ridge depth (≈ −2500 m)`.
   * Else (transform/aliasing noise, very slow stretching) → copy props from the nearest covered neighbor (continental stays continental; elevation lowered by ~100–300 m → rift valley). This prevents ocean speckles inside continents along transform faults while still letting fast rifts open oceans.
5. **Interaction fields on the world graph** (multi‑source Dijkstra/BFS, edge length = angle × R):
   * **Subduction uplift**: distance `d` from subduction fronts into the overriding plate (only through cells whose top is that plate, up to ~1800 km). Uplift rate `U_s · v_conv · f_s(d)` with `f_s` peaking at ~150–300 km (volcanic arc / cordillera), decaying to 0 by ~1000 km. Oceanic overriding → island arcs; arc cells whose elevation rises above −500 m become **continental** (crustal growth).
   * **Trenches**: subducting‑plate cells within ~150 km of a front get `elev = min(elev, trench profile)` (≈ −7500 m at the front, back to normal at 150 km).
   * **Collision uplift**: distance from collision fronts into continental cells of both plates, up to ~1200 km, rate `U_c · v_conv · f_c(d)` peaking at the front with a broad plateau (Himalaya/Tibet).
   * **Hotspots** (fixed in world frame): cells within radius get `+H · strength · dt · gaussian` → seamount/island chains on moving plates (Hawaii), flood basalts/uplift on continents.
   * Apply uplift through the plate pass (world cell i → plate cell j when `worldPlate[i]==k`), and add it to `orogeny` too. Cap elevations (≤ 9000 m).
6. **Surface processes** (per owned plate cell, per dt):
   * Oceanic: `age += dt`; subsidence `elev += oceanDepthForAge(age+dt) − oceanDepthForAge(age)` (so features like arcs & seamounts also subside); floor ≥ −11000.
   * Continental: `age += dt`; erosion toward base level: `h > 0: h ← h · exp(−dt/τ(h))` with τ ≈ 150–300 Myr (faster for high peaks), plus plate‑frame lattice diffusion (neighbors via mesh.adj on owned cells, κ tuned so mountain belts broaden but survive ~100 Myr); submerged continental crust slowly rises toward ~−200 m (shelf sedimentation) and continental crust below ~−1500 m (stretched, aged) slowly converts to oceanic‑like depth — optional.
   * `orogeny *= exp(−dt/50)`.
7. **Plate dynamics**:
   * Collision drag: for plate pairs with collision contacts, pull their ω toward each other: `ω_a += κ · contacts/area_a · (ω_b − ω_a) · dt` (symmetric). If `mergePlates` and relative speed at the contact < ~5 km/Myr for a sustained period with large contact → **merge** smaller into larger: pull‑resample the smaller plate's cells into the larger's frame (iterate the larger frame's un‑owned lattice cells j', map to world, `nearestCell` in the smaller frame; copy if owned — hole‑free), ω = area‑weighted mean.
   * Optional mild slab pull: plates with long subducting fronts accelerate slightly toward them, with speeds clamped to [5, 150] km/Myr at the centroid.
8. **Rifting** (Poisson, `riftRate` per 100 Myr, only if plate count < maxPlates): pick a plate weighted by area × (1 + continentalFraction); choose 2 seed points in it far apart; split its owned cells by noise‑warped nearest seed (in its own frame); the new plate copies `q` and masked arrays; set `ω_{1,2} = ω ∓ Δω/2` with `Δω` a rotation carrying the halves apart at 20–60 km/Myr. Continental rifts then open new oceans through step 4.
9. **Housekeeping**: remove plates that own no cells (or < ~20 cells: merge into neighbor); keep ids stable; time += dt.

### 4.3 Outputs
* `snapshot()`: world arrays (fresh copies), `boundary` classification (from `classifyBoundaries` or own), `plates: PlateInfo[]` (index = value in `plate[]`), hotspots.
* `toDraft()`: world‑frame state; reconstructing a sim from it must continue plausibly.
* `stats()`.

### 4.4 Acceptance (tests + headless)
* After construction, `snapshot().plate` equals the draft's plates exactly (q = identity).
* Every step: every world cell has a top plate; no NaN; plates ≤ maxPlates; ids unique.
* Two plates, one moving away from the other → oceanic ridge cells with age < 5 Myr appear along the divergent boundary; moving toward → one subducts (oceanic plate's owned count drops) and the overriding plate's elevation near the front rises.
* A continent carried on a plate keeps its shape after 100 Myr of pure rotation (continental cell count within ±3%, no ocean speckles: fraction of oceanic cells whose neighbors are all continental < 0.1% of continental cells).
* From a random 12‑plate world, 300 Myr: continental fraction stays within ±40% of the initial; land fraction 15–50%; highest mountains 3–9 km concentrated near convergent boundaries (mean elevation of continental cells within 400 km of convergent boundaries > 1.5× mean elevation of other continental cells).
* Perf: n = 100k, 12–20 plates: `step()` (dt = 1) ≤ 40 ms in Node.

### 4.5 Ocean depth vs age (shared, `oceanDepthForAge` in draft.ts)
`depth(age) = −(2500 + 350·sqrt(age))` for age ≤ 80 Myr, then flattening toward −6400 m (e.g. Parsons & Sclater / GDH1‑like), clamp ≥ −6500.

---

## 5. Random world generation (`src/tectonics/generate.ts`, `draft.ts`)

* Plates: `plateCount` seeds (well‑separated, e.g. best‑of‑k candidates), weights to get a realistic size distribution (a few large, several medium, some small), assignment by **noise‑warped nearest seed** (warp amplitude ∝ `boundaryRoughness`), then clean up: every plate connected (keep the largest component; reassign orphans to neighbors).
* Continents: continental mask covering ≈ `continentalFraction` of the sphere. `'scattered'`: 3–7 continents from thresholded warped fbm plus big low‑frequency blobs; `'supercontinent'`: one large mass around a random center with ragged coasts plus a few fragments; `'archipelago'`: higher frequency, many small masses. Continental elevation: base ~+300 m, noise, shelves down to −200 m at edges (≈ 70–80% of continental crust above sea level). Old cratons slightly higher/older.
* Oceanic crust: synthetic age from distance to plate boundaries that are divergent under the chosen motions (young near ridges, 0–180 Myr), elevation from `oceanDepthForAge`.
* Plate motions: continental‑dominated plates slower (15–40 km/Myr), oceanic plates faster (40–100 km/Myr), scaled by `plateSpeed / 50`. Random Euler poles mostly 60–90° from the plate centroid (translation‑like) with small spin.
* Hotspots: `hotspotCount` random positions, strength 0.5–1.5, radius ~1.5–3°.
* Also: `plateColor`, `plateName`, `computePlateInfos`, `classifyBoundaries`, `snapshotFromDraft`, `blankDraft`, `cloneDraft`, `voronoiPlates`, `oceanDepthForAge`, `compactDraft`.
* Budget: `generateRandomDraft` ≤ 600 ms at n = 100k (Node).

---

## 6. Climate (`src/climate`)

Grid w×h (default 360×180; `fast` may internally use coarser grids/fewer iterations). 12 months. All physics tuned to reproduce **Earth‑like** results for Earth‑like geography; validated with the Earth land mask (see §11).

### 6.1 Stages
1. **Insolation** per latitude & month: daily‑mean TOA insolation from declination `δ = asin(sin(tilt)·sin(orbital longitude))` (months centered mid‑month; NH summer solstice ≈ late June), `solarMultiplier`.
2. **Radiative/energy‑balance temperature** (Budyko–Sellers style): `C dT/dt = Q(1−α) − (A + B·T) + transport`, with albedo α by surface (ocean ~0.08, land ~0.25, snow/ice ~0.6 with a smooth T‑dependent transition) plus a cloud term, heat capacity C large over ocean (mixed layer ⇒ lag ~6–8 weeks, damped seasonal cycle) and small over land. Horizontal transport = diffusion + (later) advection by winds. Integrate over several model years with ~5‑day steps until periodic. **Pole‑safe numerics**: use an isotropic stencil whose E/W neighbor offset is a fixed *physical* distance (sample the row at ±Δx/(R·cos φ) in longitude, bilinear, capped) or implicit/ADI diffusion — never a naïve explicit 5‑point Laplacian on the raw lat‑lon grid near the poles.
3. **Pressure** (sea level, hPa) per month: zonal belts that follow the seasonal thermal equator (ITCZ low ~−7 hPa, subtropical highs ~+8 hPa at ~±30°, subpolar lows ~−10 hPa at ~±60°, polar highs), shifted seasonally (more over land), plus a **thermal term** over land: `ΔP = −k·(T_land − T_zonalOcean)` smoothed at ~1000 km scale ⇒ summer heat lows / monsoons, winter continental highs.
4. **Winds**: geostrophic from ∇P with `f = 2Ω sin φ` (sign flipped if `retrograde`), turned toward low pressure by a friction angle (~20° ocean, ~35° land) and reduced (×0.7 ocean, ×0.5 land); near the equator (|φ| < ~10°) blend to down‑gradient flow. Realistic magnitudes: trades 5–8 m/s, westerlies 7–12 m/s. Mountains slow/deflect winds a little.
5. **Ocean currents**: wind stress `τ = ρ_a C_d |u| u`. **Stommel/Munk barotropic vorticity model** per basin: `r ∇²ψ + β ∂ψ/∂x = curl(τ)/(ρ₀H)` with ψ = 0 on coasts, solved by SOR (warm‑started month to month); restrict to |φ| < ~75° with appropriate metric factors. Western boundary layer width `r/β` ≈ 2–3 cells. Add an **Ekman surface drift** (≈ 2–3% of wind, deflected 45° right/left of the wind in N/S hemispheres; along‑wind near the equator) so circumpolar channels get an ACC. Scale so western boundary currents reach ~1–2 m/s. **Upwelling** where Ekman transport diverges (coastal & equatorial) ⇒ SST cooling.
6. **SST**: mixed‑layer heat budget with seasonal radiative forcing, advection by currents (semi‑Lagrangian, stable), eddy diffusion, upwelling cooling; freezing at −1.8 °C ⇒ `seaIce` fraction. Warm western boundary currents poleward, cold eastern boundary currents.
7. **Air temperature**: relax toward SST over ocean and toward the land energy balance over land, **advected by the winds** (maritime air moderates windward coasts; continental interiors get extremes), then **lapse rate** −6.5 °C/km to the actual surface elevation. `globalTempOffset` added.
8. **Moisture & precipitation**: precipitable water advected by the (steering) wind, semi‑Lagrangian, iterated to monthly steady state. Sources: ocean evaporation ∝ `q_sat(SST)`·(1−RH)·wind factor; land evapotranspiration recycling a fraction of local rain (more when warm and wet). Sinks/precip: large‑scale condensation when `q > RH_crit · q_sat(T)` (Clausius–Clapeyron, ~7%/K), **convergence** (−∇·u > 0, ITCZ/fronts), **orographic lift** `max(0, u·∇h)` (windward slopes wet, lee rain shadows), frontal enhancement in the storm track (~40–60°), **subsidence suppression** under subtropical highs and over cold upwelling waters. `moisture` multiplies evaporation.
9. **Köppen** per land cell from the 12 monthly T & P (`classifyKoppen`, southern hemisphere summer = Oct–Mar).

### 6.2 Calibration targets (Earth geography, defaults)
* Annual mean T: equator ~26–28 °C, 30° ~18–22, 45° ~8–13 (oceanic west coasts milder), 60° ~−2–5, Arctic ~−18, Antarctic plateau < −40. Seasonal range: tropics < 5 °C; 50°N continental interior > 35 °C; maritime west coasts ~10–15 °C.
* Global mean precipitation ~1000 mm/yr; rainforest land > 2000; subtropical west‑coast/interior deserts < 250; mid‑latitude west coasts 700–2000; continental interiors 300–600; polar < 300.
* Köppen area on Earth‑like land (roughly): A ~19%, B ~28%, C ~14%, D ~22%, E ~17%. The Earth test should reproduce the big features: Amazon/Congo/Indonesia Af/Am, Sahara/Arabia/Australia BWh, Mediterranean Cs, NW Europe Cfb, SE USA/China Cfa/Cwa, Siberia/Canada Dfc/Dfd, Greenland/Antarctica EF, monsoon India Aw/Am.
* Budget (Node, 360×180, full): ≤ 6 s total; `fast` (for live updates) ≤ 1 s.

---

## 7. Painting (`src/render/paint.ts` + private helpers)

All pure functions producing equirectangular RGBA (row 0 north). `PaintCache` memoizes `MeshGridMap`s per size, amplified terrain, rivers.

* **Terrain amplification** (`heightMap`): barycentric‑interpolated mesh elevation + seeded 3D noise detail on the unit sphere: ridged multifractal scaled by mountainousness (elevation, `orogeny`, local relief), gentle fbm on plains, **coastline breakup** (noise near sea level so coasts are fractal: bays, capes, islands), abyssal hills and fracture texture in oceans. Deterministic in (seed, detail); consistent between resolutions.
* **Satellite** (the showcase): per‑Köppen base palette (soil/rock color, vegetation color, vegetation cover) modulated by continuous climate fields (annual precip/aridity, temperature, month for seasonal greenness), with **noise‑warped sampling of the climate grid** so class boundaries look organic, not blocky; deserts vary (sand seas, red/ochre/grey regs), forests dark green, boreal blue‑green, tundra brown‑grey; **snow** by month where T < ~−1 °C (fractional), permanent **ice sheets** (EF); rock/snow above treeline by temperature at altitude; **ocean** depth coloring (turquoise shelves → deep navy), **sea ice** by month; **rivers & lakes** from flow accumulation (priority‑flood depression filling on the amplified heightmap at ≤1024×512, runoff = P − ET from climate, width ∝ log flow; endorheic basins in arid areas → salt pans); **hillshade** (multi‑directional, subtle in flat areas). Budget: 2048×1024 ≤ 2.5 s, 1024×512 ≤ 700 ms (with cached terrain/rivers much less).
* Other layers: elevation (hypsometric tint + hillshade), plates (plate colors, continental crust lighter, subtle relief), crust (oceanic/continental), crust age (Müller‑style rainbow for oceanic, grey continents), temperature (month or annual, diverging), precipitation (log scale), pressure (with isobars), SST, wind speed, Köppen (standard colors). Without climate: neutral fallback.
* `paintOverlay`: plate boundaries (convergent red, divergent yellow/cyan, transform grey‑white), graticule (every 30°), coastlines at `seaLevel`.
* `getLegend` for each layer.

---

## 8. Views (`src/render/globeView.ts`, `mapView.ts`)

### 8.1 GlobeView (Three.js)
* WebGLRenderer (antialias, devicePixelRatio ≤ 2), PerspectiveCamera, OrbitControls (damping, zoom limits, rotate speed scaled by zoom). Base sphere (high segment count) with `MeshStandardMaterial`/custom shader: base texture (sRGB), normal map derived from the height map (or bump map), optional vertex displacement by `reliefScale`. Directional "sun" light positioned from `month` (subsolar latitude = declination), soft ambient so the night side is still readable (or a toggle for flat lighting when month = −1). Fresnel **atmosphere** glow shell; subtle starfield background.
* Overlay sphere slightly above the surface for overlay image; arrows (plate velocities) as surface‑hugging 3D arrows or drawn into an overlay canvas; brush cursor as a surface circle.
* Particles: animated flow tracers for `VectorFieldSpec` (wind or current): ~5–15k particles advected on the sphere each frame using the field (bilinear), fading trails (render into a 2048×1024 or 1024×512 canvas texture with alpha decay, or GPU lines). Currents masked to ocean (u,v = 0/NaN on land). Must stay ≥ 40 fps on a laptop.
* `pick` via raycast on the unit sphere (convert Three coords back per §2). `setInteractionMode('paint')` disables left‑drag rotation.

### 8.2 MapView (2D canvas)
* Equirectangular with pan (drag) and zoom (wheel, toward cursor), horizontal wrap (draw the image repeated), vertical clamp. Same features as the globe: overlay, particles, arrows, brush cursor, pick/project.

---

## 9. Plate editor (`src/editor`)

Entered from the "Plates" tab (the app pauses the sim and hands the editor `sim.toDraft()` or a blank/random draft).
* **Tools**: Select (click plate), **Plate brush** (paint selected plate), **Continent brush** (paint continental/oceanic crust; also sets a reasonable elevation), **Raise/Lower** terrain brush, **Fill** (flood region of same plate), **Motion** (drag an arrow from the plate centroid to set direction & speed; numeric azimuth/speed/spin inputs in the plate list), **Seeds** (click to place seeds → Voronoi re‑partition, with roughness), **Smooth** boundaries.
* Brush radius in km, cursor shown via `view.setBrushCursor`. Brushes act on `cellsWithinRadius` of the picked point; drag interpolates along the path so fast strokes are continuous.
* **Plate list**: color swatch, editable name, area %, speed (cm/yr), direction (compass °), delete (cells merge into a neighbor), add plate.
* Start options: *Blank ocean*, *Random*, *From current simulation*. Undo/redo (≥ 30 steps). Live preview rendered with `paintLayer('plates', snapshotFromDraft(...))` + boundaries overlay + velocity arrows, throttled to animation frames.
* "Simulate this world" → `onApply(draft)`.

---

## 10. App (`src/main.ts`, `src/app`, `src/worker`)

* **Worker** (`src/worker/sim.worker.ts`, module worker via `new Worker(new URL(..., import.meta.url), { type: 'module' })`) owns mesh, `TectonicSim`, latest climate, `PaintCache`. Protocol (owned by app): init/generate/loadDraft/play/pause/step/setParams/setPlateOmega/requestDraft/computeClimate/paint/history. Posts snapshots + painted RGBA (transferables). During play: k steps → paint current layer at preview resolution (1024×512) → post; throttle to display rate; never queue unbounded work.
* **Layout** (dark, polished, responsive): header (title, tabs: *World*, *Plates*, *Simulate*, *Climate*, *View*), left panel (tab content), center viewport (Globe/Map toggle), right panel (layer picker, legend, hover inspector with **climograph**: monthly T line + P bars, Köppen code/name), bottom **timeline** (play/pause, step, speed, time Myr, history scrubber over stored keyframes).
* **Live climate** toggle: during playback recompute climate in `fast` mode every N Myr so the satellite view evolves with the continents; full climate when paused.
* Month slider (Jan…Dec, Annual) drives seasonal layers & globe sun.
* Export PNG of the current layer; keyboard shortcuts (Space play/pause, G/M globe/map, 1–9 layers).
* Loading/progress indicators for long tasks; errors surfaced as toasts.

---

## 11. Headless tooling (`scripts/`)

* `scripts/headless.ts`: `npx tsx scripts/headless.ts --seed 7 --n 100000 --myr 200 --out out/run1 [--layers satellite,koppen,elevation,plates] [--size 2048]` → runs generate → simulate → climate → paint, writes PNGs + `stats.json` (land fraction, elevation stats, Köppen class area %, timings).
* `scripts/earth.ts`: Earth validation — rasterize `world-atlas` land (50m) to the climate grid, approximate elevation (continental base + hand‑authored major ranges/plateaus/ice sheets: Himalaya‑Tibet, Andes, Rockies, Alps, Ethiopian & East African highlands, Greenland & Antarctic ice sheets, etc.), run `computeClimate`, write Köppen/temperature/precip PNGs and a report comparing Köppen group areas and ~40 reference cities (expected code vs. modelled).
* `scripts/png.ts`: write RGBA → PNG (pngjs).

---

## 12. Quality bar
* Visual: satellite view should read as a believable planet at a glance (organic coastlines, mountain ranges where plates converge, deserts in the right places, rainforests at the equator, ice at the poles).
* Interaction: 60 fps navigation; playback smooth (≥ 15 sim frames/s at n = 100k); no main‑thread stalls > 50 ms during playback.
* Robustness: no NaNs, no crashes on extreme params (tilt 0–90°, 3 plates, 30 plates, 5% or 70% continents, retrograde).
