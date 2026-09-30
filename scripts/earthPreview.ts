/**
 * Render the Earth validation input to PNGs for visual inspection.
 *
 *   npx tsx scripts/earthPreview.ts [--out out/earth]
 *
 * Writes land-fraction and hillshaded elevation images at 360×180 (upscaled 4×) and 1440×720, plus
 * the reference cities (colored by observed Köppen class) on the 1440×720 elevation map.
 */
import { join } from 'node:path';
import { buildEarthClimateInput, REFERENCE_CITIES } from '../src/climate/earthInput';
import { KOPPEN_CLASSES, koppenIdFromCode } from '../src/climate/koppen';
import { elevationImage } from './lib/worldImages';
import { drawCoastlines, drawMarker, grayscaleImage, upscale, writePng } from './png';
import { parseArgs } from './cli';

const args = parseArgs(process.argv.slice(2), { out: 'out/earth' });
const outDir = String(args.out);

for (const [w, h, k] of [[360, 180, 4], [1440, 720, 1]] as const) {
  const t0 = performance.now();
  const input = buildEarthClimateInput(w, h);
  const ms = performance.now() - t0;
  const lf = input.landFraction!;
  const land = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) land[i] = lf[i] >= 0.5 ? 1 : 0;

  writePng(join(outDir, `land_${w}x${h}.png`), upscale(grayscaleImage(lf, w, h, 0, 1), k));
  const elev = upscale(elevationImage(input.elev, w, h, 0), k);
  drawCoastlines(elev, land, w, h, [30, 30, 30], 0.5);
  writePng(join(outDir, `elevation_${w}x${h}.png`), elev);

  if (w === 1440) {
    for (const city of REFERENCE_CITIES) {
      const id = koppenIdFromCode(city.koppen);
      drawMarker(elev, city.lat, city.lon, 3, id > 0 ? KOPPEN_CLASSES[id].color : [255, 0, 255]);
    }
    writePng(join(outDir, `cities_${w}x${h}.png`), elev);
  }
  console.log(`${w}x${h}: built in ${ms.toFixed(0)} ms`);
}
console.log(`wrote PNGs to ${outDir}`);
