import type { EventBus, GameEvents } from '../core/events';
import { load, save } from '../core/storage';
import type { LevelDef, PageId, PlayerAPI, SaveData } from '../core/types';
import { TUNING } from '../data/tuning';

export const SAVE_KEY = 'save';
export const EMPTY_SAVE: SaveData = { lastCheckpoint: null, bestTimeS: null, completed: false };

export interface CheckpointHooks {
  /** Respawn presentation (mini page turn). Resolve after `swap` ran. Defaults to an immediate swap. */
  reprint?: (swap: () => void, durationS: number) => Promise<void>;
  /** Called during the reprint swap, after teleport (re-arm triggers, reset sketches/wells...). */
  onRespawn?: (checkpointId: string) => void;
  /** Ground height for respawn placement. */
  groundY?: (x: number, z: number) => number;
  /** Timer source; tests inject a manual one. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  /** Co-op: every wizard to reprint at the checkpoint (default: just `getPlayer()`). */
  getPlayers?: () => readonly (PlayerAPI | null | undefined)[];
}

/** Co-op: side-by-side respawn offsets (m, along X) per slot. */
const SLOT_OFFSET = [0, 1.4];

/**
 * Page-start + pre-boss checkpoints. Reaching one (its trigger id fires) saves progress and emits
 * `checkpoint:reached` (player refills pages on it). On `player:died` waits respawnDelay, plays the
 * "page reprinted" turn, teleports to the last checkpoint and emits `player:respawn`.
 */
export class Checkpoints {
  current: string;
  private readonly offs: (() => void)[] = [];
  private respawning = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly def: LevelDef,
    private readonly events: EventBus<GameEvents>,
    private readonly getPlayer: () => PlayerAPI | null,
    private readonly hooks: CheckpointHooks = {},
  ) {
    this.current = def.checkpoints[0]?.id ?? 'start';
    this.offs.push(
      events.on('trigger:fired', ({ id }) => {
        if (def.checkpoints.some((c) => c.id === id)) this.reach(id);
      }),
      events.on('player:died', () => this.scheduleRespawn()),
    );
  }

  static loadSave(): SaveData {
    return { ...load<SaveData>(SAVE_KEY, EMPTY_SAVE) };
  }

  /** Where a "Continue" should start: the saved checkpoint, if it belongs to a known page. */
  static resumePoint(): { page: PageId; id: string } | null {
    return Checkpoints.loadSave().lastCheckpoint;
  }

  /** `force`: always emit `checkpoint:reached` (a page (re)started here: refill pages). */
  reach(id: string, force = false): void {
    const idx = this.def.checkpoints.findIndex((c) => c.id === id);
    if (idx < 0 || this.disposed) return;
    // never regress: walking back through an earlier checkpoint's rect keeps the later one
    if (idx < this.def.checkpoints.findIndex((c) => c.id === this.current)) return;
    const first = this.current !== id;
    this.current = id;
    const s = Checkpoints.loadSave();
    s.lastCheckpoint = { page: this.def.page, id };
    save(SAVE_KEY, s);
    if (first || force || id === this.def.checkpoints[0]?.id) this.events.emit('checkpoint:reached', { id });
  }

  position(id = this.current): [number, number, number] {
    const c = this.def.checkpoints.find((k) => k.id === id) ?? this.def.checkpoints[0];
    return c ? c.at : this.def.playerStart.at;
  }

  private scheduleRespawn(): void {
    if (this.respawning || this.disposed) return;
    this.respawning = true;
    const ms = TUNING.checkpoint.respawnDelay * 1000;
    if (this.hooks.setTimeout) this.hooks.setTimeout(() => void this.respawn(), ms);
    else this.timer = setTimeout(() => void this.respawn(), ms);
  }

  async respawn(): Promise<void> {
    this.timer = null;
    // the page was torn down while the death timer ran: never teleport onto the next level
    if (this.disposed) return;
    const id = this.current;
    const swap = () => {
      const [x0, y0, z] = this.position(id);
      const list = this.hooks.getPlayers?.();
      const all = list && list.length > 1 ? list : [this.getPlayer()];
      for (let k = 0; k < all.length; k++) {
        const p = all[k];
        if (!p) continue;
        const x = x0 + (SLOT_OFFSET[p.slot ?? k] ?? 0);
        const y = this.hooks.groundY ? this.hooks.groundY(x, z) : y0;
        p.teleport(x, y, z, this.def.playerStart.rotY);
      }
      this.hooks.onRespawn?.(id);
      this.events.emit('player:respawn', { checkpointId: id });
      this.events.emit('checkpoint:reached', { id });
    };
    const reprint = this.hooks.reprint;
    if (reprint) await reprint(swap, TUNING.checkpoint.reprintTurn);
    else swap();
    this.respawning = false;
  }

  /** Persist a finished run (best time, completed flag). */
  static recordCompletion(timeS: number): SaveData {
    const s = Checkpoints.loadSave();
    s.completed = true;
    s.bestTimeS = s.bestTimeS == null ? timeS : Math.min(s.bestTimeS, timeS);
    s.lastCheckpoint = null;
    save(SAVE_KEY, s);
    return s;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const off of this.offs) off();
    this.offs.length = 0;
  }
}
