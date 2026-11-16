import { OFFLINE_MAX_S, OFFLINE_MIN_S } from "./constants.js";
import { finite } from "./sanitize.js";

// Offline ("While You Were Away") rewards (client offline.js + offlineUi.js, `OFFLINE` in its config.js).
// Server-authoritative for signed-in players with a database: the SERVER decides how long the player was
// away (its own clock; `lastSeen` is stamped on every save, on leave and on load, and a save can never
// write it); the client turns those seconds into Strength + Speed (its gym config) and grants them only
// when `claimOffline` answers ok, i.e. once the claim is stored.
//
//  - On load: away = now - lastSeen. Under OFFLINE_MIN_S it earns nothing; the pending total is capped at
//    OFFLINE_MAX_S. The pending seconds are stored (`offlineSecs`), so a reload or a crash before claiming
//    never loses them, and the next absence adds to them (still capped).
//  - Claim: once per stored amount; the conditional write on the exact stored value means two pods can
//    never both pay it.

export interface OfflineView {
  secs: number; // seconds away waiting to be claimed (0 = nothing)
  max: number; // the cap, so the client can say "24h"
}

// Seconds spent away between two instants: 0 when unknown / not yet OFFLINE_MIN_S, never above the cap.
export function awaySeconds(lastSeen: unknown, now: number): number {
  if (!finite(lastSeen) || lastSeen <= 0 || lastSeen > now) return 0;
  const s = (now - lastSeen) / 1000;
  return s < OFFLINE_MIN_S ? 0 : Math.min(OFFLINE_MAX_S, Math.floor(s));
}

// A stored (or forged) pending amount, bounded to a whole number of seconds in [0, OFFLINE_MAX_S].
export function sanitizeOfflineSecs(raw: unknown): number {
  return finite(raw) ? Math.min(OFFLINE_MAX_S, Math.max(0, Math.floor(raw))) : 0;
}

// The pending total after an absence: what was already waiting plus the new time away, capped.
export function accrueOffline(stored: unknown, lastSeen: unknown, now: number): number {
  return Math.min(OFFLINE_MAX_S, sanitizeOfflineSecs(stored) + awaySeconds(lastSeen, now));
}

export const offlineView = (secs: number): OfflineView => ({ secs, max: OFFLINE_MAX_S });
