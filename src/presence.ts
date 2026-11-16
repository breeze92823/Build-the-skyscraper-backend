import {
  AVATAR_ID_MAX_LEN, AVATAR_MAX_LEN, AVATAR_SLOT_KEYS, EMOTE_ID_PATTERN, GEAR_PATTERN, POSE_ACTS, POSE_BOUNDS, PROPORTION_KEYS,
  PROPORTION_RANGE, RANK_MAX, STAT_MAX,
} from "./constants.js";
import type { PlayerState } from "./rooms/schema/WorldState.js";

// Presence: what the other clients need to draw a player in the world (client remotePlayers.js).
// Relayed through the roster, only bounded here -- like the rest of the game it is
// client-authoritative and purely cosmetic.

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

// `pose` { x, y, z, yaw, speed, act }: world position of the feet, heading (rad), speed (m/s) and
// the activity the others draw (POSE_ACTS: "", "bench", "chute", "impact", "fly", "climb", "vehicle", "jet").
export function applyPose(p: PlayerState, msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  const b = POSE_BOUNDS;
  if (finite(m.x)) p.x = clamp(m.x, -b.xy, b.xy);
  if (finite(m.y)) p.y = clamp(m.y, -b.y, b.y);
  if (finite(m.z)) p.z = clamp(m.z, -b.xy, b.xy);
  if (finite(m.yaw)) p.yaw = Math.atan2(Math.sin(m.yaw), Math.cos(m.yaw));
  if (finite(m.speed)) p.speed = clamp(m.speed, 0, b.speed);
  if (typeof m.act === "string" && (POSE_ACTS as readonly string[]).includes(m.act)) p.act = m.act;
}

// `loadout` { rank, strength, gear }: what the name tag and the avatar's bulk need.
export function applyLoadout(p: PlayerState, msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  if (finite(m.rank)) p.rank = clamp(Math.floor(m.rank), 0, RANK_MAX);
  if (finite(m.strength)) p.strength = clamp(m.strength, 0, STAT_MAX);
  if (m.gear === "" || (typeof m.gear === "string" && GEAR_PATTERN.test(m.gear))) p.gear = m.gear as string;
}

// A catalog id from the Bloxity avatar: a short id string or a whole number (the SDK also uses
// "-1" / "undefined" for "nothing"). Never anything URL-like.
function avatarId(v: unknown): string | null {
  if (typeof v === "number") return Number.isInteger(v) && Math.abs(v) < 1e12 ? String(v) : null;
  return typeof v === "string" && v.length <= AVATAR_ID_MAX_LEN && /^[A-Za-z0-9_-]+$/.test(v) ? v : null;
}

// `setAvatar` { avatar }: the Bloxity look as JSON { equipped: { <slot>: id }, proportions } -- IDS ONLY,
// never URLs (each client derives asset URLs itself). The JSON is parsed and REBUILT from an allowlist
// of slots and proportion fields, so nothing else can ride along. "" = the default character.
export function sanitizeAvatar(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > AVATAR_MAX_LEN) return null;
  if (raw === "") return "";
  let look: unknown;
  try {
    look = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!look || typeof look !== "object") return null;
  const { equipped, proportions } = look as { equipped?: Record<string, unknown>; proportions?: Record<string, unknown> };
  const out: { equipped: Record<string, string>; proportions?: Record<string, number> } = { equipped: {} };
  if (equipped && typeof equipped === "object") {
    for (const key of AVATAR_SLOT_KEYS) {
      const id = avatarId(equipped[key]);
      if (id !== null) out.equipped[key] = id;
    }
  }
  if (proportions && typeof proportions === "object") {
    const props: Record<string, number> = {};
    for (const key of PROPORTION_KEYS) {
      const v = proportions[key];
      if (finite(v)) props[key] = clamp(v, PROPORTION_RANGE.min, PROPORTION_RANGE.max);
    }
    if (Object.keys(props).length) out.proportions = props;
  }
  return JSON.stringify(out);
}

export function applyAvatar(p: PlayerState, msg: unknown): void {
  const a = sanitizeAvatar((msg as { avatar?: unknown })?.avatar);
  if (a !== null) p.avatar = a;
}

// `emote` { id }: a Bloxity emote id ("" stops it). Bloxity tells only the picker's client, so the
// others learn of it here; `emoteAt` is the SERVER clock (ms), the change that makes clients replay.
export function applyEmote(p: PlayerState, msg: unknown, now = Date.now()): void {
  const id = (msg as { id?: unknown })?.id;
  if (id !== "" && !(typeof id === "string" && EMOTE_ID_PATTERN.test(id))) return;
  p.emote = id as string;
  p.emoteAt = now;
}
