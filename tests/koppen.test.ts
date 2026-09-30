import { describe, expect, it } from 'vitest';
import { KOPPEN_CLASSES, classifyKoppen, koppenIdFromCode } from '../src/climate/koppen';

type Station = [name: string, southern: boolean, t: number[], p: number[], expected: string, cd?: 0 | -3];

// Approximate 1991-2020 style normals.
const STATIONS: Station[] = [
  ['Singapore', false, [26.5, 27.1, 27.5, 28, 28.3, 28.3, 27.9, 27.9, 27.6, 27.6, 27, 26.4], [243, 160, 184, 178, 172, 162, 158, 176, 169, 194, 256, 288], 'Af'],
  ['Darwin', true, [28.4, 28.2, 28.4, 28.2, 27.1, 25.4, 24.9, 25.8, 27.6, 29, 29.3, 29], [427, 374, 317, 102, 21, 1, 1, 5, 15, 70, 142, 248], 'Aw'],
  ['Miami', false, [20.1, 21.1, 22.5, 24.5, 26.8, 28.3, 28.9, 29.1, 28.3, 26.6, 23.8, 21.6], [47, 55, 71, 79, 147, 257, 172, 207, 256, 191, 79, 61], 'Am'],
  ['London', false, [5.2, 5.3, 7.6, 9.9, 13.3, 16.5, 18.7, 18.5, 15.7, 12, 8, 5.5], [55, 41, 42, 44, 49, 45, 45, 50, 49, 69, 59, 55], 'Cfb'],
  ['Cairo', false, [14, 15.2, 17.6, 21, 24.5, 27, 27.6, 27.6, 26, 23.6, 19, 15.3], [5, 4, 4, 1, 0, 0, 0, 0, 0, 1, 4, 6], 'BWh'],
  ['Rome', false, [7.5, 8.3, 10.5, 13, 17.3, 21.2, 24.2, 24.2, 20.8, 16.5, 11.7, 8.5], [67, 73, 58, 81, 53, 34, 19, 37, 73, 113, 115, 81], 'Csa'],
  ['Moscow', false, [-6.5, -6.7, -1, 6.7, 13.2, 17, 19.2, 17, 11.3, 5.6, -1.2, -5.2], [53, 44, 39, 37, 61, 77, 84, 82, 68, 71, 55, 52], 'Dfb'],
  ['Yakutsk', false, [-38.6, -33.8, -20.1, -4.8, 7.5, 16.4, 19.5, 15.2, 6.1, -7.8, -27, -37.6], [10, 8, 6, 10, 21, 36, 40, 39, 24, 20, 17, 11], 'Dfd'],
  ['Utqiagvik', false, [-25.6, -27.3, -26, -17.6, -6.2, 1.8, 5.2, 3.9, -0.6, -9.4, -18.5, -23.4], [3, 3, 3, 3, 3, 8, 26, 26, 18, 10, 5, 4], 'ET'],
  ['Vostok', true, [-32, -44, -57, -65, -66, -66, -67, -68, -66, -57, -43, -32], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 'EF'],
  ['Phoenix', false, [12.8, 14.6, 17.9, 21.6, 26.4, 31.3, 33.9, 33.3, 30.6, 24.3, 17.2, 12.3], [23, 24, 26, 7, 3, 1, 26, 27, 17, 15, 17, 24], 'BWh'],
  ['Denver', false, [-1, 0, 4.4, 8.6, 13.8, 19.6, 23.2, 22, 17, 10.4, 4, -1.3], [10, 11, 28, 44, 58, 44, 55, 47, 30, 26, 16, 12], 'BSk'],
  ['Hong Kong', false, [16.3, 16.8, 19.1, 22.6, 25.9, 27.9, 28.8, 28.6, 27.7, 25.5, 21.8, 17.9], [33, 45, 73, 137, 292, 489, 383, 432, 327, 100, 38, 27], 'Cwa'],
  ['Seattle', false, [5.6, 6.4, 8.2, 10.4, 13.6, 16.3, 19.2, 19.4, 16.6, 11.8, 7.8, 5.1], [140, 89, 95, 70, 48, 38, 18, 23, 38, 89, 166, 137], 'Csb'],
  ['Sydney', true, [23.5, 23.4, 22.1, 19.5, 16.6, 14.2, 13.4, 14.5, 17.2, 19.2, 20.8, 22.4], [101, 118, 131, 127, 119, 132, 80, 80, 68, 77, 84, 77], 'Cfa'],
  ['Reykjavik (0°C)', false, [-0.5, 0.4, 0.5, 2.9, 6.3, 9, 10.6, 10.3, 7.4, 4.4, 1.1, -0.2], [76, 72, 82, 58, 44, 50, 52, 62, 67, 86, 73, 79], 'Dfc', 0],
  ['Reykjavik (-3°C)', false, [-0.5, 0.4, 0.5, 2.9, 6.3, 9, 10.6, 10.3, 7.4, 4.4, 1.1, -0.2], [76, 72, 82, 58, 44, 50, 52, 62, 67, 86, 73, 79], 'Cfc', -3],
  ['Beijing', false, [-3.1, 0.3, 6.7, 14.8, 20.8, 24.9, 26.7, 25.5, 20.8, 13.7, 5, -0.9], [2, 5, 9, 26, 29, 71, 176, 182, 49, 19, 6, 2], 'Dwa'],
  ['Tehran', false, [3.9, 6.4, 11.3, 17.3, 22.8, 28.4, 31.2, 30.2, 26.1, 19.2, 11.7, 6], [37, 31, 38, 30, 14, 3, 3, 1, 1, 13, 26, 34], 'BSk'],
  ['Bogota', false, [13.6, 13.9, 14.3, 14.4, 14.4, 14.1, 13.7, 13.8, 13.8, 13.9, 14, 13.7], [49, 57, 86, 115, 101, 53, 42, 48, 65, 124, 116, 70], 'Cfb'],
];

describe('Köppen classifier', () => {
  it('has 31 classes with unique codes in the contract order', () => {
    expect(KOPPEN_CLASSES.length).toBe(31);
    expect(KOPPEN_CLASSES[0].code).toBe('Ocean');
    expect(KOPPEN_CLASSES.map((c) => c.code).slice(1).join(' ')).toBe(
      'Af Am Aw BWh BWk BSh BSk Csa Csb Csc Cwa Cwb Cwc Cfa Cfb Cfc Dsa Dsb Dsc Dsd Dwa Dwb Dwc Dwd Dfa Dfb Dfc Dfd ET EF',
    );
    KOPPEN_CLASSES.forEach((c, i) => expect(c.id).toBe(i));
    expect(koppenIdFromCode('Cfb')).toBe(15);
    expect(koppenIdFromCode('nope')).toBe(-1);
  });
  for (const [name, southern, t, p, expected, cd] of STATIONS) {
    it(`${name} -> ${expected}`, () => {
      const id = classifyKoppen(t, p, southern, cd === undefined ? undefined : { cdBoundary: cd });
      expect(KOPPEN_CLASSES[id].code).toBe(expected);
    });
  }
  it('never returns ocean and tolerates NaN input', () => {
    const id = classifyKoppen(new Array(12).fill(NaN), new Array(12).fill(NaN), false);
    expect(id).toBeGreaterThan(0);
  });
});
