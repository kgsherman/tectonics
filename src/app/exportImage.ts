/** PNG export: composite an RGBA base (+ optional overlay) on a canvas and download it. */

function canvasFor(rgba: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const img = ctx.createImageData(w, h);
  img.data.set(rgba.subarray(0, w * h * 4));
  ctx.putImageData(img, 0, 0);
  return c;
}

export function rgbaToPngBlob(rgba: Uint8ClampedArray, overlay: Uint8ClampedArray | null, w: number, h: number): Promise<Blob> {
  if (rgba.length < w * h * 4) return Promise.reject(new Error(`export: image has ${rgba.length} bytes, expected ${w * h * 4}`));
  const base = canvasFor(rgba, w, h);
  if (overlay) base.getContext('2d')!.drawImage(canvasFor(overlay, w, h), 0, 0);
  return new Promise((resolve, reject) =>
    base.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'),
  );
}

export function downloadUrl(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  downloadUrl(url, filename);
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** File-name-safe stamp like "satellite-t123Myr". */
export function exportName(layer: string, time: number, ext = 'png'): string {
  return `worldgen-${layer}-t${Math.round(time)}Myr.${ext}`;
}
