// SteamID64 → Palworld dedicated-server player UID.
//
// Palworld derives the server-side player UID as:
//   hash = CityHash64(UTF-16LE bytes of the SteamID64 decimal string)
//   uid  = (low32(hash) + high32(hash) * 23) mod 2^32
// which is then rendered as the first 8 hex chars of the player GUID
// (rest zeros): "XXXXXXXX-0000-0000-0000-000000000000".
//
// CityHash64 port (BigInt) of Google's CityHash v1.1, matching the behavior
// used by UE's CityHash / cheahjs/palworld-steam-id-to-player-uid.

const M = (1n << 64n) - 1n;
const k0 = 0xc3a5c85c97cb3127n;
const k1 = 0xb492b66fbe98f273n;
const k2 = 0x9ae16a3b2f90404fn;

function rotate(v: bigint, s: number): bigint {
  if (s === 0) return v;
  const sb = BigInt(s);
  return ((v >> sb) | (v << (64n - sb))) & M;
}
function shiftMix(v: bigint): bigint {
  return (v ^ (v >> 47n)) & M;
}
function mul(a: bigint, b: bigint): bigint {
  return (a * b) & M;
}
function add(a: bigint, b: bigint): bigint {
  return (a + b) & M;
}

function fetch64(b: Uint8Array, i: number): bigint {
  let v = 0n;
  for (let j = 7; j >= 0; j--) v = (v << 8n) | BigInt(b[i + j]);
  return v;
}
function fetch32(b: Uint8Array, i: number): bigint {
  return BigInt(b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | ((b[i + 3] << 24) >>> 0)) & 0xffffffffn;
}

function hashLen16(u: bigint, v: bigint, m: bigint): bigint {
  let a = mul((u ^ v) & M, m);
  a ^= a >> 47n;
  let b = mul((v ^ a) & M, m);
  b ^= b >> 47n;
  return mul(b, m);
}

function hashLen0to16(s: Uint8Array, len: number): bigint {
  if (len >= 8) {
    const m = add(k2, BigInt(len * 2));
    const a = add(fetch64(s, 0), k2);
    const b = fetch64(s, len - 8);
    const c = add(mul(rotate(b, 37), m), a);
    const d = mul(add(rotate(a, 25), b), m);
    return hashLen16(c, d, m);
  }
  if (len >= 4) {
    const m = add(k2, BigInt(len * 2));
    const a = fetch32(s, 0);
    return hashLen16(BigInt(len) + ((a << 3n) & M), fetch32(s, len - 4), m);
  }
  if (len > 0) {
    const a = BigInt(s[0]);
    const b = BigInt(s[len >> 1]);
    const c = BigInt(s[len - 1]);
    const y = (a + (b << 8n)) & M;
    const z = (BigInt(len) + (c << 2n)) & M;
    return mul(shiftMix((mul(y, k2) ^ mul(z, k0)) & M), k2);
  }
  return k2;
}

function hashLen17to32(s: Uint8Array, len: number): bigint {
  const m = add(k2, BigInt(len * 2));
  const a = mul(fetch64(s, 0), k1);
  const b = fetch64(s, 8);
  const c = mul(fetch64(s, len - 8), m);
  const d = mul(fetch64(s, len - 16), k2);
  return hashLen16(
    add(add(rotate(add(a, b), 43), rotate(c, 30)), d),
    add(add(a, rotate(add(b, k2), 18)), c),
    m
  );
}

function weakHashLen32WithSeeds(
  w: bigint, x: bigint, y: bigint, z: bigint, a: bigint, b: bigint
): [bigint, bigint] {
  a = add(a, w);
  b = rotate(add(add(b, a), z), 21);
  const c = a;
  a = add(a, x);
  a = add(a, y);
  b = add(b, rotate(a, 44));
  return [add(a, z), add(b, c)];
}

function hashLen33to64(s: Uint8Array, len: number): bigint {
  const m = add(k2, BigInt(len * 2));
  let a = mul(fetch64(s, 0), k2);
  let b = fetch64(s, 8);
  const c = fetch64(s, len - 24);
  const d = fetch64(s, len - 32);
  const e = mul(fetch64(s, 16), k2);
  const f = mul(fetch64(s, 24), 9n);
  const g = fetch64(s, len - 8);
  const h = mul(fetch64(s, len - 16), m);

  const u = add(rotate(add(a, g), 43), mul(add(rotate(b, 30), c), 9n));
  const v = add(add((add(a, g) ^ d) & M, f), 1n);
  const w = add(swap64(mul(add(u, v), m)), h);
  const x = add(rotate(add(e, f), 42), c);
  const y = mul(add(swap64(mul(add(v, w), m)), g), m);
  const z = add(add(e, f), c);
  a = add(swap64(add(mul(add(x, z), m), y)), b);
  b = mul(shiftMix(add(add(mul(add(z, a), m), d), h)), m);
  return add(b, x);
}

function swap64(v: bigint): bigint {
  let out = 0n;
  for (let i = 0; i < 8; i++) {
    out = (out << 8n) | ((v >> BigInt(i * 8)) & 0xffn);
  }
  return out;
}

const kMul = 0x9ddfea08eb382d69n;

/** The classic 2-arg Hash128to64 fold used by CityHash64. */
function hash128to64(u: bigint, v: bigint): bigint {
  return hashLen16(u, v, kMul);
}

export function cityHash64(s: Uint8Array): bigint {
  const len = s.length;
  if (len <= 16) return hashLen0to16(s, len);
  if (len <= 32) return hashLen17to32(s, len);
  if (len <= 64) return hashLen33to64(s, len);

  let x = fetch64(s, len - 40);
  let y = add(fetch64(s, len - 16), fetch64(s, len - 56));
  let z = hash128to64(add(fetch64(s, len - 48), BigInt(len)), fetch64(s, len - 24));
  let v = weakHashLen32WithSeeds6(s, len - 64, BigInt(len), z);
  let w = weakHashLen32WithSeeds6(s, len - 32, add(y, k1), x);
  x = add(mul(x, k1), fetch64(s, 0));

  let offset = 0;
  let l = (len - 1) & ~63;
  do {
    x = mul(rotate(add(add(add(x, y), v[0]), fetch64(s, offset + 8)), 37), k1);
    y = mul(rotate(add(add(y, v[1]), fetch64(s, offset + 48)), 42), k1);
    x = (x ^ w[1]) & M;
    y = add(y, add(v[0], fetch64(s, offset + 40)));
    z = mul(rotate(add(z, w[0]), 33), k1);
    v = weakHashLen32WithSeeds6(s, offset, mul(v[1], k1), add(x, w[0]));
    w = weakHashLen32WithSeeds6(s, offset + 32, add(z, w[1]), add(y, fetch64(s, offset + 16)));
    const t = z; z = x; x = t;
    offset += 64;
    l -= 64;
  } while (l !== 0);

  return hash128to64(
    add(add(hash128to64(v[0], w[0]), mul(shiftMix(y), k1)), z),
    add(hash128to64(v[1], w[1]), x)
  );
}

function weakHashLen32WithSeeds6(s: Uint8Array, idx: number, a: bigint, b: bigint): [bigint, bigint] {
  return weakHashLen32WithSeeds(
    fetch64(s, idx), fetch64(s, idx + 8), fetch64(s, idx + 16), fetch64(s, idx + 24), a, b
  );
}

/** UTF-16LE bytes of a JS string. */
function utf16leBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i * 2] = c & 0xff;
    out[i * 2 + 1] = c >> 8;
  }
  return out;
}

/** Derive the dedicated-server player UID (u32) from a SteamID64 string. */
export function steamIdToPlayerUid(steamId64: string): number {
  const hash = cityHash64(utf16leBytes(steamId64));
  const low = Number(hash & 0xffffffffn);
  const high = Number((hash >> 32n) & 0xffffffffn);
  return ((low + high * 23) & 0xffffffff) >>> 0;
}

/** Derive the full server player GUID string from a SteamID64. */
export function steamIdToGuid(steamId64: string): string {
  const uid = steamIdToPlayerUid(steamId64);
  return `${uid.toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`;
}

/** Validate a SteamID64: exactly 17 digits, starting with 7656119. */
export function isValidSteamId64(s: string): boolean {
  return /^7656119\d{10}$/.test(s);
}
