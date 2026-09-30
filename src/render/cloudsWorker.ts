/// <reference lib="webworker" />
/** Cloud worker entry (module worker): runs cloudsJobs.ts jobs off the main thread. */
import { runCloudJob, type CloudJob, type CloudJobResult } from './cloudsJobs';

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (e: MessageEvent<{ id: number; job: CloudJob }>) => {
  const { id, job } = e.data;
  try {
    const { result, transfer } = runCloudJob(job, true);
    let res: CloudJobResult = result;
    if (res.kind === 'raster' && typeof createImageBitmap === 'function') {
      // Decode-free hand-off: the main thread only draws the bitmap (a putImageData of the 8 MB
      // raster would cost it ~10 ms).
      const bitmap = await createImageBitmap(new ImageData(res.rgba as Uint8ClampedArray<ArrayBuffer>, res.w, res.h));
      res = { ...res, rgba: new Uint8ClampedArray(0), bitmap };
      scope.postMessage({ id, result: res }, [bitmap]);
      return;
    }
    scope.postMessage({ id, result: res }, transfer);
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) });
  }
};
