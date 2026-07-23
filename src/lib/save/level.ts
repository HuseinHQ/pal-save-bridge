// Structure-aware access to the parts of Level.sav / Players/*.sav /
// LevelMeta.sav that the host-save fix needs. All edits are length-preserving
// in-place GUID patches on the decompressed GVAS buffer.
//
// The set of edits ports palworld-hostfix-toolkit's migrate scripts
// (fix_host_save / fix_pal_keys / fix_guild_handles / fix_container_slots /
// fix_orphaned_ownership) to the browser.

import { GvasReader, skipGvasHeader, walkProperties, type PropertyRecord } from './gvas';
import {
  bytesToGuid,
  guidToBytes,
  guidEqualsAt,
  findAll,
  ZERO_GUID,
} from './guid';

const ZERO_BYTES = guidToBytes(ZERO_GUID);

// ---------------------------------------------------------------------------
// Generic helpers

function findProp(props: PropertyRecord[], name: string): PropertyRecord {
  const p = props.find((p) => p.name === name);
  if (!p) throw new Error(`Property "${name}" not found (save format changed?)`);
  return p;
}

/** Walk the root property list of a GVAS buffer. */
function rootProps(gvas: Uint8Array): PropertyRecord[] {
  const r = new GvasReader(gvas);
  skipGvasHeader(r);
  return walkProperties(r);
}

/** Walk a StructProperty value that is itself a property list. */
function structProps(gvas: Uint8Array, rec: PropertyRecord): PropertyRecord[] {
  return walkProperties(new GvasReader(gvas, rec.valueStart));
}

/** Guid struct value offset within a property record (value is raw 16 bytes). */
function guidValueOffset(rec: PropertyRecord): number {
  if (rec.size !== 16) throw new Error(`Expected 16-byte Guid value for ${rec.name}, got ${rec.size}`);
  return rec.valueStart;
}

// ---------------------------------------------------------------------------
// CharacterSaveParameterMap

export interface CharacterEntry {
  /** Offset of the 16-byte key PlayerUId. */
  playerUidOffset: number;
  playerUid: string;
  /** Offset of the 16-byte key InstanceId. */
  instanceIdOffset: number;
  instanceId: string;
  isPlayer: boolean;
  nickName: string | null;
  level: number | null;
  /** [start, end) of the RawData byte blob (nested property stream). */
  rawStart: number;
  rawEnd: number;
  /** Offsets (absolute) of Guid values inside the nested SaveParameter blob. */
  ownerPlayerUidOffset: number | null;
  oldOwnerPlayerUidOffsets: number[];
}

interface WorldSections {
  characterMap: PropertyRecord;
  groupMap: PropertyRecord;
  containerData: PropertyRecord | null;
}

function worldSections(gvas: Uint8Array): WorldSections {
  const root = rootProps(gvas);
  const wsd = findProp(root, 'worldSaveData');
  const props = structProps(gvas, wsd);
  const containerData = props.find((p) => p.name === 'CharacterContainerSaveData') ?? null;
  return {
    characterMap: findProp(props, 'CharacterSaveParameterMap'),
    groupMap: findProp(props, 'GroupSaveDataMap'),
    containerData,
  };
}

/** Parse the entries of CharacterSaveParameterMap with exact byte offsets. */
function parseCharacterMap(gvas: Uint8Array, rec: PropertyRecord): CharacterEntry[] {
  const r = new GvasReader(gvas, rec.valueStart);
  r.u32(); // unknown (always 0)
  const count = r.u32();
  const entries: CharacterEntry[] = [];
  for (let i = 0; i < count; i++) {
    // Key: property list { PlayerUId: Struct(Guid), InstanceId: Struct(Guid) }
    const keyProps = walkProperties(r);
    const uidRec = findProp(keyProps, 'PlayerUId');
    const instRec = findProp(keyProps, 'InstanceId');
    const playerUidOffset = guidValueOffset(uidRec);
    const instanceIdOffset = guidValueOffset(instRec);

    // Value: property list { RawData: ArrayProperty(ByteProperty) }
    const valProps = walkProperties(r);
    const rawRec = findProp(valProps, 'RawData');
    if (rawRec.arrayType !== 'ByteProperty') throw new Error('CharacterSaveParameterMap RawData is not a byte array');
    // ArrayProperty(ByteProperty) payload: u32 count + bytes
    const rawCountReader = new GvasReader(gvas, rawRec.valueStart);
    const rawLen = rawCountReader.u32();
    const rawStart = rawRec.valueStart + 4;
    const rawEnd = rawStart + rawLen;
    if (rawEnd !== rawRec.valueEnd) throw new Error('CharacterSaveParameterMap RawData length mismatch');

    // Nested blob: property stream ("object" props) then trailing bytes we ignore.
    const nested = scanSaveParameter(gvas, rawStart, rawEnd);

    entries.push({
      playerUidOffset,
      playerUid: bytesToGuid(gvas, playerUidOffset),
      instanceIdOffset,
      instanceId: bytesToGuid(gvas, instanceIdOffset),
      ...nested,
      rawStart,
      rawEnd,
    });
  }
  return entries;
}

/** Scan the nested character blob for the SaveParameter fields we care about. */
function scanSaveParameter(
  gvas: Uint8Array,
  start: number,
  end: number
): Pick<CharacterEntry, 'isPlayer' | 'nickName' | 'level' | 'ownerPlayerUidOffset' | 'oldOwnerPlayerUidOffsets'> {
  const r = new GvasReader(gvas.subarray(0, end), start);
  const outer = walkProperties(r); // { SaveParameter: Struct } — then unknown trailing bytes
  const sp = findProp(outer, 'SaveParameter');
  const inner = walkProperties(new GvasReader(gvas.subarray(0, sp.valueEnd), sp.valueStart));

  let isPlayer = false;
  let nickName: string | null = null;
  let level: number | null = null;
  let ownerPlayerUidOffset: number | null = null;
  const oldOwnerPlayerUidOffsets: number[] = [];

  for (const p of inner) {
    if (p.name === 'IsPlayer' && p.type === 'BoolProperty') {
      // Bool value byte sits right after the size field; skipPropertyBody read
      // it — its offset is valueStart - (1 + optional-guid flag). Simpler:
      // re-read: value byte is the first byte after size, i.e. at recordStart
      // + name/type/size lengths. We captured valueStart AFTER the flag bytes,
      // so recover it by re-parsing the record header.
      const rr = new GvasReader(gvas, p.recordStart);
      rr.fstring(); // name
      rr.fstring(); // type
      rr.u64(); // size
      isPlayer = rr.u8() !== 0;
    } else if (p.name === 'NickName' && p.type === 'StrProperty') {
      nickName = new GvasReader(gvas, p.valueStart).fstring();
    } else if (p.name === 'Level' && (p.type === 'IntProperty' || p.type === 'ByteProperty')) {
      if (p.type === 'IntProperty') level = new GvasReader(gvas, p.valueStart).i32();
      else level = new GvasReader(gvas, p.valueStart).u8();
    } else if (p.name === 'OwnerPlayerUId' && p.type === 'StructProperty' && p.structType === 'Guid') {
      ownerPlayerUidOffset = guidValueOffset(p);
    } else if (p.name === 'OldOwnerPlayerUIds' && p.type === 'ArrayProperty') {
      // ArrayProperty(StructProperty) of Guids:
      // u32 count, prop_name fstr, prop_type fstr, u64 size, type_name fstr,
      // guid(16), u8, then count * 16-byte guids.
      const ar = new GvasReader(gvas, p.valueStart);
      const count = ar.u32();
      ar.fstring(); // prop name
      ar.fstring(); // prop type
      ar.u64();
      const typeName = ar.fstring();
      ar.skip(16 + 1);
      if (typeName === 'Guid') {
        for (let i = 0; i < count; i++) oldOwnerPlayerUidOffsets.push(ar.guidOffset());
      }
    }
  }
  return { isPlayer, nickName, level, ownerPlayerUidOffset, oldOwnerPlayerUidOffsets };
}

export function readCharacterEntries(gvas: Uint8Array): CharacterEntry[] {
  const { characterMap } = worldSections(gvas);
  return parseCharacterMap(gvas, characterMap);
}

// ---------------------------------------------------------------------------
// GroupSaveDataMap (guild blobs, kept raw/undecoded — patched byte-wise)

interface GroupEntry {
  groupType: string;
  /** [start, end) of the RawData byte blob. */
  rawStart: number;
  rawEnd: number;
}

function parseGroupMap(gvas: Uint8Array, rec: PropertyRecord): GroupEntry[] {
  const r = new GvasReader(gvas, rec.valueStart);
  r.u32();
  const count = r.u32();
  const out: GroupEntry[] = [];
  for (let i = 0; i < count; i++) {
    r.skip(16); // key: Guid
    const valProps = walkProperties(r);
    const typeRec = findProp(valProps, 'GroupType');
    // EnumProperty value: fstring at valueStart
    const groupType = new GvasReader(gvas, typeRec.valueStart).fstring();
    const rawRec = findProp(valProps, 'RawData');
    const lenReader = new GvasReader(gvas, rawRec.valueStart);
    const rawLen = lenReader.u32();
    out.push({ groupType, rawStart: rawRec.valueStart + 4, rawEnd: rawRec.valueStart + 4 + rawLen });
  }
  return out;
}

// ---------------------------------------------------------------------------
// CharacterContainerSaveData (per-slot player_uid)

interface SlotRaw {
  /** Offset of the slot RawData blob (starts with player_uid guid). */
  start: number;
  end: number;
}

function parseContainerSlots(gvas: Uint8Array, rec: PropertyRecord): SlotRaw[] {
  const r = new GvasReader(gvas, rec.valueStart);
  r.u32();
  const count = r.u32();
  const out: SlotRaw[] = [];
  for (let i = 0; i < count; i++) {
    walkProperties(r); // key: { ID: Struct(Guid) }
    const valProps = walkProperties(r);
    const slots = valProps.find((p) => p.name === 'Slots' && p.type === 'ArrayProperty');
    if (!slots) continue;
    // ArrayProperty(StructProperty): u32 count, prop_name, prop_type, u64,
    // type_name, guid, u8, then per-slot property lists.
    const ar = new GvasReader(gvas, slots.valueStart);
    const slotCount = ar.u32();
    ar.fstring();
    ar.fstring();
    ar.u64();
    ar.fstring(); // type_name (struct — property list)
    ar.skip(16 + 1);
    for (let s = 0; s < slotCount; s++) {
      const slotProps = walkProperties(ar);
      const raw = slotProps.find((p) => p.name === 'RawData');
      if (raw) {
        const lr = new GvasReader(gvas, raw.valueStart);
        const len = lr.u32();
        if (len >= 16) out.push({ start: raw.valueStart + 4, end: raw.valueStart + 4 + len });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API: read / patch operations

export interface PlayerInfo {
  playerUid: string;
  instanceId: string;
  nickName: string | null;
  level: number | null;
}

/** List the player characters recorded in Level.sav. */
export function listPlayers(levelGvas: Uint8Array): PlayerInfo[] {
  return readCharacterEntries(levelGvas)
    .filter((e) => e.isPlayer)
    .map((e) => ({
      playerUid: e.playerUid,
      instanceId: e.instanceId,
      nickName: e.nickName,
      level: e.level,
    }));
}

export interface LevelPatchStats {
  characterKeyUpdated: number;
  palsRekeyedToZero: number;
  ownerRetargeted: number;
  oldOwnerRetargeted: number;
  guildHandlesZeroed: number;
  guildGuidReplacements: number;
  containerSlotsPatched: number;
}

/**
 * Apply the full co-op → dedicated (or reverse) host fix to Level.sav in
 * place. `oldGuid` is the GUID currently in the save; `newGuid` is what it
 * becomes. `dedicatedTarget` selects the extra hardening layers required by
 * dedicated servers (pal re-keying to the zero GUID etc.).
 */
export function patchLevel(
  gvas: Uint8Array,
  oldGuid: string,
  newGuid: string,
  opts: { dedicatedTarget: boolean }
): LevelPatchStats {
  const oldBytes = guidToBytes(oldGuid);
  const newBytes = guidToBytes(newGuid);
  const stats: LevelPatchStats = {
    characterKeyUpdated: 0,
    palsRekeyedToZero: 0,
    ownerRetargeted: 0,
    oldOwnerRetargeted: 0,
    guildHandlesZeroed: 0,
    guildGuidReplacements: 0,
    containerSlotsPatched: 0,
  };

  const sections = worldSections(gvas);
  const entries = parseCharacterMap(gvas, sections.characterMap);
  const palInstanceIds: Uint8Array[] = [];

  for (const e of entries) {
    if (e.isPlayer) {
      // fix_host_save layer 0: re-key the migrating player's map entry.
      if (guidEqualsAt(gvas, e.playerUidOffset, oldBytes)) {
        gvas.set(newBytes, e.playerUidOffset);
        stats.characterKeyUpdated++;
      }
      continue;
    }
    palInstanceIds.push(gvas.slice(e.instanceIdOffset, e.instanceIdOffset + 16));
    if (opts.dedicatedTarget) {
      // fix_pal_keys layer 1: dedicated servers purge pals keyed to a nonzero
      // PlayerUId — re-key every pal entry to the zero GUID.
      if (!guidEqualsAt(gvas, e.playerUidOffset, ZERO_BYTES)) {
        gvas.set(ZERO_BYTES, e.playerUidOffset);
        stats.palsRekeyedToZero++;
      }
    }
    // fix_pal_keys layer 2: retarget internal ownership.
    if (e.ownerPlayerUidOffset !== null && guidEqualsAt(gvas, e.ownerPlayerUidOffset, oldBytes)) {
      gvas.set(newBytes, e.ownerPlayerUidOffset);
      stats.ownerRetargeted++;
    }
    for (const off of e.oldOwnerPlayerUidOffsets) {
      if (guidEqualsAt(gvas, off, oldBytes)) {
        gvas.set(newBytes, off);
        stats.oldOwnerRetargeted++;
      }
    }
  }

  // Guild blobs (raw/undecoded on current save versions). The old host GUID
  // is almost all zero bytes, so a blind byte-pattern replace would hit false
  // positives — instead we patch only structurally identified positions:
  //   1. membership handles: guid(16) + instance_id(16) pairs → locate by
  //      known instance ids (players get the migrating GUID, pals get zero);
  //   2. player-list entries: uid(16) + timestamp(8) + fstring(name) + flags
  //      → validate the entry shape before patching;
  //   3. admin_player_uid: the 16 bytes directly before the player-list count.
  const migratingInstance = entries.find(
    (e) => e.isPlayer && guidEqualsAt(gvas, e.playerUidOffset, newBytes)
  );
  const groups = parseGroupMap(gvas, sections.groupMap);
  for (const g of groups) {
    if (g.groupType !== 'EPalGroupType::Guild') continue;

    // (1) membership handles, located by instance id.
    const patchHandle = (inst: Uint8Array, replacement: Uint8Array, requireOld: Uint8Array | null) => {
      let patched = 0;
      for (const idx of findAll(gvas, inst, g.rawStart, g.rawEnd)) {
        const guidOff = idx - 16;
        if (guidOff < g.rawStart) continue;
        if (requireOld && !guidEqualsAt(gvas, guidOff, requireOld)) continue;
        if (guidEqualsAt(gvas, guidOff, replacement)) continue;
        gvas.set(replacement, guidOff);
        patched++;
      }
      return patched;
    };
    if (migratingInstance) {
      const inst = gvas.slice(migratingInstance.instanceIdOffset, migratingInstance.instanceIdOffset + 16);
      stats.guildGuidReplacements += patchHandle(inst, newBytes, oldBytes);
    }
    if (opts.dedicatedTarget) {
      // fix_guild_handles layer 3: each pal's membership handle must carry
      // the zero GUID or the guild dissolves and pals are purged on load.
      for (const inst of palInstanceIds) {
        stats.guildHandlesZeroed += patchHandle(inst, ZERO_BYTES, null);
      }
    }

    // (2)+(3) player list. Find validated player entries for all known player
    // uids, derive the list start, then patch the old uid's entry + admin uid.
    const entryOffsets: number[] = [];
    const findPlayerEntry = (uid: Uint8Array): number | null => {
      for (const idx of findAll(gvas, uid, g.rawStart, g.rawEnd)) {
        if (isPlayerListEntry(gvas, idx, g.rawEnd)) return idx;
      }
      return null;
    };
    for (const e of entries) {
      if (!e.isPlayer) continue;
      const uid = gvas.slice(e.playerUidOffset, e.playerUidOffset + 16);
      const off = findPlayerEntry(uid);
      if (off !== null) entryOffsets.push(off);
    }
    // The migrating player's list entry still carries the old uid.
    const oldEntry = findPlayerEntry(oldBytes);
    if (oldEntry !== null) {
      entryOffsets.push(oldEntry);
      gvas.set(newBytes, oldEntry);
      stats.guildGuidReplacements++;
    }
    if (entryOffsets.length > 0) {
      const listStart = Math.min(...entryOffsets);
      const adminOff = listStart - 4 - 16; // u32 count precedes; admin uid before that
      if (adminOff >= g.rawStart && guidEqualsAt(gvas, adminOff, oldBytes)) {
        gvas.set(newBytes, adminOff);
        stats.guildGuidReplacements++;
      }
    }
  }

  // fix_container_slots layer 4: per-slot player_uid must not point at a
  // player that doesn't exist on the target, or the slot is emptied.
  if (sections.containerData) {
    const slots = parseContainerSlots(gvas, sections.containerData);
    for (const s of slots) {
      if (guidEqualsAt(gvas, s.start, oldBytes)) {
        gvas.set(opts.dedicatedTarget ? ZERO_BYTES : newBytes, s.start);
        stats.containerSlotsPatched++;
      }
    }
  }

  return stats;
}

/**
 * Heuristic check that `off` is the start of a guild player-list entry:
 * uid(16) + FDateTime ticks (8, plausible range) + fstring name (len 1..64,
 * printable/UTF-16, nul-terminated).
 */
function isPlayerListEntry(gvas: Uint8Array, off: number, end: number): boolean {
  if (off + 16 + 8 + 4 > end) return false;
  const dv = new DataView(gvas.buffer, gvas.byteOffset);
  // FDateTime ticks: ~0x23xxxxxxxxxx in the 2020s; require high u32 in a sane
  // range (nonzero, < 2^30) to reject random data.
  const tsHigh = dv.getUint32(off + 20, true);
  if (tsHigh === 0 || tsHigh > 0x40000000) return false;
  const lenOff = off + 24;
  const len = dv.getInt32(lenOff, true);
  const isUtf16 = len < 0;
  const n = Math.abs(len);
  if (n < 1 || n > 64) return false;
  const strBytes = isUtf16 ? n * 2 : n;
  if (lenOff + 4 + strBytes > end) return false;
  // Must be nul-terminated.
  if (isUtf16) {
    if (gvas[lenOff + 4 + strBytes - 2] !== 0 || gvas[lenOff + 4 + strBytes - 1] !== 0) return false;
  } else {
    if (gvas[lenOff + 4 + strBytes - 1] !== 0) return false;
    for (let i = 0; i < n - 1; i++) {
      const c = gvas[lenOff + 4 + i];
      if (c < 0x20 || c === 0x7f) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Players/<GUID>.sav

export interface PlayerSavInfo {
  playerUid: string;
  instanceId: string;
}

function playerSaveDataProps(gvas: Uint8Array): PropertyRecord[] {
  const root = rootProps(gvas);
  const sd = findProp(root, 'SaveData');
  return structProps(gvas, sd);
}

export function readPlayerSav(gvas: Uint8Array): PlayerSavInfo {
  const props = playerSaveDataProps(gvas);
  const uid = findProp(props, 'PlayerUId');
  const individual = findProp(props, 'IndividualId');
  const indProps = structProps(gvas, individual);
  const inst = findProp(indProps, 'InstanceId');
  return {
    playerUid: bytesToGuid(gvas, guidValueOffset(uid)),
    instanceId: bytesToGuid(gvas, guidValueOffset(inst)),
  };
}

/** Rewrite PlayerUId + IndividualId.PlayerUId in a player save, in place. */
export function patchPlayerSav(gvas: Uint8Array, newGuid: string): number {
  const newBytes = guidToBytes(newGuid);
  const props = playerSaveDataProps(gvas);
  const uid = findProp(props, 'PlayerUId');
  const individual = findProp(props, 'IndividualId');
  const indProps = structProps(gvas, individual);
  const indUid = findProp(indProps, 'PlayerUId');
  gvas.set(newBytes, guidValueOffset(uid));
  gvas.set(newBytes, guidValueOffset(indUid));
  return 2;
}

// ---------------------------------------------------------------------------
// LevelMeta.sav

export interface LevelMetaInfo {
  worldName: string | null;
  hostPlayerName: string | null;
  inGameDay: number | null;
}

export function readLevelMeta(gvas: Uint8Array): LevelMetaInfo {
  const root = rootProps(gvas);
  const sd = root.find((p) => p.name === 'SaveData');
  if (!sd) return { worldName: null, hostPlayerName: null, inGameDay: null };
  const props = structProps(gvas, sd);
  const str = (name: string): string | null => {
    const p = props.find((x) => x.name === name && x.type === 'StrProperty');
    return p ? new GvasReader(gvas, p.valueStart).fstring() : null;
  };
  const int = (name: string): number | null => {
    const p = props.find((x) => x.name === name && x.type === 'IntProperty');
    return p ? new GvasReader(gvas, p.valueStart).i32() : null;
  };
  return {
    worldName: str('WorldName'),
    hostPlayerName: str('HostPlayerName'),
    inGameDay: int('InGameDay'),
  };
}
