/**
 * Cloud detail debug view, enabled by `?cloudDebug` in the page URL: the globe replaces its clouds
 * by 15° tiles showing the effective number of detail octaves rendered there (0–4, the footprint
 * fades × the quality mask) over the cloud grid width, the map labels each section with the raster it
 * is drawn from (world raster or the finest map tile), its size and octave count.
 */
export const CLOUD_DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('cloudDebug');

/** 3×5 bitmap glyphs (bit row·3 + col, row 0 at the top, col 0 left): digits 0–9, then '.'. */
const GLYPHS = [
  '111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001',
  '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111',
  '000000000000010',
];

/** Glyph bit codes for the shader (index 10 = '.'). */
export const GLYPH_CODES = GLYPHS.map((g) => [...g].reduce((s, b, i) => s + (b === '1' ? 2 ** i : 0), 0));
