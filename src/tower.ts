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
  need: number; // blocks the floor being built needs (set when it starts: the room's pace x its minutes, see floorNeed)
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
// Minutes a floor should take when `builders` people are building (1 or none: soloMins 3.5; more: up to ~6,
// never over maxMins). Client tower.js uses the solo value in local play.
export function floorMinutes(builders: number): number {
  const S = BUILDING_SCALE;
  return Math.min(S.maxMins, S.soloMins + S.crowdMins * (1 - 1 / Math.max(1, builders)));
}
// The smallest a floor of building n can be (an empty room, nobody's pace known yet).
export function floorMin(n: number): number {
  const S = BUILDING_SCALE;
  return Math.max(1, Math.round(S.minBase * Math.pow(S.minGrowth, n)));
}
// Blocks a floor of building n needs when the room places `rate` blocks a minute, the floor should take `mins`
// minutes and the active builders' full bags add up to `bags` blocks: never fewer than `minBags` of those
// bags, so a high-capacity player always faces a floor sized to their bag (client tower.js floorNeed: the same
// rule in local play, on your own pace and bag).
export function floorNeed(n: number, rate: number, mins: number, bags = 0): number {
  const want = Math.max(Math.max(0, rate) * Math.max(0, mins), BUILDING_SCALE.minBags * Math.max(0, bags));
  return Math.max(floorMin(n), Math.round(Math.min(want, 1e15)));
}

// One builder's pace in blocks a minute: what they placed over their last BUILDING_SCALE.window s of
// BUILDING time. Breaks longer than `active` s (the gym, a building's celebration, AFK) do not count and do not
// reset it, so a strong player's next floors are sized to their real pace straight away. Until someone has
// built for `window` s in all, the missing part is filled with one full bag (`trip`) every `tripSecs` s, so a
// first bag never reads as a sprint. (Client tower.js has the same tracker for local play.)
export class BuildRate {
  private samples: { at: number; n: number }[] = []; // ~1 s buckets, `at` in building-time ms
  private sum = 0;
  private busy = 0; // building-time ms so far (gaps up to `active` s between builds count, longer ones do not)
  private last = -Infinity;
  private trip = 1;

  add(blocks: number, trip: number, now: number): void {
    const gap = now - this.last;
    if (gap > 0 && gap <= BUILDING_SCALE.active * 1000) this.busy += gap;
    this.last = Math.max(this.last, now);
    if (Number.isFinite(trip) && trip > 0) this.trip = trip;
    if (blocks > 0 && Number.isFinite(blocks)) {
      const tail = this.samples[this.samples.length - 1];
      if (tail && this.busy - tail.at < 1000) tail.n += blocks;
      else this.samples.push({ at: this.busy, n: blocks });
      this.sum += blocks;
    }
    this.trim(this.busy);
  }
  active(now: number): boolean {
    return now - this.last <= BUILDING_SCALE.active * 1000;
  }
  // Blocks one full bag of theirs places (their last `trip`).
  bag(): number {
    return this.trip;
  }
  perMinute(now: number): number {
    const S = BUILDING_SCALE;
    const gap = now - this.last;
    const t = this.busy + (gap > 0 && gap <= S.active * 1000 ? gap : 0);
    this.trim(t);
    const span = Math.min(S.window, Math.max(0, t / 1000));
    const prior = (this.trip * 60) / S.tripSecs;
    return (this.sum * 60) / S.window + (1 - span / S.window) * prior;
  }
  private trim(t: number): void {
    const since = t - BUILDING_SCALE.window * 1000;
    while (this.samples.length && this.samples[0].at < since) this.sum -= this.samples.shift()!.n;
    if (!this.samples.length) this.sum = 0; // no float drift
  }
}

// The room's active builders: how many, their summed pace (blocks a minute) and their summed full bags.
export interface Crew {
  n: number;
  rate: number;
  bags: number;
}
export function crewOf(rates: Iterable<BuildRate>, now: number): Crew {
  let n = 0;
  let rate = 0;
  let bags = 0;
  for (const r of rates) {
    if (!r.active(now)) continue;
    n++;
    rate += r.perMinute(now);
    bags += r.bag();
  }
  return { n, rate, bags };
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
  // Minutes the current floor was sized for (eases toward floorMinutes(crew) floor by floor; null = not yet).
  private mins: number | null = null;
  // The crew the current floor was sized for (its pace sets when the floor shrinks), and the last crew that
  // had anyone in it (sizes a floor that starts while nobody is building: after a celebration).
  private sizedFor: Crew = { n: 0, rate: 0, bags: 0 };
  private lastCrew: Crew | null = null;
  // The floor was sized with nobody's pace known (a fresh room): the first build sizes it again.
  private blind = false;

  // `crew()` = the room's active builders and their summed pace (WorldRoom tracks them, crewOf).
  constructor(
    private t: TowerData,
    private crew: () => Crew = () => ({ n: 0, rate: 0, bags: 0 }),
  ) {}

  // Sizes the floor being built now (a new floor, a new building, a seed): the room's pace x the floor's
  // minutes, which move `rampUp` / `rampDown` of the way toward what this many builders should take.
  private startFloor(): void {
    const S = BUILDING_SCALE;
    let c = this.crew();
    if (c.n > 0) this.lastCrew = c;
    else if (this.lastCrew) c = this.lastCrew;
    this.blind = c.n === 0;
    const target = floorMinutes(c.n);
    const m = this.mins;
    this.mins = m == null ? target : m + (target - m) * (target > m ? S.rampUp : S.rampDown);
    this.sizedFor = c;
    this.t.need = floorNeed(this.t.n, c.rate, this.mins, c.bags);
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
    // A saved floor bigger than the room's floor now just needs one more block (never a stuck floor).
    this.t.blocks = Math.min(s.blocks, Math.max(0, this.t.need - 1));
    this.t.placed = this.t.blocks;
    this.t.seeded = true;
    this.contrib.clear();
    return true;
  }

  // Credits `n` placed blocks to `who` on the current building. One call (one `build` message) fills AT MOST
  // the floor in progress: the rest is not taken (the client caps the same way), so no single placement or
  // instant-block boost can roll through a whole building; every floor is sized when it starts. Can finish
  // the building. Returns the blocks taken and, when this finished it, the Top Builders for the `built` message.
  addBlocks(n: unknown, who: { id: string; name: string }, now: number): { taken: number; built: { n: number; builders: Builder[] } | null } {
    const t = this.t;
    if (!t.seeded || t.phase !== "building" || typeof n !== "number" || !Number.isFinite(n) || n < 1) return { taken: 0, built: null };
    // A floor sized before anyone's pace was known (a fresh room) is sized again by its first blocks.
    if (!(t.need > 0) || (this.blind && t.blocks === 0)) this.startFloor();
    const put = Math.max(0, Math.min(t.need - t.blocks, Math.floor(n)));
    t.blocks += put;
    t.placed += put;
    this.credit(who, put);
    let built: { n: number; builders: Builder[] } | null = null;
    if (t.blocks >= t.need) {
      t.floors++;
      t.blocks = 0;
      if (t.floors >= buildingFloors(t.n)) {
        t.phase = "celebrate";
        t.phaseAt = now;
        built = { n: t.n, builders: this.builders() };
      } else this.startFloor(); // the next floor is sized to who is building now (a joiner counts from here)
    }
    return { taken: put, built };
  }

  // Moves the timeline on. True when the phase (or the building) changed.
  tick(now: number): boolean {
    const t = this.t;
    if (!t.seeded) return false;
    // The room got slower (a builder left or went idle): only the REMAINING part of the floor shrinks, in
    // proportion, so its progress never goes back and it never sticks at a size nobody can finish. A faster
    // room never grows a started floor (the next one is sized to it). Nobody building: left as it is.
    if (t.phase === "building" && this.sizedFor.rate > 0) {
      const c = this.crew();
      if (c.n > 0 && c.rate < this.sizedFor.rate * BUILDING_SCALE.shrinkAt) {
        const rest = Math.max(0, t.need - t.blocks) * (c.rate / this.sizedFor.rate);
        t.need = Math.max(Math.floor(t.blocks) + 1, Math.min(t.need, Math.round(t.blocks + rest)));
        this.sizedFor = { ...c };
      }
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
