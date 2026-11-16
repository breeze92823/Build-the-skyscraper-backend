import {
  BAG_MAX, BUILDINGS_MAX, CURRENCY_MAX, DAILY_STREAK_MAX, EQUIPPED_MAX, FLAGS_MAX, GIFT_SECONDS_MAX, ID_PATTERN,
  NAME_MAX, PETS_MAX, PET_SLOTS_BOUGHT_MAX, PET_TIERS_MAX, PET_UID_MAX, PITY_MAX, PLAY_SECONDS_MAX, RANK_MAX, SPINS_MAX, STAT_MAX,
  TIMED_MAX, TIMED_MULT_MAX, TIMED_SECONDS_MAX, TIMED_STATS, TOWER_MAX, UPGRADE_KINDS_MAX, UPGRADE_LEVEL_MAX,
} from "./constants.js";
import type { PlayerDoc, SavedPet, TimedBoost } from "./db.js";

export function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
export function clampNum(v: number, max: number): number {
  return Math.min(max, Math.max(0, v));
}
export function clampInt(v: number, max: number, min = 0): number {
  return Math.min(max, Math.max(min, Math.floor(v)));
}
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
const isId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);

// { id: true } flag maps (passes, pets seen, gear owned): slug keys, true values, bounded count.
function flags(raw: unknown, keyOk: (k: string) => boolean = isId): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!isObject(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= FLAGS_MAX) break;
    if (keyOk(k) && v === true) out[k] = true;
  }
  return out;
}

// Upgrade levels { id: n }: slug ids, whole non-negative levels, bounded kinds.
function upgrades(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObject(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= UPGRADE_KINDS_MAX) break;
    if (isId(k) && finite(v)) out[k] = clampInt(v, UPGRADE_LEVEL_MAX);
  }
  return out;
}

// Owned pets { uid, id, tier }: unique positive uids, slug ids, integer tiers, at most PETS_MAX.
export function sanitizePets(raw: unknown): SavedPet[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedPet[] = [];
  const seen = new Set<number>();
  for (const p of raw) {
    if (out.length >= PETS_MAX) break;
    if (!isObject(p) || !isId(p.id)) continue;
    const { uid, tier } = p;
    if (!Number.isInteger(uid) || (uid as number) < 1 || (uid as number) > PET_UID_MAX || seen.has(uid as number)) continue;
    if (!Number.isInteger(tier) || (tier as number) < 0 || (tier as number) >= PET_TIERS_MAX) continue;
    seen.add(uid as number);
    out.push({ uid: uid as number, id: p.id, tier: tier as number });
  }
  return out;
}

// Running timed boosts [{ stat, mult, left }]: known stats, bounded multipliers and times.
export function sanitizeTimed(raw: unknown): TimedBoost[] {
  if (!Array.isArray(raw)) return [];
  const out: TimedBoost[] = [];
  for (const b of raw) {
    if (out.length >= TIMED_MAX) break;
    if (!isObject(b) || !(TIMED_STATS as readonly unknown[]).includes(b.stat) || !finite(b.mult) || !finite(b.left)) continue;
    if (b.mult <= 1 || b.left <= 0) continue;
    out.push({ stat: b.stat as string, mult: Math.min(TIMED_MULT_MAX, b.mult), left: Math.min(TIMED_SECONDS_MAX, b.left) });
  }
  return out;
}

// The game is client-authoritative -- no server-side gameplay validation. What IS enforced:
// shape and bounds, so a malformed payload can never corrupt this player's own Mongo document.
// Only the fields the message carries come back, so a partial save never wipes the others.
export function sanitizeProgress(raw: unknown): Partial<PlayerDoc> | null {
  if (!isObject(raw)) return null;
  const out: Partial<PlayerDoc> = {};

  if (finite(raw.cash)) out.cash = clampNum(raw.cash, CURRENCY_MAX);
  if (finite(raw.strength)) out.strength = clampNum(raw.strength, STAT_MAX);
  if (finite(raw.speed)) out.speed = clampNum(raw.speed, STAT_MAX);
  if (finite(raw.totalBlocks)) out.totalBlocks = clampInt(raw.totalBlocks, STAT_MAX);
  if (finite(raw.buildings)) out.buildings = clampInt(raw.buildings, BUILDINGS_MAX);
  if (finite(raw.bag)) out.bag = clampNum(raw.bag, BAG_MAX);
  if (finite(raw.giftIn)) out.giftIn = clampNum(raw.giftIn, GIFT_SECONDS_MAX);
  if (finite(raw.playtime)) out.playtime = clampInt(raw.playtime, PLAY_SECONDS_MAX);
  if (finite(raw.rankSeen)) out.rankSeen = clampInt(raw.rankSeen, RANK_MAX);
  // `lastSeen` / `offlineSecs` are never taken from a save: only the server writes them (offline.ts).
  if (finite(raw.petUid)) out.petUid = clampInt(raw.petUid, PET_UID_MAX, 1);
  if (finite(raw.petSlots)) out.petSlots = clampInt(raw.petSlots, PET_SLOTS_BOUGHT_MAX);
  if (raw.timed !== undefined) out.timed = sanitizeTimed(raw.timed);
  // `rewards` is never taken from a save: only the server writes it (rewards.ts).

  if (raw.upgrades !== undefined) out.upgrades = upgrades(raw.upgrades);
  if (raw.passes !== undefined) out.passes = flags(raw.passes);
  if (raw.gymOwned !== undefined) out.gymOwned = flags(raw.gymOwned, (k) => /^\d{1,3}$/.test(k));
  if (raw.petSeen !== undefined) out.petSeen = flags(raw.petSeen);
  if (isObject(raw.daily)) {
    const { day, streak } = raw.daily;
    out.daily = {
      day: typeof day === "string" && /^(\d{4}-\d{2}-\d{2})?$/.test(day) ? day : "",
      streak: finite(streak) ? clampInt(streak, DAILY_STREAK_MAX) : 0,
    };
  }
  if (isObject(raw.tower) && finite(raw.tower.n)) {
    const t = raw.tower;
    out.tower = {
      n: clampInt(t.n as number, TOWER_MAX.n),
      floors: finite(t.floors) ? clampInt(t.floors, TOWER_MAX.floors) : 0,
      blocks: finite(t.blocks) ? clampInt(t.blocks, TOWER_MAX.blocks) : 0,
    };
  }
  if (isObject(raw.gear)) {
    const owned = flags(raw.gear.owned);
    out.gear = { owned, on: isId(raw.gear.on) && owned[raw.gear.on] ? raw.gear.on : null }; // only an owned piece is worn
  }
  if (raw.pets !== undefined) {
    out.pets = sanitizePets(raw.pets);
    // The pets out must be owned ones (when this save carries the list), and few.
    if (Array.isArray(raw.petEq)) {
      const owned = new Set(out.pets.map((p) => p.uid));
      out.petEq = [...new Set(raw.petEq.filter((u): u is number => Number.isInteger(u) && owned.has(u)))].slice(0, EQUIPPED_MAX);
    }
  } else if (Array.isArray(raw.petEq)) {
    out.petEq = [...new Set(raw.petEq.filter((u): u is number => Number.isInteger(u) && u > 0 && u <= PET_UID_MAX))].slice(0, EQUIPPED_MAX);
  }
  if (isObject(raw.spins)) {
    const s = raw.spins;
    out.spins = {
      normal: finite(s.normal) ? clampInt(s.normal, SPINS_MAX) : 0,
      golden: finite(s.golden) ? clampInt(s.golden, SPINS_MAX) : 0,
      pity: finite(s.pity) ? clampInt(s.pity, PITY_MAX) : 0,
    };
  }
  return out;
}
