import { useCallback, useRef, useState } from 'react';
import {
  convert,
  filesFromDataTransfer,
  filesFromInput,
  scanCharacters,
  scanWorlds,
  type CharacterInfo,
  type Direction,
  type UploadedFile,
  type WorldInfo,
} from '../lib/save/converter';
import { isValidSteamId64 } from '../lib/save/steamid';

type Status = 'idle' | 'converting' | 'done' | 'error';

interface State {
  step: number;
  direction: Direction | null;
  files: UploadedFile[] | null;
  scanning: boolean;
  worlds: WorldInfo[];
  selectedWorldId: string | null;
  characters: CharacterInfo[];
  charactersLoading: boolean;
  selectedCharacterUid: string | null;
  steamId: string;
  status: Status;
  progress: number;
  progressLabel: string;
  result: { zip: Blob; fileName: string; filesRewritten: number } | null;
  error: string | null;
}

const initialState: State = {
  step: 1,
  direction: null,
  files: null,
  scanning: false,
  worlds: [],
  selectedWorldId: null,
  characters: [],
  charactersLoading: false,
  selectedCharacterUid: null,
  steamId: '',
  status: 'idle',
  progress: 0,
  progressLabel: 'Unpacking save files…',
  result: null,
  error: null,
};

function formatMB(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

function shortUid(uid: string): string {
  const hex = uid.replace(/-/g, '');
  return `GUID ${hex.slice(0, 8)}…${hex.slice(-4)}`;
}

export default function Converter() {
  const [s, setS] = useState<State>(initialState);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isCoToDed = (s.direction ?? 'co2ded') === 'co2ded';
  const labels = isCoToDed
    ? ['Direction', 'Upload Save', 'World & Character', 'SteamID64', 'Convert']
    : ['Direction', 'Upload Save', 'Select World', 'Convert'];
  const totalSteps = labels.length;
  const steamStepIndex = isCoToDed ? 4 : -1;
  const finalStepIndex = totalSteps;

  const selectedWorld = s.worlds.find((w) => w.id === s.selectedWorldId) ?? null;
  const selectedCharacter = s.characters.find((c) => c.playerUid === s.selectedCharacterUid) ?? null;

  // --- validation ---
  const steamTrim = s.steamId.trim();
  const isRawGuid = /^[0-9a-fA-F]{32}$/.test(steamTrim.replace(/-/g, '')) && !/^\d+$/.test(steamTrim);
  const steamIdValid = isValidSteamId64(steamTrim) || isRawGuid;
  const worldChosenValid = isCoToDed ? !!(selectedWorld && selectedCharacter) : !!selectedWorld;

  // --- actions ---
  const goTo = (step: number) => setS((p) => ({ ...p, step }));
  const goNext = () => setS((p) => ({ ...p, step: p.step + 1 }));
  const goBack = () => setS((p) => ({ ...p, step: Math.max(1, p.step - 1) }));

  const selectDirection = (dir: Direction) =>
    setS((p) => ({
      ...p,
      direction: dir,
      selectedWorldId: null,
      selectedCharacterUid: null,
      characters: [],
      steamId: '',
    }));

  const ingestFiles = useCallback(async (files: UploadedFile[]) => {
    setS((p) => ({ ...p, scanning: true, error: null }));
    try {
      const worlds = await scanWorlds(files);
      if (worlds.length === 0) {
        setS((p) => ({
          ...p,
          scanning: false,
          files: null,
          worlds: [],
          error: 'No Palworld worlds found — the folder should contain a Level.sav.',
        }));
        return;
      }
      setS((p) => ({
        ...p,
        scanning: false,
        files,
        worlds,
        selectedWorldId: null,
        selectedCharacterUid: null,
        characters: [],
        error: null,
      }));
    } catch (e) {
      setS((p) => ({ ...p, scanning: false, error: e instanceof Error ? e.message : String(e) }));
    }
  }, []);

  const onDrop = useCallback(
    async (ev: React.DragEvent) => {
      ev.preventDefault();
      setDragOver(false);
      const files = await filesFromDataTransfer(ev.dataTransfer.items);
      await ingestFiles(files);
    },
    [ingestFiles]
  );

  const onPickFiles = useCallback(
    async (ev: React.ChangeEvent<HTMLInputElement>) => {
      if (ev.target.files && ev.target.files.length > 0) {
        await ingestFiles(filesFromInput(ev.target.files));
      }
      ev.target.value = '';
    },
    [ingestFiles]
  );

  const selectWorld = useCallback(
    async (world: WorldInfo) => {
      setS((p) => ({
        ...p,
        selectedWorldId: world.id,
        selectedCharacterUid: null,
        characters: [],
        charactersLoading: true,
        error: null,
      }));
      try {
        const chars = s.files ? await scanCharacters(s.files, world) : [];
        setS((p) =>
          p.selectedWorldId === world.id
            ? {
                ...p,
                characters: chars,
                charactersLoading: false,
                // ded2co: preselect the (single) non-host character if unambiguous
                selectedCharacterUid:
                  p.direction === 'ded2co' && chars.length > 0
                    ? (chars.find((c) => !c.isCoopHost) ?? chars[0]).playerUid
                    : null,
              }
            : p
        );
      } catch (e) {
        setS((p) => ({
          ...p,
          charactersLoading: false,
          error: e instanceof Error ? e.message : String(e),
        }));
      }
    },
    [s.files]
  );

  const startConvert = useCallback(async () => {
    if (!s.files || !selectedWorld || !s.direction) return;
    const characterUid =
      s.selectedCharacterUid ??
      (s.characters.find((c) => !c.isCoopHost) ?? s.characters[0])?.playerUid;
    if (!characterUid) {
      setS((p) => ({ ...p, status: 'error', error: 'No character found in this world.' }));
      return;
    }
    setS((p) => ({ ...p, status: 'converting', progress: 0, progressLabel: 'Unpacking save files…', error: null }));
    try {
      const result = await convert({
        direction: s.direction,
        files: s.files,
        world: selectedWorld,
        characterUid,
        steamIdOrGuid: s.steamId.trim(),
        onProgress: (progress, progressLabel) => setS((p) => ({ ...p, progress, progressLabel })),
      });
      setS((p) => ({ ...p, status: 'done', progress: 100, result }));
    } catch (e) {
      setS((p) => ({
        ...p,
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  }, [s.files, s.direction, s.steamId, s.selectedCharacterUid, s.characters, selectedWorld]);

  const downloadZip = useCallback(() => {
    if (!s.result) return;
    const url = URL.createObjectURL(s.result.zip);
    const a = document.createElement('a');
    a.href = url;
    a.download = s.result.fileName;
    a.click();
    URL.revokeObjectURL(url);
  }, [s.result]);

  const restart = () => setS(initialState);

  // --- shared bits ---
  const nextBtn =
    'bg-accent text-accent-dark border-none px-[26px] py-3 font-bold text-sm rounded-lg cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-shadow hover:enabled:shadow-[0_0_24px_oklch(0.72_0.16_250/0.55)]';
  const backBtn =
    'bg-transparent text-fg border border-border px-[22px] py-3 font-semibold text-sm rounded-lg cursor-pointer hover:bg-chip transition-colors';
  const rowBtn = (selected: boolean) =>
    `w-full text-left rounded-[10px] px-4 py-3.5 text-sm font-semibold cursor-pointer flex justify-between items-center border transition-colors ${
      selected
        ? 'bg-[oklch(0.72_0.16_250/0.12)] border-accent'
        : 'bg-bg border-border hover:border-[oklch(0.45_0.02_260)]'
    }`;

  const steamIdBorder =
    steamTrim.length === 0 ? 'border-border' : steamIdValid ? 'border-success' : 'border-error';
  const steamIdHint =
    steamTrim.length === 0
      ? '17-digit SteamID64 — or paste a raw GUID for Xbox / PlayStation / crossplay'
      : steamIdValid
        ? 'Looks good'
        : /^\d*$/.test(steamTrim)
          ? `${steamTrim.length}/17 digits${steamTrim.length === 17 ? ' — must start with 7656119' : ''}`
          : 'Not a valid SteamID64 or GUID';
  const steamIdHintColor =
    steamTrim.length === 0 ? 'text-muted' : steamIdValid ? 'text-success' : 'text-error';

  const summaryText = isCoToDed
    ? `Converting "${selectedWorld?.name ?? '—'}" for ${selectedCharacter?.nickName ?? '—'}. Host GUID will be rewritten to your Steam ID, and WorldOption.sav will be dropped for server upload.`
    : `Converting "${selectedWorld?.name ?? '—'}" back to a co-op world. ${
        selectedCharacter?.nickName ? `${selectedCharacter.nickName}'s` : "Your character's"
      } GUID will be reset to the co-op host ID.`;

  const converting = s.status === 'converting';
  const done = s.status === 'done';

  return (
    <div className="bg-surface border border-border rounded-2xl p-9 shadow-[0_20px_60px_rgba(0,0,0,0.35)]">
      {/* Step indicator */}
      <div className="flex items-start mb-9">
        {labels.map((label, idx) => {
          const n = idx + 1;
          const active = s.step === n;
          const completed = s.step > n;
          const reachable = n <= s.step && !converting;
          return (
            <div key={label} className="flex items-center flex-1">
              <div
                className={`flex flex-col items-center min-w-0 ${reachable ? 'cursor-pointer' : 'cursor-default'}`}
                onClick={() => reachable && goTo(n)}
              >
                <div
                  className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm mb-2 border-2 ${
                    active
                      ? 'border-accent bg-[oklch(0.72_0.16_250/0.15)] text-accent'
                      : completed
                        ? 'border-success bg-[oklch(0.76_0.15_150/0.15)] text-success'
                        : 'border-border text-muted'
                  }`}
                >
                  {completed ? '✓' : n}
                </div>
                <span
                  className={`text-[11px] text-center max-w-20 ${active ? 'text-fg font-semibold' : 'text-muted font-normal'}`}
                >
                  {label}
                </span>
              </div>
              {n < totalSteps && (
                <div className={`flex-1 h-0.5 mx-1.5 mb-[22px] ${completed ? 'bg-success' : 'bg-border'}`} />
              )}
            </div>
          );
        })}
      </div>

      {s.error && s.status !== 'error' && (
        <div className="mb-6 text-sm text-error border border-[oklch(0.7_0.18_30/0.4)] bg-[oklch(0.7_0.18_30/0.08)] rounded-lg px-4 py-3">
          {s.error}
        </div>
      )}

      {/* Step 1 — direction */}
      {s.step === 1 && (
        <div>
          <h2 className="text-[22px] font-bold m-0 mb-1.5">Choose a direction</h2>
          <p className="text-sm text-muted m-0 mb-6">Which way are you moving your world?</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {(
              [
                {
                  dir: 'co2ded' as const,
                  glyph: '→',
                  title: 'Co-op → Dedicated',
                  desc: "Move a local co-op world to a dedicated server. Rewrites the host's GUID to your Steam ID.",
                },
                {
                  dir: 'ded2co' as const,
                  glyph: '←',
                  title: 'Dedicated → Co-op',
                  desc: 'Pull a server world back to local play. Resets the character GUID to the co-op host ID.',
                },
              ]
            ).map((c) => (
              <button
                key={c.dir}
                onClick={() => selectDirection(c.dir)}
                className={`text-left bg-bg rounded-xl p-[22px] cursor-pointer text-fg transition-[border-color] duration-150 border-2 ${
                  s.direction === c.dir
                    ? 'border-accent shadow-[0_0_0_3px_oklch(0.72_0.16_250/0.15)]'
                    : 'border-border'
                }`}
              >
                <div className="text-[26px] mb-2.5">{c.glyph}</div>
                <div className="font-bold text-base mb-1.5">{c.title}</div>
                <div className="text-[13px] text-muted leading-normal">{c.desc}</div>
              </button>
            ))}
          </div>
          <div className="flex justify-end mt-7">
            <button onClick={goNext} disabled={s.direction === null} className={nextBtn}>
              Continue →
            </button>
          </div>
        </div>
      )}

      {/* Step 2 — upload */}
      {s.step === 2 && (
        <div>
          <h2 className="text-[22px] font-bold m-0 mb-1.5">Add your save files</h2>
          <p className="text-sm text-muted m-0 mb-6">
            Drop the whole{' '}
            <code className="font-mono bg-chip px-1.5 py-0.5 rounded">SaveGames</code> folder, or a
            single world folder.
          </p>
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={`border-2 border-dashed rounded-xl px-6 py-12 text-center cursor-pointer transition-colors ${
              s.files
                ? 'border-success bg-[oklch(0.76_0.15_150/0.06)]'
                : dragOver
                  ? 'border-accent bg-[oklch(0.72_0.16_250/0.06)]'
                  : 'border-border'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              // @ts-expect-error non-standard attribute
              webkitdirectory=""
              multiple
              className="hidden"
              onChange={onPickFiles}
            />
            {s.scanning ? (
              <>
                <div className="w-[34px] h-[34px] rounded-full border-[3px] border-border border-t-accent mx-auto mb-3 animate-psb-spin" />
                <div className="font-semibold text-[15px] mb-1.5">Scanning save folder…</div>
              </>
            ) : !s.files ? (
              <>
                <div className="text-[34px] mb-3">📁</div>
                <div className="font-semibold text-[15px] mb-1.5">Drag &amp; drop your save folder here</div>
                <div className="text-[13px] text-muted">
                  or click to browse · files are read locally, nothing is uploaded
                </div>
              </>
            ) : (
              <>
                <div className="text-[34px] mb-3 text-success">✓</div>
                <div className="font-semibold text-[15px] mb-1.5">Save folder loaded</div>
                <div className="text-[13px] text-muted">
                  Found {s.worlds.length} {s.worlds.length === 1 ? 'world' : 'worlds'} ·{' '}
                  {formatMB(s.worlds.reduce((n, w) => n + w.sizeBytes, 0))}
                </div>
              </>
            )}
          </div>
          <div className="flex justify-between mt-7">
            <button onClick={goBack} className={backBtn}>
              ← Back
            </button>
            <button onClick={goNext} disabled={!s.files} className={nextBtn}>
              Continue →
            </button>
          </div>
        </div>
      )}

      {/* Step 3 — world & character */}
      {s.step === 3 && (
        <div>
          <h2 className="text-[22px] font-bold m-0 mb-1.5">
            {isCoToDed ? 'Select world & character' : 'Select world'}
          </h2>
          <p className="text-sm text-muted m-0 mb-6">Worlds are shown by their in-game name.</p>
          <div className="text-xs font-bold text-muted uppercase tracking-[0.04em] mb-2.5">World</div>
          <div className="flex flex-col gap-2 mb-6">
            {s.worlds.map((w) => (
              <button key={w.id} onClick={() => selectWorld(w)} className={rowBtn(s.selectedWorldId === w.id)}>
                <span>{w.name}</span>
                <span className="text-xs text-muted font-normal">{formatMB(w.sizeBytes)}</span>
              </button>
            ))}
          </div>
          {!isCoToDed && s.selectedWorldId && s.characters.filter((c) => !c.isCoopHost).length > 1 && (
            <div className="mb-6">
              <div className="text-xs font-bold text-muted uppercase tracking-[0.04em] mb-2.5">
                Character to make host
              </div>
              <div className="flex flex-col gap-2">
                {s.characters
                  .filter((c) => !c.isCoopHost)
                  .map((c) => (
                    <button
                      key={c.playerUid}
                      onClick={() => setS((p) => ({ ...p, selectedCharacterUid: c.playerUid }))}
                      className={rowBtn(s.selectedCharacterUid === c.playerUid)}
                    >
                      <span>
                        {c.nickName ?? 'Unnamed'}
                        {c.level != null && <span className="text-muted font-normal"> · Lv {c.level}</span>}
                      </span>
                      <span className="text-xs text-muted font-mono font-normal">{shortUid(c.playerUid)}</span>
                    </button>
                  ))}
              </div>
            </div>
          )}
          {isCoToDed && s.selectedWorldId && (
            <div>
              <div className="text-xs font-bold text-muted uppercase tracking-[0.04em] mb-2.5">
                Host character
              </div>
              {s.charactersLoading ? (
                <div className="text-sm text-muted py-3">Reading Level.sav…</div>
              ) : (
                <div className="flex flex-col gap-2">
                  {s.characters.map((c) => (
                    <button
                      key={c.playerUid}
                      onClick={() => setS((p) => ({ ...p, selectedCharacterUid: c.playerUid }))}
                      className={rowBtn(s.selectedCharacterUid === c.playerUid)}
                    >
                      <span>
                        {c.nickName ?? 'Unnamed'}
                        {c.isCoopHost && <span className="text-muted font-normal"> (Host)</span>}
                        {c.level != null && <span className="text-muted font-normal"> · Lv {c.level}</span>}
                      </span>
                      <span className="text-xs text-muted font-mono font-normal">{shortUid(c.playerUid)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="flex justify-between mt-7">
            <button onClick={goBack} className={backBtn}>
              ← Back
            </button>
            <button onClick={goNext} disabled={!worldChosenValid} className={nextBtn}>
              Continue →
            </button>
          </div>
        </div>
      )}

      {/* Step 4 (co2ded) — SteamID64 */}
      {s.step === steamStepIndex && (
        <div>
          <h2 className="text-[22px] font-bold m-0 mb-1.5">Enter your SteamID64</h2>
          <p className="text-sm text-muted m-0 mb-6">
            We derive your server player GUID from this. Paste a raw GUID instead if you're on Xbox,
            PlayStation, or crossplay.
          </p>
          <input
            value={s.steamId}
            onChange={(e) =>
              setS((p) => ({ ...p, steamId: e.target.value.replace(/[^0-9a-fA-F-]/g, '').slice(0, 36) }))
            }
            placeholder="7656119..."
            className={`w-full bg-bg border rounded-lg px-4 py-3.5 text-fg font-mono text-[15px] outline-none ${steamIdBorder}`}
          />
          <div className={`text-xs mt-2 ${steamIdHintColor}`}>{steamIdHint}</div>
          <div className="flex justify-between mt-6">
            <button onClick={goBack} className={backBtn}>
              ← Back
            </button>
            <button onClick={goNext} disabled={!steamIdValid} className={nextBtn}>
              Continue →
            </button>
          </div>
        </div>
      )}

      {/* Final step — convert */}
      {s.step === finalStepIndex && (
        <div className="text-center">
          {s.status === 'error' ? (
            <div>
              <div className="text-[44px] mb-3.5">⚠️</div>
              <h2 className="text-[22px] font-bold m-0 mb-2.5">Conversion failed</h2>
              <p className="text-sm text-error m-0 mb-7 max-w-[460px] mx-auto">{s.error}</p>
              <div className="flex gap-3 justify-center flex-wrap">
                <button
                  onClick={() => setS((p) => ({ ...p, status: 'idle', error: null, progress: 0 }))}
                  className={nextBtn}
                >
                  Try again
                </button>
                <button onClick={restart} className={backBtn}>
                  Start over
                </button>
              </div>
            </div>
          ) : converting ? (
            <div className="py-5">
              <div className="w-[52px] h-[52px] rounded-full border-[3px] border-border border-t-accent mx-auto mb-6 animate-psb-spin" />
              <h2 className="text-xl font-bold m-0 mb-2">{s.progressLabel}</h2>
              <div className="w-full max-w-[360px] mx-auto mt-5 mb-2 h-2 bg-chip rounded-md overflow-hidden">
                <div
                  className="h-full bg-accent transition-[width] duration-200 ease-out"
                  style={{ width: `${s.progress}%` }}
                />
              </div>
              <div className="text-[13px] text-muted">{s.progress}%</div>
            </div>
          ) : done && s.result ? (
            <div>
              <div className="text-[44px] mb-3.5">🎉</div>
              <h2 className="text-[22px] font-bold m-0 mb-2.5">Conversion complete</h2>
              <p className="text-sm text-muted m-0 mb-7">
                {s.result.fileName} is ready · GUID rewritten in {s.result.filesRewritten} files
              </p>
              <div className="flex gap-3 justify-center flex-wrap">
                <button
                  onClick={downloadZip}
                  className="notch-10 bg-success text-accent-dark border-none px-7 py-3.5 font-bold text-[15px] cursor-pointer transition-shadow hover:shadow-[0_0_24px_oklch(0.76_0.15_150/0.55)]"
                >
                  Download ZIP
                </button>
                <button onClick={restart} className={backBtn}>
                  Convert another world
                </button>
              </div>
            </div>
          ) : (
            <div>
              <h2 className="text-[22px] font-bold m-0 mb-2.5">Ready to convert</h2>
              <p className="text-sm text-muted m-0 mb-7 max-w-[420px] mx-auto">{summaryText}</p>
              <button
                onClick={startConvert}
                className="notch-10 bg-accent text-accent-dark border-none px-9 py-4 font-bold text-base cursor-pointer transition-shadow hover:shadow-[0_0_32px_oklch(0.72_0.16_250/0.55)]"
              >
                Convert now
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
