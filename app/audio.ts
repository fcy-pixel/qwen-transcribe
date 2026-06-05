// Client-side audio utilities: decode → mono 16kHz → silence-aware chunking → WAV.
// qwen3-asr-flash rejects large/long inputs, so we split long recordings into
// ~2-minute segments and transcribe each one, then stitch the results.

export const TARGET_SR = 16000;
export const CHUNK_SEC = 120; // target segment length
export const SEARCH_SEC = 8; // how far around a boundary to hunt for a quiet cut
export const MIN_CHUNK_SEC = 5; // never cut shorter than this

export interface Segment {
  blob: Blob;
  startSec: number;
  endSec: number;
}

function getAudioContext(): AudioContext {
  const Ctx =
    (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctx) throw new Error("此瀏覽器唔支援 Web Audio，請改用 Chrome / Edge / Safari。");
  return new Ctx();
}

/** Decode any browser-supported audio file to a single mono 16kHz Float32 track. */
export async function decodeToMono16k(file: File): Promise<Float32Array> {
  const arrayBuf = await file.arrayBuffer();
  const ctx = getAudioContext();
  let audioBuf: AudioBuffer;
  try {
    audioBuf = await ctx.decodeAudioData(arrayBuf.slice(0));
  } finally {
    // Best-effort close; some browsers keep it open.
    if (ctx.state !== "closed") ctx.close().catch(() => {});
  }

  // Downmix to mono.
  const ch = audioBuf.numberOfChannels;
  const len = audioBuf.length;
  const mono = new Float32Array(len);
  for (let c = 0; c < ch; c++) {
    const data = audioBuf.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += data[i] / ch;
  }

  return resampleLinear(mono, audioBuf.sampleRate, TARGET_SR);
}

/** Simple linear resampler (robust across browsers, no OfflineAudioContext quirks). */
function resampleLinear(
  data: Float32Array,
  srcRate: number,
  dstRate: number
): Float32Array {
  if (srcRate === dstRate) return data;
  const ratio = srcRate / dstRate;
  const newLen = Math.max(1, Math.round(data.length / ratio));
  const out = new Float32Array(newLen);
  const lastIdx = data.length - 1;
  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, lastIdx);
    const frac = idx - i0;
    out[i] = data[i0] * (1 - frac) + data[i1] * frac;
  }
  return out;
}

/** Compute segment boundaries (sample indices), cutting at the quietest nearby frame. */
export function computeBoundaries(data: Float32Array): number[] {
  const total = data.length;
  const chunkLen = CHUNK_SEC * TARGET_SR;
  const searchLen = SEARCH_SEC * TARGET_SR;
  const minLen = MIN_CHUNK_SEC * TARGET_SR;
  const frame = 320; // 20ms @ 16kHz

  if (total <= chunkLen) return [0, total];

  const bounds: number[] = [0];
  let pos = 0;
  while (pos + chunkLen < total) {
    const target = pos + chunkLen;
    const lo = Math.max(pos + minLen, target - searchLen);
    const hi = Math.min(total - 1, target + searchLen);
    let best = Math.min(target, total);
    let bestEnergy = Infinity;
    for (let f = lo; f < hi; f += frame) {
      let e = 0;
      const end = Math.min(f + frame, total);
      for (let i = f; i < end; i++) e += data[i] * data[i];
      if (e < bestEnergy) {
        bestEnergy = e;
        best = f;
      }
    }
    bounds.push(best);
    pos = best;
  }
  bounds.push(total);
  return bounds;
}

/** Encode a Float32 PCM slice to a 16-bit mono WAV Blob. */
export function encodeWav(samples: Float32Array, sampleRate = TARGET_SR): Blob {
  const bytes = 44 + samples.length * 2;
  const buf = new ArrayBuffer(bytes);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buf], { type: "audio/wav" });
}

/** Decode a file and split it into transcribable WAV segments. */
export async function buildSegments(file: File): Promise<Segment[]> {
  const data = await decodeToMono16k(file);
  const bounds = computeBoundaries(data);
  const segments: Segment[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i];
    const end = bounds[i + 1];
    if (end <= start) continue;
    segments.push({
      blob: encodeWav(data.subarray(start, end)),
      startSec: start / TARGET_SR,
      endSec: end / TARGET_SR,
    });
  }
  return segments;
}
