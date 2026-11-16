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
  need: number; // blocks the floor being built needs (set when it starts: the room's bags, see floorNeed)
  placed: number; // blocks placed on this building so far (all floors)
  phase: string;
  phaseAt: number; // server ms the phase began
  seeded: boolean;
}

export interface Builder {
  id: string;
  name: string;
  blocks: number;
}

// Floors of building n (client buildingSpec in tower.js).
export function buildingFloors(n: number): number {
  const S = BUILDING_SCALE;
  return Math.min(S.floorsMax, S.floorsBase + n * S.floorsPer);
}
// Full bags of the room a floor of building n takes.
export function floorTrips(n: number): number {
  const S = BUILDING_SCALE;
  return Math.min(S.tripsMax, S.tripsBase + n * S.tripsPer);
}
// The smallest a floor of building n can be (an empty room, a lone new player).
export function floorMin(n: number, floor: number): number {
  const S = BUILDING_SCALE;
  return Math.max(1, Math.round(S.minBase * Math.pow(S.minGrowth, n) * (1 + floor * S.floorGrowth)));
}
// Blocks floor `floor` of building n needs when the room's active builders' bags add up to `roomTrip`
// (client tower.js floorNeed: the same rule in local play, on your own bag).
export function floorNeed(n: number, floor: number, roomTrip: number): number {
  const S = BUILDING_SCALE;
  const want = floorTrips(n) * Math.max(0, roomTrip) * (1 + floor * S.floorGrowth);
  return Math.max(floorMin(n, floor), Math.round(Math.min(want, 1e15)));
}

const clampInt = (v: unknown, max: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.floor(v))) : 0);

// A saved / client-offered tower { n, floors, blocks }, bounded, or null.
export function sanitizeTowerSeed(raw: unknown): { n: number; floors: number; blocks: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.n !== "number" || !Number.isFinite(r.n)) return null;
  const n = clampInt(r.n, TOWER_N_MAX);
  const floors = Math.min(clampInt(r.floors, 1000), buildingFloors(n));
  const blocks = floors >= buildingFloors(n) ? 0 : clampInt(r.blocks, 1e13);
  return { n, floors, blocks };
}

export class TowerRules {
  // Blocks placed on the CURRENT building, by player (the finale's Top Builders).
  private contrib = new Map<string, Builder>();

  // `roomTrip()` = the summed bags (blocks per full bag) of the room's active builders (WorldRoom tracks them).
  constructor(
    private t: TowerData,
    private roomTrip: () => number = () => 0,
  ) {}

  // Sizes the floor being built now (a new floor, a new building, a seed).
  private startFloor(): void {
    this.t.need = floorNeed(this.t.n, this.t.floors, this.roomTrip());
  }

  // Gives a fresh room its starting tower (the first player's save) once. A building that was already
  // finished starts its celebration over, like the client does when it loads one.
  seed(saved: { n: number; floors: number; blocks: number } | null, now: number): boolean {
    if (this.t.seeded) return false;
    const s = saved ?? { n: 0, floors: 0, blocks: 0 };
    this.t.n = s.n;
    this.t.floors = s.floors;
    this.t.phase = s.floors >= buildingFloors(s.n) ? "celebrate" : "building";
    this.t.phaseAt = now;
    this.startFloor();
    // A saved floor bigger than the room's bags now just needs one more block (never a stuck floor).
    this.t.blocks = Math.min(s.blocks, Math.max(0, this.t.need - 1));
    this.t.placed = this.t.blocks;
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
      if (!(t.need > 0)) this.startFloor();
      const put = Math.max(0, Math.min(t.need - t.blocks, left));
      t.blocks += put;
      t.placed += put;
      left -= put;
      taken += put;
      this.credit(who, put);
      if (t.blocks >= t.need) {
        t.floors++;
        t.blocks = 0;
        if (t.floors >= buildingFloors(t.n)) {
          t.phase = "celebrate";
          t.phaseAt = now;
          built = { n: t.n, builders: this.builders() };
        } else this.startFloor(); // the next floor is sized to who is building now
      }
    }
    return { taken, built };
  }

  // Moves the timeline on. True when the phase (or the building) changed.
  tick(now: number): boolean {
    const t = this.t;
    if (!t.seeded) return false;
    // The room got weaker (its strongest builder left or went idle): the floor shrinks to what the room can
    // fill now (never below what is already on it + 1), so a floor never gets stuck at a size nobody can finish.
    if (t.phase === "building") {
      const fit = floorNeed(t.n, t.floors, this.roomTrip());
      if (fit < t.need) t.need = Math.max(fit, Math.floor(t.blocks) + 1);
    }
    if (t.phase === "celebrate" && now - t.phaseAt >= INSIDE_SECONDS * 1000) {
      t.phase = "sinking";
      t.phaseAt = now;
      return true;
    }
    if (t.phase === "sinking" && now - t.phaseAt >= NEXT_BUILDING_DELAY_S * 1000) {
      t.n = Math.min(TOWER_N_MAX, t.n + 1);
      t.floors = 0;
      t.blocks = 0;
      t.placed = 0;
      t.phase = "building";
      t.phaseAt = now;
      this.startFloor();
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
