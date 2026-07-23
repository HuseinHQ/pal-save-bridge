// Palworld / UE GUID helpers.
//
// On-disk GUIDs use Microsoft-style mixed-endian byte order: the canonical
// string "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE" is stored as four little-endian
// uint32 groups. See palworld_save_tools.archive.UUID for the reference layout.

/** Canonical zero GUID (used to key pal entries on dedicated servers). */
export const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

/** Hard-coded co-op host GUID. */
export const COOP_HOST_GUID = '00000000-0000-0000-0000-000000000001';

/** Normalize any 32-hex or dashed GUID string to dashed lowercase form. */
export function formatGuid(guid: string): string {
  const hex = guid.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`Invalid GUID: ${guid}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Compact 32-hex uppercase form, as used for Players/<GUID>.sav filenames. */
export function guidToFileName(guid: string): string {
  return guid.replace(/-/g, '').toUpperCase();
}

/** Convert a GUID string to its on-disk 16-byte representation. */
export function guidToBytes(guid: string): Uint8Array {
  const hex = guid.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`Invalid GUID: ${guid}`);
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  // Reorder: [3,2,1,0, 7,6,5,4, 11,10,9,8, 15,14,13,12]
  return new Uint8Array([
    b[3], b[2], b[1], b[0],
    b[7], b[6], b[5], b[4],
    b[11], b[10], b[9], b[8],
    b[15], b[14], b[13], b[12],
  ]);
}

/** Convert 16 on-disk bytes back to a dashed lowercase GUID string. */
export function bytesToGuid(raw: Uint8Array, offset = 0): string {
  const b = raw.subarray(offset, offset + 16);
  const hx = (n: number, w: number) => n.toString(16).padStart(w, '0');
  return (
    hx(((b[3] << 24) | (b[2] << 16) | (b[1] << 8) | b[0]) >>> 0, 8) +
    '-' + hx((b[7] << 8) | b[6], 4) +
    '-' + hx((b[5] << 8) | b[4], 4) +
    '-' + hx((b[11] << 8) | b[10], 4) +
    '-' + hx((b[9] << 8) | b[8], 4) + hx((((b[15] << 24) | (b[14] << 16) | (b[13] << 8) | b[12]) >>> 0), 8)
  );
}

export function guidEqualsAt(buf: Uint8Array, offset: number, guidBytes: Uint8Array): boolean {
  for (let i = 0; i < 16; i++) if (buf[offset + i] !== guidBytes[i]) return false;
  return true;
}

export function writeGuidAt(buf: Uint8Array, offset: number, guidBytes: Uint8Array): void {
  buf.set(guidBytes, offset);
}

/** Find all occurrences of a 16-byte pattern in a buffer. */
export function findAll(buf: Uint8Array, pattern: Uint8Array, start = 0, end = buf.length): number[] {
  const out: number[] = [];
  const n = pattern.length;
  const first = pattern[0];
  outer: for (let i = start; i <= end - n; i++) {
    if (buf[i] !== first) continue;
    for (let j = 1; j < n; j++) if (buf[i + j] !== pattern[j]) continue outer;
    out.push(i);
  }
  return out;
}
