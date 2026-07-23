// Minimal GVAS (UE5 SaveGame) walker for Palworld saves.
//
// This is NOT a full parser: property records carry explicit byte sizes, so we
// walk the property tree by name, skip everything we don't care about, and
// return exact byte offsets for the few structures the host-save fix touches.
// All edits done by the converter are length-preserving (16-byte GUID → 16-byte
// GUID), so patching happens in place on the decompressed buffer and the file
// is otherwise byte-for-byte identical.
//
// Reference implementation: palworld_save_tools.archive.FArchiveReader.

export class GvasReader {
  buf: Uint8Array;
  dv: DataView;
  pos: number;

  constructor(buf: Uint8Array, pos = 0) {
    this.buf = buf;
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = pos;
  }

  eof(): boolean {
    return this.pos >= this.buf.length;
  }

  u8(): number {
    return this.buf[this.pos++];
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  u32(): number {
    const v = this.dv.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  i32(): number {
    const v = this.dv.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  u64(): number {
    const v = this.dv.getBigUint64(this.pos, true);
    this.pos += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('u64 too large');
    return Number(v);
  }
  skip(n: number): void {
    this.pos += n;
    if (this.pos > this.buf.length) throw new Error('GVAS read past end of buffer');
  }

  fstring(): string {
    const size = this.i32();
    if (size === 0) return '';
    if (size < 0) {
      const n = -size;
      const bytes = this.buf.subarray(this.pos, this.pos + n * 2 - 2);
      this.pos += n * 2;
      let s = '';
      for (let i = 0; i < bytes.length; i += 2) s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
      return s;
    }
    const bytes = this.buf.subarray(this.pos, this.pos + size - 1);
    this.pos += size;
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  /** Skip an optional GUID (1-byte flag + 16 bytes if set). */
  optionalGuid(): void {
    if (this.u8()) this.skip(16);
  }

  /** Offset of a 16-byte GUID value; advances past it. */
  guidOffset(): number {
    const off = this.pos;
    this.skip(16);
    return off;
  }

  /**
   * Read one property record header (after its name has been read) and return
   * the [start, end) range of its value payload, leaving pos at `end`.
   * `typeName` must already be consumed by the caller? No — caller reads name,
   * we read type + size + type-specific header here.
   */
  skipPropertyBody(typeName: string, size: number): { valueStart: number; valueEnd: number } {
    switch (typeName) {
      case 'StructProperty':
        this.fstring(); // struct_type
        this.skip(16); // struct_id
        this.optionalGuid();
        break;
      case 'ArrayProperty':
        this.fstring(); // array_type
        this.optionalGuid();
        break;
      case 'MapProperty':
        this.fstring(); // key_type
        this.fstring(); // value_type
        this.optionalGuid();
        break;
      case 'EnumProperty':
      case 'ByteProperty':
        this.fstring(); // enum type
        this.optionalGuid();
        break;
      case 'BoolProperty':
        // value byte is NOT covered by size
        this.skip(1);
        this.optionalGuid();
        return { valueStart: this.pos, valueEnd: this.pos + size };
      default:
        this.optionalGuid();
        break;
    }
    const valueStart = this.pos;
    this.skip(size);
    return { valueStart, valueEnd: this.pos };
  }
}

export interface PropertyRecord {
  name: string;
  type: string;
  size: number;
  /** Offset where the record starts (at the name fstring). */
  recordStart: number;
  /** [valueStart, valueEnd) of the value payload. */
  valueStart: number;
  valueEnd: number;
  /** For Struct/Array/Enum headers, extra info. */
  structType?: string;
  arrayType?: string;
}

/**
 * Walk a property list (as produced by properties_until_end) starting at
 * `reader.pos`, returning records for each property. Stops at the "None"
 * terminator; reader ends positioned just after it.
 */
export function walkProperties(reader: GvasReader): PropertyRecord[] {
  const out: PropertyRecord[] = [];
  for (;;) {
    const recordStart = reader.pos;
    const name = reader.fstring();
    if (name === 'None') break;
    const type = reader.fstring();
    const size = reader.u64();

    // Capture type-specific header info before skipping.
    let structType: string | undefined;
    let arrayType: string | undefined;
    let valueStart: number, valueEnd: number;
    switch (type) {
      case 'StructProperty': {
        structType = reader.fstring();
        reader.skip(16);
        reader.optionalGuid();
        valueStart = reader.pos;
        reader.skip(size);
        valueEnd = reader.pos;
        break;
      }
      case 'ArrayProperty': {
        arrayType = reader.fstring();
        reader.optionalGuid();
        valueStart = reader.pos;
        reader.skip(size);
        valueEnd = reader.pos;
        break;
      }
      default: {
        const r = reader.skipPropertyBody(type, size);
        valueStart = r.valueStart;
        valueEnd = r.valueEnd;
      }
    }
    out.push({ name, type, size, recordStart, valueStart, valueEnd, structType, arrayType });
  }
  return out;
}

/**
 * Parse the GVAS file header and return the offset where the root property
 * list starts. Layout mirrors palworld_save_tools.gvas.GvasHeader.
 */
export function skipGvasHeader(reader: GvasReader): void {
  const magic = reader.u32();
  if (magic !== 0x53415647) throw new Error('Not a GVAS file');
  const saveGameVersion = reader.u32();
  reader.u32(); // package_file_version_ue4
  reader.u32(); // package_file_version_ue5
  reader.skip(2 + 2 + 2); // engine version major/minor/patch (u16 x3)
  reader.u32(); // engine changelist... actually u32 changelist
  reader.fstring(); // engine branch
  const customVersionFormat = reader.u32();
  if (customVersionFormat !== 3) throw new Error(`Unsupported custom version format ${customVersionFormat}`);
  const count = reader.u32();
  for (let i = 0; i < count; i++) {
    reader.skip(16); // guid
    reader.u32(); // version
  }
  reader.fstring(); // save_game_class_name
  void saveGameVersion;
}
