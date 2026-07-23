# Pal Save Bridge

Client-side Palworld save converter: moves a world between **co-op (local)** and
**dedicated server** formats by rewriting the player GUID (the "host save fix").
No backend — all parsing, GUID rewriting, and zipping happen in the browser.

Built from the design handoff in `../reference_design.dc.html` / `../README.md`,
with the mock conversion logic replaced by a real implementation.

## Stack

- **Astro** (static output) for the shell (hero, how-it-works, trust note, FAQ, footer)
- **React island** (`client:load`) for the converter widget only
- **Tailwind CSS v4** with the design tokens from the handoff as `@theme` variables
- **fflate** for zlib (PlZ save compression) + ZIP packing
- **ooz-wasm** for Oodle Kraken decompression (PlM1 saves)

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # static output in dist/
```

## Save format support

Palworld saves after the 2026 Summer Update use Oodle compression
(magic `PlM1`); older saves use zlib (`PlZ`, save types 0x31/0x32). Both are
read; write-back always uses zlib (`PlZ`) which the game accepts
(same strategy as the community `palworld-hostfix-toolkit`).

## Conversion logic (`src/lib/save/`)

The GUID rewrite ports the battle-tested
[palworld-hostfix-toolkit](https://github.com/quadrantbs/palworld-hostfix-toolkit)
migrate scripts to TypeScript. Instead of a full GVAS parse, a minimal walker
(`gvas.ts`) locates the exact byte offsets of the structures involved, and all
edits are length-preserving in-place 16-byte GUID patches (`level.ts`):

| Layer | Edit |
|---|---|
| 0 | `Players/<GUID>.sav`: `SaveData.PlayerUId` + `IndividualId.PlayerUId`, file renamed |
| 0 | `Level.sav` `CharacterSaveParameterMap`: migrating player's key `PlayerUId` |
| 1 | (→ dedicated) every pal entry re-keyed to the zero GUID (server purges pals keyed to a nonzero `PlayerUId`) |
| 2 | pal `OwnerPlayerUId` / `OldOwnerPlayerUIds` retargeted old → new |
| 3 | (→ dedicated) guild membership handles for pals zeroed (located by instance-id, not blind byte replace) |
| 3 | guild admin uid + player-list entry + player handle patched (structurally validated positions) |
| 4 | `CharacterContainerSaveData` per-slot `player_uid` fixed |

- co-op → dedicated derives the server GUID from a **SteamID64** via
  CityHash64(UTF-16) folded to 32 bits (`steamid.ts`, verified against the
  reference `cheahjs/palworld-steam-id-to-player-uid` algorithm), or accepts a
  raw GUID for Xbox/PlayStation/crossplay. `WorldOption.sav` is dropped from
  the output (standard step for server upload).
- dedicated → co-op resets the chosen character to
  `00000000-...-000000000001`.
- `backup/` folders in the upload are ignored; all other world files are
  copied through untouched into the ZIP.

## Verification

The pipeline was validated against the real sample save in
`../278351BD4328870114BC00952CAD89A1`:

- decompression matches `palworld-save-tools` (patched, Oodle-capable) output
- after conversion, the patched `Level.sav` / player sav re-parse cleanly with
  the Python reference tools and show exactly the target state (map keys,
  owners, guild handles, container slots)
- round trip co-op → dedicated → co-op restores the host GUID
- Playwright end-to-end drives the full UI flow (folder upload → world/character
  selection → SteamID → convert → ZIP download) on both dev and static builds
