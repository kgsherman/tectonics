# Worldgen

A procedural planet generator that runs in the browser. It simulates plate tectonics you can watch play out, lets you draw your own plates, runs a seasonal climate model (winds, ocean currents, weather, precipitation) that classifies every location into a Köppen climate, and paints the result as a satellite view on a 3D globe or a 2D map.

## Quick start

```bash
npm install
```

```bash
npm run dev
```

Open the URL Vite prints (port 5188 by default). A world is generated on load. Press **Space** to start the tectonic simulation.

## What you can do

| Tab | What it does |
|---|---|
| **World** | Generate a random world: seed, mesh resolution (40k / 100k / 160k cells), plate count, continental crust fraction, continent style (scattered / Pangaea / islands), hotspots, plate speed, boundary roughness. |
| **Plates** | Draw your own world. Tools: plate brush, continent brush, raise/lower, fill, split, lasso, seeds (Voronoi), motion arrows, smooth. Edit each plate's speed, heading and spin. Start from blank, random or the current simulation, then press **Simulate this world**. |
| **Simulate** | Tectonic parameters: time step, rifting rate, plate merging, subduction and collision uplift, erosion, hotspot activity, speed scale. |
| **Climate** | Planet parameters: axial tilt, solar output, temperature offset, moisture, ocean heat transport, sea level, retrograde rotation. Compute the climate, or enable *auto climate* to refresh it periodically during playback. |
| **View** | Lighting (flat / relief / sun), relief exaggeration, terrain detail, clouds and cloudiness (standard clouds follow every change; *Generate HD clouds* renders the current month at full detail on demand), wind/current particles, overlays (plate boundaries, coastlines, graticule), PNG export. |

**Layers:** satellite, elevation, plates, crust type, crust age, temperature, precipitation, pressure, sea surface temperature, wind, ocean currents, Köppen climate.

**Timeline:** play/pause, single step, speed (1×–20×), a history scrubber over stored keyframes (branch the simulation from any keyframe), a month slider, and *play seasons*.

**Inspector:** hover the planet to see the plate, crust, elevation, and a climograph (monthly temperature and precipitation) with the Köppen class of that spot.

### Keyboard

| Key | Action |
|---|---|
| Space | Play / pause |
| . | Single step |
| G / M | Globe / map |
| 1–9 | Switch layer |
| [ / ] | Previous / next month |
| S | Play seasons |

The plate editor has its own shortcuts (tool letters, `[`/`]` brush size, Ctrl+Z / Ctrl+Shift+Z undo/redo). The keyboard button in its panel lists them.

## How it works

### Tectonics (`src/tectonics`)
The planet is a spherical Fibonacci lattice (default 100k cells) with a spherical Delaunay triangulation. Each plate keeps its crust in its own rotating reference frame on that shared lattice, and its rotation quaternion accumulates without ever being reset. As a result, rigid plate motion never blurs the crust or leaves slow plates stuck.

Each step works out which plate is on top of every world cell and resolves overlaps and gaps:

- **Divergent boundaries:** spreading creates new ocean crust at mid-ocean ridges.
- **Subduction:** a convergence gate stops lattice aliasing from faking subduction along transform faults. A per-plate polarity rank decides which plate sinks.
- **Relief:** it builds volcanic arcs, cordilleras, trenches and collision plateaus.
- **Hotspots:** leave seamount and island chains.
- **Rifting and merging:** plates split and fuse.
- **Surface processes:** ocean floor deepens with age (GDH1 model); continents erode toward an isostatic freeboard.

### Climate (`src/climate`)
A coupled seasonal energy-balance model runs over land, the ocean mixed layer and sea ice, using implicit finite-volume numerics that stay stable at the poles. On top of that:

- **Pressure:** belts follow the oceans' thermal equator, with thermal lows and highs over continents. Summer continents carry a monsoon trough near the summer tropic. Heat lows and that trough are treated as shallow: they steer the moisture-carrying winds, but the rain-producing ascent sits equatorward of them, so desert heat lows stay dry while monsoon margins get their summer rain.
- **Winds:** a Rayleigh-friction balance that holds at every latitude, including the equator.
- **Ocean currents:** a wind-driven Stommel barotropic model with island circulation constraints, plus Ekman drift and coastal/equatorial upwelling.
- **Temperature transport:** sea surface and air temperatures are advected in 3D (semi-Lagrangian).
- **Moisture:** transport with humidity-gated precipitation, including ascent, storm tracks, orographic lift and rain shadows, and stable air over cold water (which also caps coastal mountain lift, keeping coasts like Peru's dry).
- **Land surface:** evapotranspiration, snowpack and cloud cover.

The monthly temperature and precipitation feed a Köppen–Geiger classifier (Beck et al. 2018 classes). The model is validated against Earth: `npm run earth` rasterizes real coastlines with approximate relief and compares zonal temperatures, Köppen areas and about 80 reference cities.

### Rendering (`src/render`)
- **Painting:** pure CPU painters produce equirectangular images for every layer.
- **Satellite colors:** these come from Köppen-driven vegetation and soil attributes, adjusted by the continuous climate fields.
- **Seasons:** snow and sea ice change month by month.
- **Water:** rivers and lakes come from flow accumulation.
- **Terrain detail:** procedural detail is attached to each plate's frame, so coastlines move with the continents.
- **Globe:** Three.js with shader normals from the height map, an atmosphere, weather-like clouds, and flow particles.
- **Map:** a 2D map with pan and zoom.

### App (`src/app`, `src/worker`)
Four Web Workers keep the UI responsive:

- **Simulation worker:** runs the tectonics.
- **Paint worker:** pipelined with the simulation worker during playback.
- **Climate worker:** computes the climate, and can be cancelled.
- **Cloud worker** (`src/render/cloudsWorker.ts`): builds the globe's cloud fields and the map's cloud raster off the main thread.

## Development

```bash
npm test            # unit tests (vitest)
npm run perf        # performance budgets
npm run typecheck
npm run build
npm run headless -- --seed 7 --n 100000 --myr 200 --out out/run1   # headless render to PNGs
npm run earth       # climate validation against Earth
```

`SPEC.md` describes the architecture, module ownership, algorithms and acceptance criteria in detail.
