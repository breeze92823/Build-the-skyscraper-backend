import { DAILY_DAYS, DAY_MS, PLAY_SECONDS_MAX, PLAY_TIERS_MIN, REWARD_STREAK_MAX } from "./constants.js";
import { finite } from "./sanitize.js";

// Daily, Playtime and Free rewards (client src/rewards.js + rewardsUi.js). Server-authoritative for
// signed-in players with a database: the client never writes these fields (saveProgress ignores
// them), it asks with `claimReward` and grants the prize only when the server says ok.
//
//  - Daily: one claim per UTC day. `streak` = days claimed in a row, `last` = the UTC day index of
//    the last claim. Claiming on the day after `last` continues the streak (day = streak % 7);
//    missing a day starts over at day 1; a finished week starts over too.
//  - Playtime: real seconds connected today (UTC); each PLAY_TIERS_MIN tier can be claimed once a
//    day once that many minutes have passed. Resets at UTC midnight.
//  - Free: one claim ever (the "Join / Favorite / Like" card).

export interface RewardsDoc {
  streak: number;
  last: number; // UTC day index of the last daily claim, -1 = never
  playDay: number; // UTC day index the playtime below belongs to
  playSec: number; // seconds played that day
  playClaimed: number[]; // playtime tier indexes claimed that day
  free: boolean;
}

// The view the client draws from (`rewards` message, and `view` in every `rewardResult`).
export interface RewardsView {
  daily: { day: number; canClaim: boolean; streak: number; nextAt: number };
  play: { sec: number; claimed: number[] };
  free: boolean;
  serverTime: number;
}

export const dayIndex = (ms: number) => Math.floor(ms / DAY_MS);

export function freshRewards(now: number): RewardsDoc {
  return { streak: 0, last: -1, playDay: dayIndex(now), playSec: 0, playClaimed: [], free: false };
}

// Bounds a stored (or forged) rewards object; anything unreadable becomes a fresh one.
export function sanitizeRewards(raw: unknown, now: number): RewardsDoc {
  const out = freshRewards(now);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  const today = dayIndex(now);
  if (finite(r.streak)) out.streak = Math.min(REWARD_STREAK_MAX, Math.max(0, Math.floor(r.streak)));
  if (finite(r.last)) out.last = Math.min(today, Math.max(-1, Math.floor(r.last)));
  if (finite(r.playDay)) out.playDay = Math.min(today, Math.max(0, Math.floor(r.playDay)));
  if (finite(r.playSec)) out.playSec = Math.min(PLAY_SECONDS_MAX, Math.max(0, r.playSec));
  if (Array.isArray(r.playClaimed)) {
    out.playClaimed = [...new Set(r.playClaimed.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < PLAY_TIERS_MIN.length))].sort((a, b) => a - b);
  }
  out.free = r.free === true;
  return out;
}

// One session's live copy: the stored doc plus when its playtime was last brought up to date.
export class RewardsState {
  doc: RewardsDoc;
  private since: number;

  constructor(doc: RewardsDoc, now: number) {
    this.doc = doc;
    this.since = now;
    this.tick(now);
  }

  // Adds the time since the last tick to today's playtime; a new UTC day starts it over.
  tick(now: number) {
    const d = this.doc;
    d.playSec = Math.min(PLAY_SECONDS_MAX, d.playSec + Math.max(0, now - this.since) / 1000);
    this.since = now;
    const today = dayIndex(now);
    if (d.playDay !== today) {
      d.playDay = today;
      d.playSec = 0;
      d.playClaimed = [];
    }
  }

  // Which day (0-based) is up next, whether it can be claimed today, and the live streak.
  daily(now: number) {
    const d = this.doc;
    const today = dayIndex(now);
    const claimedToday = d.last === today;
    const kept = claimedToday || d.last === today - 1;
    const streak = kept ? d.streak : 0;
    return { day: streak % DAILY_DAYS, canClaim: !claimedToday, streak, nextAt: (today + 1) * DAY_MS };
  }

  view(now: number): RewardsView {
    this.tick(now);
    return {
      daily: this.daily(now),
      play: { sec: Math.floor(this.doc.playSec), claimed: [...this.doc.playClaimed] },
      free: this.doc.free,
      serverTime: now,
    };
  }

  // A copy to store (playtime brought up to date first).
  snapshot(now: number): RewardsDoc {
    this.tick(now);
    return { ...this.doc, playSec: Math.floor(this.doc.playSec), playClaimed: [...this.doc.playClaimed] };
  }

  // The claims. Each returns the change to apply (`next`, stored by the caller before it answers ok)
  // or the reason it is refused. They never mutate `doc` themselves: the room commits `next` once
  // Mongo has it, so a failed write leaves the reward claimable.
  claimDaily(now: number): { ok: true; day: number; next: RewardsDoc } | { ok: false; reason: string } {
    const st = this.daily(now);
    if (!st.canClaim) return { ok: false, reason: "claimed" };
    const next = { ...this.snapshot(now), streak: Math.min(REWARD_STREAK_MAX, st.streak + 1), last: dayIndex(now) };
    return { ok: true, day: st.day, next };
  }

  claimPlay(tier: unknown, now: number): { ok: true; tier: number; next: RewardsDoc } | { ok: false; reason: string } {
    if (!Number.isInteger(tier) || (tier as number) < 0 || (tier as number) >= PLAY_TIERS_MIN.length) return { ok: false, reason: "tier" };
    const t = tier as number;
    this.tick(now);
    if (this.doc.playClaimed.includes(t)) return { ok: false, reason: "claimed" };
    // A second of slack: the client's clock started a moment after the server's.
    if (this.doc.playSec + 1 < PLAY_TIERS_MIN[t] * 60) return { ok: false, reason: "early" };
    const snap = this.snapshot(now);
    const next = { ...snap, playClaimed: [...snap.playClaimed, t].sort((a, b) => a - b) };
    return { ok: true, tier: t, next };
  }

  claimFree(now: number): { ok: true; next: RewardsDoc } | { ok: false; reason: string } {
    if (this.doc.free) return { ok: false, reason: "claimed" };
    return { ok: true, next: { ...this.snapshot(now), free: true } };
  }

  // Commits a stored claim (the room runs one claim at a time per session, so nothing else changed
  // `doc` meanwhile; the playtime clock kept running from the snapshot's tick).
  commit(next: RewardsDoc, now: number) {
    this.doc = next;
    this.tick(now);
  }
}
