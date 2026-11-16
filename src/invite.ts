import { INVITES_MAX, INVITES_SENT_MAX, INVITE_ACTIVE, INVITE_TIERS, USER_ID_PATTERN } from "./constants.js";
import type { PlayerDoc } from "./db.js";

// Invite Friends (client invite.js): server-authoritative, like the Daily rewards. A friend counts for
// an inviter only once they ACTUALLY PLAY:
//   1. A signed-in NEW player joins through the inviter's link (`ref` in the join options) or after a
//      direct Bloxity invite (the inviter's `invitesSent`). Once ever, their doc gets `invitedBy` and
//      their welcome gift is ready. The inviter is not credited yet: the friend is "pending".
//   2. When the friend's saved progress reaches INVITE_ACTIVE (playtime AND blocks placed) the inviter's
//      `invites` goes up by one -- once per friend (`inviteCredited`, a conditional write, so two pods can't
//      both credit) -- and the INVITE_TIERS rewards unlock for them.
// The client only grants a prize after a claim answers ok.
export interface InviteState {
  invites: number; // friends who started playing through this player's invites
  pending: number; // friends who joined but have not played enough yet
  claimed: number[]; // claimed INVITE_TIERS indexes
  welcome: "" | "ready" | "claimed"; // the invited player's welcome gift
  sent: string[]; // friend ids this player invited directly (newest last)
  invitedBy: string; // this player's inviter ("" = nobody)
  invitedByName: string; // the inviter's display name, for the welcome toast
  credited: boolean; // this player already counted for their inviter
}

export const isUserId = (v: unknown): v is string => typeof v === "string" && USER_ID_PATTERN.test(v);

// The saved state from a player's doc (null / missing fields = nothing yet), bounded.
export function readInvite(doc: Partial<PlayerDoc> | null): InviteState {
  const invites = Number.isInteger(doc?.invites) ? Math.min(INVITES_MAX, Math.max(0, doc!.invites!)) : 0;
  const raw = Array.isArray(doc?.inviteClaimed) ? doc!.inviteClaimed! : [];
  const claimed = [...new Set(raw.filter((i) => Number.isInteger(i) && i >= 0 && i < INVITE_TIERS.length))].sort((a, b) => a - b);
  const welcome = doc?.welcome === "ready" || doc?.welcome === "claimed" ? doc.welcome : "";
  const sent = Array.isArray(doc?.invitesSent) ? [...new Set(doc!.invitesSent!.filter(isUserId))].slice(-INVITES_SENT_MAX) : [];
  return {
    invites,
    pending: 0,
    claimed,
    welcome,
    sent,
    invitedBy: isUserId(doc?.invitedBy) ? doc!.invitedBy! : "",
    invitedByName: "",
    credited: doc?.inviteCredited === true,
  };
}

// Has this saved progress played enough for the inviter to be credited?
export const isActive = (playtime: unknown, blocks: unknown): boolean =>
  typeof playtime === "number" && typeof blocks === "number" && playtime >= INVITE_ACTIVE.playtime && blocks >= INVITE_ACTIVE.blocks;

// Is this player new enough to be someone's invited friend? (No save, or hardly any playtime saved.)
export const isNewPlayer = (doc: Partial<PlayerDoc> | null, max: number): boolean => !doc || !(typeof doc.playtime === "number" && doc.playtime >= max);

// Claims `id`: "welcome" (the invited player's gift) or an INVITE_TIERS index whose friend count is
// reached. True when it was claimable (save, then answer ok).
export function claimInvite(s: InviteState, id: unknown): boolean {
  if (id === "welcome") {
    if (s.welcome !== "ready") return false;
    s.welcome = "claimed";
    return true;
  }
  if (!Number.isInteger(id) || (id as number) < 0 || (id as number) >= INVITE_TIERS.length) return false;
  const i = id as number;
  if (s.claimed.includes(i) || s.invites < INVITE_TIERS[i]) return false;
  s.claimed.push(i);
  s.claimed.sort((a, b) => a - b);
  return true;
}

// Undoes a claim that could not be stored.
export function unclaimInvite(s: InviteState, id: unknown): void {
  if (id === "welcome") s.welcome = "ready";
  else s.claimed = s.claimed.filter((i) => i !== id);
}

// Remembers a direct invite (newest last, bounded). False when it changed nothing.
export function rememberSent(s: InviteState, friendId: string): boolean {
  if (s.sent[s.sent.length - 1] === friendId) return false;
  s.sent = [...s.sent.filter((id) => id !== friendId), friendId].slice(-INVITES_SENT_MAX);
  return true;
}

// What the client is sent.
export const inviteView = (s: InviteState) => ({
  invites: s.invites,
  pending: s.pending,
  claimed: [...s.claimed],
  welcome: s.welcome,
  tiers: [...INVITE_TIERS],
  invitedBy: s.invitedByName,
  active: s.credited,
  need: { ...INVITE_ACTIVE },
});

// The doc fields a claim stores (`invites` is only ever $inc'ed, `invitedBy` set once).
export const inviteFields = (s: InviteState) => ({ inviteClaimed: [...s.claimed], ...(s.welcome && { welcome: s.welcome }) });
