// High-level converter: scans an uploaded SaveGames folder for worlds,
// lists candidate host characters, and performs the full co-op ↔ dedicated
// conversion producing a ZIP of the converted world folder.
//
// Everything runs client-side; File objects come from a directory drop /
// webkitdirectory input.

import { zipSync, type Zippable } from 'fflate';
import { decompressSav, compressSav, isSavCompressed } from './palsav';
import { listPlayers, patchLevel, patchPlayerSav, readLevelMeta, readPlayerSav, type LevelPatchStats } from './level';
import { COOP_HOST_GUID, formatGuid, guidToFileName } from './guid';
import { steamIdToGuid } from './steamid';

export type Direction = 'co2ded' | 'ded2co';

export interface UploadedFile {
  /** Path relative to the dropped root, using "/" separators. */
  path: string;
  file: File;
}

export interface WorldInfo {
  id: string;
  /** Folder path of the world inside the upload (prefix for its files). */
  root: string;
  name: string;
  hostPlayerName: string | null;
  sizeBytes: number;
  playerFileCount: number;
}

export interface CharacterInfo {
  playerUid: string;
  nickName: string | null;
  level: number | null;
  isCoopHost: boolean;
}

const WORLD_ID_RE = /^[0-9A-F]{32}$/i;

/** Recursively collect files from a DataTransfer (folder drop). */
export async function filesFromDataTransfer(items: DataTransferItemList): Promise<UploadedFile[]> {
  const out: UploadedFile[] = [];
  const walkers: Promise<void>[] = [];
  for (const item of Array.from(items)) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) walkers.push(walkEntry(entry, '', out));
    else {
      const f = item.getAsFile();
      if (f) out.push({ path: f.name, file: f });
    }
  }
  await Promise.all(walkers);
  return out;
}

function walkEntry(entry: FileSystemEntry, prefix: string, out: UploadedFile[]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (entry.isFile) {
      (entry as FileSystemFileEntry).file((f) => {
        out.push({ path: prefix + entry.name, file: f });
        resolve();
      }, reject);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const all: Promise<void>[] = [];
      const readBatch = () => {
        reader.readEntries((entries) => {
          if (entries.length === 0) {
            Promise.all(all).then(() => resolve(), reject);
            return;
          }
          for (const e of entries) all.push(walkEntry(e, prefix + entry.name + '/', out));
          readBatch();
        }, reject);
      };
      readBatch();
    } else {
      resolve();
    }
  });
}

/** Convert a FileList from a webkitdirectory input. */
export function filesFromInput(list: FileList): UploadedFile[] {
  return Array.from(list).map((f) => ({
    path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
    file: f,
  }));
}

/**
 * Find world folders in the upload: any directory containing a Level.sav
 * whose name looks like a 32-hex world id (or that simply has Level.sav).
 * Backup subfolders are ignored.
 */
export async function scanWorlds(files: UploadedFile[]): Promise<WorldInfo[]> {
  const byWorld = new Map<string, UploadedFile[]>();
  for (const f of files) {
    const parts = f.path.split('/');
    const idx = parts.findIndex((p) => p.toLowerCase() === 'level.sav');
    if (idx < 0) continue;
    if (parts.some((p) => p.toLowerCase() === 'backup')) continue;
    const root = parts.slice(0, idx).join('/');
    if (!byWorld.has(root)) byWorld.set(root, []);
  }
  // Group all non-backup files under each world root.
  for (const f of files) {
    if (f.path.split('/').some((p) => p.toLowerCase() === 'backup')) continue;
    for (const root of byWorld.keys()) {
      if (root === '' || f.path === root || f.path.startsWith(root + '/')) {
        byWorld.get(root)!.push(f);
      }
    }
  }

  const worlds: WorldInfo[] = [];
  for (const [root, group] of byWorld) {
    const folderName = root.split('/').pop() ?? root;
    const id = WORLD_ID_RE.test(folderName) ? folderName.toUpperCase() : root || 'world';
    let name: string | null = null;
    let hostPlayerName: string | null = null;
    const metaFile = group.find((f) => stripRoot(f.path, root).toLowerCase() === 'levelmeta.sav');
    if (metaFile) {
      try {
        const data = new Uint8Array(await metaFile.file.arrayBuffer());
        if (isSavCompressed(data)) {
          const meta = readLevelMeta((await decompressSav(data)).gvas);
          name = meta.worldName;
          hostPlayerName = meta.hostPlayerName;
        }
      } catch {
        // Meta is optional — fall back to the folder name.
      }
    }
    worlds.push({
      id,
      root,
      name: name || folderName,
      hostPlayerName,
      sizeBytes: group.reduce((n, f) => n + f.file.size, 0),
      playerFileCount: group.filter((f) => /^players\//i.test(stripRoot(f.path, root))).length,
    });
  }
  worlds.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return worlds;
}

function stripRoot(path: string, root: string): string {
  return root === '' ? path : path.slice(root.length + 1);
}

/** List characters (from Level.sav) for a selected world. */
export async function scanCharacters(files: UploadedFile[], world: WorldInfo): Promise<CharacterInfo[]> {
  const levelFile = files.find((f) => stripRoot(f.path, world.root).toLowerCase() === 'level.sav');
  if (!levelFile) throw new Error('Level.sav not found in the selected world');
  const { gvas } = await decompressSav(new Uint8Array(await levelFile.file.arrayBuffer()));
  return listPlayers(gvas).map((p) => ({
    playerUid: p.playerUid,
    nickName: p.nickName,
    level: p.level,
    isCoopHost: p.playerUid === COOP_HOST_GUID,
  }));
}

export interface ConvertOptions {
  direction: Direction;
  files: UploadedFile[];
  world: WorldInfo;
  /** GUID of the character being migrated (its current GUID in the save). */
  characterUid: string;
  /** co2ded only: SteamID64 (17 digits) or a raw 32-hex GUID for consoles. */
  steamIdOrGuid?: string;
  onProgress?: (percent: number, label: string) => void;
}

export interface ConvertResult {
  zip: Blob;
  fileName: string;
  filesRewritten: number;
  stats: LevelPatchStats;
  newGuid: string;
}

export async function convert(opts: ConvertOptions): Promise<ConvertResult> {
  const { direction, files, world, onProgress } = opts;
  const progress = (p: number, label: string) => onProgress?.(Math.round(p), label);

  const oldGuid = formatGuid(opts.characterUid);
  let newGuid: string;
  if (direction === 'co2ded') {
    const input = (opts.steamIdOrGuid ?? '').trim();
    if (/^\d{17}$/.test(input)) newGuid = steamIdToGuid(input);
    else newGuid = formatGuid(input); // raw GUID path (Xbox/PS/crossplay)
  } else {
    newGuid = COOP_HOST_GUID;
  }
  if (newGuid === oldGuid) {
    throw new Error('The save already uses the target GUID — nothing to convert.');
  }

  progress(2, 'Unpacking save files…');

  const worldFiles = files.filter(
    (f) =>
      (world.root === '' || f.path === world.root || f.path.startsWith(world.root + '/')) &&
      !f.path.split('/').some((p) => p.toLowerCase() === 'backup')
  );

  const rel = (f: UploadedFile) => stripRoot(f.path, world.root);
  const levelFile = worldFiles.find((f) => rel(f).toLowerCase() === 'level.sav');
  if (!levelFile) throw new Error('Level.sav not found in the selected world');

  const oldPlayerFileName = `Players/${guidToFileName(oldGuid)}.sav`;
  const playerFile = worldFiles.find((f) => rel(f).toLowerCase() === oldPlayerFileName.toLowerCase());
  if (!playerFile) {
    throw new Error(`Player save ${oldPlayerFileName} not found in the selected world`);
  }

  // --- Level.sav ---
  progress(10, 'Unpacking save files…');
  const level = await decompressSav(new Uint8Array(await levelFile.file.arrayBuffer()));
  progress(30, 'Rewriting player GUIDs…');
  const stats = patchLevel(level.gvas, oldGuid, newGuid, {
    dedicatedTarget: direction === 'co2ded',
  });
  if (stats.characterKeyUpdated === 0) {
    throw new Error('Selected character was not found in Level.sav — is this the right world?');
  }

  // --- Player sav ---
  progress(45, 'Rewriting player GUIDs…');
  const player = await decompressSav(new Uint8Array(await playerFile.file.arrayBuffer()));
  const before = readPlayerSav(player.gvas);
  if (formatGuid(before.playerUid) !== oldGuid) {
    throw new Error(`Player save GUID mismatch (${before.playerUid})`);
  }
  patchPlayerSav(player.gvas, newGuid);

  // --- Repack ---
  progress(60, 'Repacking archive…');
  const zipEntries: Zippable = {};
  const outFolder = world.id;
  let filesRewritten = 0;

  zipEntries[`${outFolder}/Level.sav`] = [compressSav(level.gvas, level.saveType), { level: 0 }];
  filesRewritten++;
  zipEntries[`${outFolder}/Players/${guidToFileName(newGuid)}.sav`] = [
    compressSav(player.gvas, player.saveType),
    { level: 0 },
  ];
  filesRewritten++;

  // Copy everything else through untouched. co2ded drops WorldOption.sav so
  // the dedicated server's own settings apply (community-standard step); the
  // renamed player file replaces the old one.
  let copied = 0;
  const others = worldFiles.filter((f) => {
    const r = rel(f).toLowerCase();
    if (r === 'level.sav') return false;
    if (r === oldPlayerFileName.toLowerCase()) return false;
    if (r === `players/${guidToFileName(newGuid).toLowerCase()}.sav`) return false;
    if (direction === 'co2ded' && r === 'worldoption.sav') return false;
    return true;
  });
  for (const f of others) {
    zipEntries[`${outFolder}/${rel(f)}`] = [new Uint8Array(await f.file.arrayBuffer()), { level: 0 }];
    copied++;
    progress(60 + (copied / Math.max(1, others.length)) * 30, 'Repacking archive…');
  }

  progress(95, 'Almost done…');
  const zipped = zipSync(zipEntries);
  const zipBuf = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
  const zip = new Blob([zipBuf], { type: 'application/zip' });
  const safeName = (world.name || world.id).replace(/[^\w.-]+/g, '_');
  progress(100, 'Almost done…');

  return { zip, fileName: `${safeName}_${direction === 'co2ded' ? 'dedicated' : 'coop'}.zip`, filesRewritten, stats, newGuid };
}
