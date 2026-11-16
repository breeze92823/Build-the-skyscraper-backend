import { BUILDERS_TOP, BUILDING_SCALE, INSIDE_SECONDS, NEXT_BUILDING_DELAY_S, TOWER_N_MAX } from "./constants.js";

// The shared tower: ONE authoritative state machine per room, displayed by every client (client
// tower.js `sync`). The room's WorldState.tower schema object IS the state (so every change is synced
// to the clients by Colyseus); this module only holds the rules.
//
//   building --(last floor filled)--> celebrate (INSIDE_SECONDS, the lobby is open) --> sinking
//   --(NEXT_BUILDING_DELAY_S after it started)--> building n + 1
//
// The game stays client-authoritative: players report the blocks they placed (`build`), the server
// only bounds them (never more than the building still needs) and keeps the books.

export type TowerPhase = "building" | "celebrate" | "sinking";

// What the rules read and write; the schema object satisfies it.
export interface TowerData {
  n: number; // building index
  floors: number; // finished floors
  blocks: number; // blocks in the floor being built
  phase: string;
  phaseAt: number; // server ms the phase began
  seeded: boolean;
}

export interface Builder {
  id: string;
  name: string;
  blocks: number;
}

// Floors and blocks of building n (client buildingSpec in tower.js).
export function buildingFloors(n: number): number {
  const S = BUILDING_SCALE;
  return Math.min(S.floorsMax, S.floorsBase + n * S.floorsPer);
}
export function floorNeed(n: number, floor: number): number {
  const S = BUILDING_SCALE;
  return Math.round((S.blocksBase * Math.pow(S.blockGrowth, n) * (1 + floor * S.floorGrowth)) / 10) * 10;
}
export function buildingTotal(n: number): number {
  let total = 0;
  for (let f = 0; f < buildingFloors(n); f++) total += floorNeed(n, f);
  return total;
}

const clampInt = (v: unknown, max: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.floor(v))) : 0);

// A saved / client-offered tower { n, floors, blocks }, bounded, or null.
export function sanitizeTowerSeed(raw: unknown): { n: number; floors: number; blocks: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.n !== "number" || !Number.isFinite(r.n)) return null;
  const n = clampInt(r.n, TOWER_N_MAX);
  const floors = Math.min(clampInt(r.floors, 1000), buildingFloors(n));
  const blocks = floors >= buildingFloors(n) ? 0 : Math.min(clampInt(r.blocks, 1e12), floorNeed(n, floors));
  return { n, floors, blocks };
}

export class TowerRules {
  // Blocks placed on the CURRENT building, by player (the finale's Top Builders).
  private contrib = new Map<string, Builder>();

  constructor(private t: TowerData) {}

  // Gives a fresh room its starting tower (the first player's save) once. A building that was already
  // finished starts its celebration over, like the client does when it loads one.
  seed(saved: { n: number; floors: number; blocks: number } | null, now: number): boolean {
    if (this.t.seeded) return false;
    const s = saved ?? { n: 0, floors: 0, blocks: 0 };
    this.t.n = s.n;
    this.t.floors = s.floors;
    this.t.blocks = s.blocks;
    this.t.phase = s.floors >= buildingFloors(s.n) ? "celebrate" : "building";
    this.t.phaseAt = now;
    this.t.seeded = true;
    this.contrib.clear();
    return true;
  }

  // Credits `n` placed blocks to `who` on the current building. Rolls over floors and can finish the
  // building. Returns the blocks taken and, when this finished it, the Top Builders for the `built` message.
  addBlocks(n: unknown, who: { id: string; name: string }, now: number): { taken: number; built: { n: number; builders: Builder[] } | null } {
    const t = this.t;
    if (!t.seeded || t.phase !== "building" || typeof n !== "number" || !Number.isFinite(n) || n < 1) return { taken: 0, built: null };
    let left = Math.floor(n);
    let taken = 0;
    let built: { n: number; builders: Builder[] } | null = null;
    while (left > 0 && t.phase === "building") {
      const need = floorNeed(t.n, t.floors);
      const put = Math.min(need - t.blocks, left);
      t.blocks += put;
      left -= put;
      taken += put;
      this.credit(who, put);
      if (t.blocks >= need) {
        t.floors++;
        t.blocks = 0;
        if (t.floors >= buildingFloors(t.n)) {
          t.phase = "celebrate";
          t.phaseAt = now;
          built = { n: t.n, builders: this.builders() };
        }
      }
    }
    return { taken, built };
  }

  // Moves the timeline on. True when the phase (or the building) changed.
  tick(now: number): boolean {
    const t = this.t;
    if (!t.seeded) return false;
    if (t.phase === "celebrate" && now - t.phaseAt >= INSIDE_SECONDS * 1000) {
      t.phase = "sinking";
      t.phaseAt = now;
      return true;
    }
    if (t.phase === "sinking" && now - t.phaseAt >= NEXT_BUILDING_DELAY_S * 1000) {
      t.n = Math.min(TOWER_N_MAX, t.n + 1);
      t.floors = 0;
      t.blocks = 0;
      t.phase = "building";
      t.phaseAt = now;
      this.contrib.clear();
      return true;
    }
    return false;
  }

  // Top contributors on the current building, most first.
  builders(): Builder[] {
    return [...this.contrib.values()].sort((a, b) => b.blocks - a.blocks).slice(0, BUILDERS_TOP).map((b) => ({ ...b }));
  }

  private credit(who: { id: string; name: string }, put: number): void {
    if (put <= 0) return;
    const c = this.contrib.get(who.id);
    if (c) {
      c.blocks += put;
      c.name = who.name; // the newest display name
    } else this.contrib.set(who.id, { id: who.id, name: who.name, blocks: put });
  }
}
