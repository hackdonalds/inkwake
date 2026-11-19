/** Regressions for the gameplay audit: checkpoint lifecycle and hero-util re-entrancy. */
import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '../../src/core/events';
import type { Damageable, PlayerAPI } from '../../src/core/types';
import type { HeroHost } from '../../src/entities/heroes/HeroKit';
import { inRadius } from '../../src/entities/heroes/util';
import { Checkpoints } from '../../src/systems/checkpoints';
import { LEVEL2 } from '../../src/world/Level2';

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => mem.set(k, v),
    removeItem: (k: string) => mem.delete(k),
  };
});

function setup() {
  const bus = new EventBus<GameEvents>();
  const tele: number[][] = [];
  const player = {
    teleport: (x: number, y: number, z: number) => tele.push([x, y, z]),
  } as unknown as PlayerAPI;
  let pending: (() => Promise<void> | void) | null = null;
  const cp = new Checkpoints(LEVEL2, bus, () => player, {
    setTimeout: (fn) => {
      pending = fn;
      return 0;
    },
  });
  return { bus, tele, cp, fire: () => (pending as unknown as () => Promise<void>)?.() };
}

describe('Checkpoints (audit fixes)', () => {
  it('a respawn pending at dispose never runs against the next level', async () => {
    const { bus, tele, cp, fire } = setup();
    let respawns = 0;
    bus.on('player:respawn', () => respawns++);
    bus.emit('player:died', {});
    cp.dispose();
    await fire();
    expect(tele).toEqual([]);
    expect(respawns).toBe(0);
  });

  it('never regresses to an earlier checkpoint', () => {
    const { bus, cp } = setup();
    const first = LEVEL2.checkpoints[0]!.id;
    const later = LEVEL2.checkpoints[1]!.id;
    bus.emit('trigger:fired', { id: later });
    bus.emit('trigger:fired', { id: first });
    expect(cp.current).toBe(later);
    expect(Checkpoints.resumePoint()?.id).toBe(later);
    cp.dispose();
  });

  it('a forced reach (page started there) always emits checkpoint:reached', () => {
    const { bus, cp } = setup();
    const later = LEVEL2.checkpoints[1]!.id;
    const got: string[] = [];
    bus.on('checkpoint:reached', ({ id }) => got.push(id));
    cp.current = later; // e.g. co-op takeover restored it
    cp.reach(later, true);
    expect(got).toEqual([later]);
    cp.dispose();
  });
});

describe('hero util inRadius', () => {
  it('is re-entrant (a nested scan does not break the outer one)', () => {
    const mk = (id: number, x: number): Damageable =>
      ({ id, alive: true, radius: 0.5, position: { x, y: 0, z: 0 } }) as unknown as Damageable;
    const list = [mk(1, 0), mk(2, 1), mk(3, 2)];
    const host = {
      targets: { forEach: (fn: (t: Damageable) => void) => list.forEach(fn) },
    } as unknown as HeroHost;
    const outer: number[] = [];
    expect(() =>
      inRadius(host, 0, 0, 3, (t) => {
        outer.push(t.id);
        inRadius(host, 0, 0, 0.1, () => {});
      }),
    ).not.toThrow();
    expect(outer).toEqual([1, 2, 3]);
  });
});
