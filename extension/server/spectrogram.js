// Spectrogram rendering to PNG, using only node:zlib.

import zlib from "node:zlib";
import { hann, loadAudio, monoMix, powerSpectrum } from "./audio.js";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encode an RGB image (Uint8Array of width*height*3) as PNG. */
export function encodePng(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Dark blue -> purple -> orange -> pale yellow, readable for quiet and loud energy.
const STOPS = [
  [0.0, [8, 8, 30]],
  [0.35, [80, 20, 120]],
  [0.65, [210, 70, 60]],
  [0.85, [250, 170, 40]],
  [1.0, [255, 250, 200]],
];

function color(t) {
  t = Math.min(1, Math.max(0, t));
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1], [t1, c1] = STOPS[i];
      const f = (t - t0) / (t1 - t0);
      return c0.map((v, k) => Math.round(v + f * (c1[k] - v)));
    }
  }
  return STOPS[STOPS.length - 1][1];
}

export const SPECTROGRAM_GRID_HZ = [50, 100, 200, 500, 1000, 2000, 5000, 10000];

/**
 * Draw a spectrogram: time left to right, frequency bottom to top on a log
 * scale from 20 Hz to 20 kHz, brightness as energy over a 90 dB range.
 * Faint horizontal lines mark SPECTROGRAM_GRID_HZ.
 */
export async function spectrogram(file, range = {}, width = 900, height = 360) {
  const audio = await loadAudio(file, range);
  const sr = audio.sampleRate;
  const x = monoMix(audio.channels);
  const n = 4096;
  const win = hann(n);
  const fLo = 20, fHi = Math.min(20000, sr / 2);
  const rowHz = (row) => fLo * Math.pow(fHi / fLo, (height - 1 - row) / (height - 1));

  const cols = [];
  let maxDb = -Infinity;
  for (let col = 0; col < width; col++) {
    const start = Math.floor((col / width) * Math.max(1, x.length - n));
    const p = powerSpectrum(x, start, n, win);
    const column = new Float64Array(height);
    for (let row = 0; row < height; row++) {
      // Average the bins that fall inside this row's slice of the log axis.
      const lo = rowHz(row + 0.5), hi = rowHz(row - 0.5);
      let k0 = Math.floor((lo * n) / sr), k1 = Math.ceil((hi * n) / sr);
      k0 = Math.max(1, Math.min(k0, p.length - 1));
      k1 = Math.max(k0, Math.min(k1, p.length - 1));
      let s = 0;
      for (let k = k0; k <= k1; k++) s += p[k];
      const v = 10 * Math.log10(s / (k1 - k0 + 1) + 1e-20);
      column[row] = v;
      if (v > maxDb) maxDb = v;
    }
    cols.push(column);
  }

  const rgb = new Uint8Array(width * height * 3);
  const gridRows = new Set(
    SPECTROGRAM_GRID_HZ.filter((f) => f < fHi).map((f) =>
      Math.round((height - 1) - ((height - 1) * Math.log(f / fLo)) / Math.log(fHi / fLo)),
    ),
  );
  for (let col = 0; col < width; col++) {
    for (let row = 0; row < height; row++) {
      let [r, g, b] = color((cols[col][row] - (maxDb - 90)) / 90);
      if (gridRows.has(row)) [r, g, b] = [Math.min(255, r + 60), Math.min(255, g + 60), Math.min(255, b + 60)];
      const o = (row * width + col) * 3;
      rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b;
    }
  }
  return {
    png: encodePng(width, height, rgb),
    seconds: x.length / sr,
  };
}
