import { Rng } from '../core/rng';
import type { GenerateParams, PlateSpec, SphereMesh, WorldDraft } from '../core/types';
import { plateColor, plateName } from './genCommon';
import { analyzeContinents, generateContinents } from './genContinents';
import { applyHotspotRelief, placeHotspots } from './genHotspots';
import { boundaryKinematics } from './genKinematics';
import { assignMotions } from './genMotion';
import { oceanAges } from './genOceanAge';
import { normalizeGenerateParams } from './genParams';
import { growPlates } from './genPlates';
import { buildRelief } from './genRelief';

export { DEFAULT_GENERATE_PARAMS } from './genParams';

/** Independent random streams per stage, so tuning one stage never reshuffles the others. */
const STREAM = { noise: 0, continents: 1, plates: 2, motion: 3, relief: 4, hotspots: 5, hotspotRelief: 6 } as const;

/**
 * Random Earth-like starting world (see SPEC.md §5). Deterministic for (mesh.n, params).
 *
 * Pipeline: continental crust mask → plates grown around it (boundaries avoid continents) →
 * motions (continent-sharing plates move together) → boundary kinematics → oceanic ages from the
 * divergent boundaries → relief (shelves, cratons, old ranges, belts at active margins, ocean depth
 * from age) → hotspots with swells and seamount chains.
 */
export function generateRandomDraft(mesh: SphereMesh, params: GenerateParams): WorldDraft {
  const p = normalizeGenerateParams(params);
  const root = new Rng(p.seed);
  const noiseSeed = root.fork(STREAM.noise).int(0, 0x7fffffff);
  const crust = generateContinents(mesh, p.continentMode, p.continentalFraction, root.fork(STREAM.continents), noiseSeed);
  const continents = analyzeContinents(mesh, crust);
  const { plate } = growPlates(mesh, continents, p.plateCount, p.boundaryRoughness, root.fork(STREAM.plates), noiseSeed);
  const { omega } = assignMotions(mesh, plate, crust, p.plateCount, p.plateSpeed / 50, root.fork(STREAM.motion));
  const kin = boundaryKinematics(mesh, plate, omega);
  const oceanAge = oceanAges(mesh, plate, crust, kin, noiseSeed);
  const relief = buildRelief(mesh, plate, crust, continents, oceanAge, kin, root.fork(STREAM.relief), noiseSeed);
  const hotspots = placeHotspots(p.hotspotCount, root.fork(STREAM.hotspots));
  applyHotspotRelief(mesh, plate, crust, omega, hotspots, relief.elev, root.fork(STREAM.hotspotRelief));
  const plates: PlateSpec[] = omega.map((w, k) => ({
    id: k + 1,
    name: plateName(k, p.seed),
    color: plateColor(k),
    omega: [w[0], w[1], w[2]],
  }));
  return {
    n: mesh.n,
    plate,
    crust,
    elev: relief.elev,
    age: relief.age,
    orogeny: relief.orogeny,
    plates,
    hotspots,
    time: 0,
    seed: p.seed,
    nextPlateId: plates.length + 1,
    stepIndex: 0,
    revision: 0,
  };
}
