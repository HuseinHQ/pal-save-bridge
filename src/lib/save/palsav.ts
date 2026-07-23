// Palworld .sav container codec.
//
// Header (little-endian):
//   [0..4)  uncompressed length
//   [4..8)  compressed length
//   [8..11) magic: "PlZ" (zlib) or "PlM" (Oodle Kraken, post-2026 Summer Update)
//   [11]    save type: 0x31 single compression, 0x32 double zlib
//   [12..]  compressed payload
// An optional "CNK" prefix shifts everything by 12 bytes.
//
// Oodle-compressed (PlM) saves are decompressed with ooz-wasm (a WASM build of
// the open-source ooz Kraken decompressor). Write-back always uses plain zlib
// (PlZ) — the game accepts zlib-compressed saves, so Oodle compression is
// never needed. (Same strategy as palworld-hostfix-toolkit / community tools.)

import { unzlibSync, zlibSync } from 'fflate';

export interface DecodedSav {
  /** Raw GVAS bytes. */
  gvas: Uint8Array;
  /** Save type byte from the header (0x31 / 0x32), reused on write-back. */
  saveType: number;
  /** Original magic ("PlZ" | "PlM"). */
  magic: string;
}

let oozModule: typeof import('ooz-wasm') | null = null;
async function getOoz() {
  if (!oozModule) oozModule = await import('ooz-wasm');
  return oozModule;
}

export function isSavCompressed(data: Uint8Array): boolean {
  const off = hasCnk(data) ? 12 : 0;
  const magic = String.fromCharCode(data[off + 8], data[off + 9], data[off + 10]);
  return magic === 'PlZ' || magic === 'PlM';
}

function hasCnk(data: Uint8Array): boolean {
  return data.length > 24 && data[0] === 0x43 && data[1] === 0x4e && data[2] === 0x4b;
}

function readU32(data: Uint8Array, off: number): number {
  return (data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24)) >>> 0;
}

export async function decompressSav(data: Uint8Array): Promise<DecodedSav> {
  let off = 0;
  if (hasCnk(data)) off = 12;
  const uncompressedLen = readU32(data, off);
  const compressedLen = readU32(data, off + 4);
  const magic = String.fromCharCode(data[off + 8], data[off + 9], data[off + 10]);
  const saveType = data[off + 11];
  const payload = data.subarray(off + 12);

  if (magic === 'PlM') {
    if (compressedLen !== payload.length) {
      throw new Error(`Corrupt save: compressed length mismatch (${compressedLen} != ${payload.length})`);
    }
    const ooz = await getOoz();
    // decompressUnsafe returns a view into the shared WASM heap that later
    // calls clobber — copy it out immediately.
    const out = new Uint8Array(await ooz.decompressUnsafe(payload, uncompressedLen));
    if (out.length !== uncompressedLen) {
      throw new Error(`Oodle decompression returned ${out.length}, expected ${uncompressedLen}`);
    }
    return { gvas: out, saveType, magic };
  }

  if (magic !== 'PlZ') {
    throw new Error(`Not a Palworld save (magic "${magic}")`);
  }
  if (saveType !== 0x31 && saveType !== 0x32) {
    throw new Error(`Unhandled save type 0x${saveType.toString(16)}`);
  }
  let out = unzlibSync(payload);
  if (saveType === 0x32) {
    if (compressedLen !== out.length) {
      throw new Error(`Corrupt save: inner compressed length mismatch`);
    }
    out = unzlibSync(out);
  }
  if (out.length !== uncompressedLen) {
    throw new Error(`Corrupt save: uncompressed length mismatch (${out.length} != ${uncompressedLen})`);
  }
  return { gvas: out, saveType, magic };
}

/** Compress GVAS bytes back into a .sav container (always zlib / PlZ). */
export function compressSav(gvas: Uint8Array, saveType: number): Uint8Array {
  const inner = zlibSync(gvas);
  const compressedLen = inner.length;
  const payload = saveType === 0x32 ? zlibSync(inner) : inner;

  const out = new Uint8Array(12 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, gvas.length, true);
  dv.setUint32(4, compressedLen, true);
  out[8] = 0x50; // P
  out[9] = 0x6c; // l
  out[10] = 0x5a; // Z
  out[11] = saveType;
  out.set(payload, 12);
  return out;
}
