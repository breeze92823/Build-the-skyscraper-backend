import { MongoClient, type Collection } from "mongodb";

import { LEADERBOARD_FIELDS } from "./constants.js";
import type { RewardsDoc } from "./rewards.js";

// Bloxity Legion hosting injects MONGODB_URI per game+channel -- an isolated database with
// scoped credentials. A local `npm start` normally has no Mongo reachable, so a missing or
// unreachable URI must degrade to "no persistence" rather than crash the room.

// One owned pet (client stats.js `state.pets`): its uid, catalog id and tier (0 normal, 1 golden, 2 rainbow).
export interface SavedPet {
  uid: number;
  id: string;
  tier: number;
}

// A running timed boost (client stats.js `state.timed`): stat x mult for `left` more seconds of play.
export interface TimedBoost {
  stat: string;
  mult: number;
  left: number;
}

// The Goals tracker (client goals.js): the goal in progress (`kind` id, `need`, `have`, `reward` cash it was
// promised when set), goals finished ever (`done`), the UTC day number and goals finished on it (`day` /
// `today`, the daily full-reward set) and when it was last played (`seen`, epoch ms: the welcome-back bonus).
export interface GoalsDoc {
  kind: string;
  need: number;
  have: number;
  reward: number;
  done: number;
  day: number;
  today: number;
  seen: number;
}

// The persisted client state: what `saveProgress` carries (see sanitize.ts), field for field the
// client's `SAVED` list in stats.js. Signed-in players' progress lives here; guests keep theirs
// in their browser.
export interface PlayerDoc {
  _id: string; // Bloxity user id from the verified token (auth.ts); guests are never saved
  username?: string; // display name as of the last save
  cash?: number;
  strength?: number;
  speed?: number;
  totalBlocks?: number; // blocks placed into towers (the rank XP)
  buildings?: number; // towers finished while the player helped
  bag?: number; // blocks carried
  upgrades?: Record<string, number>; // upgrade id -> level
  passes?: Record<string, boolean>; // pass id -> owned
  gymOwned?: Record<string, boolean>; // premium gym tier index -> owned
  daily?: { day: string; streak: number }; // last claimed day (YYYY-MM-DD) and the streak
  giftIn?: number; // s of play until the free gift
  playtime?: number; // s
  tower?: { n: number; floors: number; blocks: number }; // the tower's progress (client tower.js toSave())
  rankSeen?: number;
  gear?: { owned: Record<string, boolean>; on: string | null }; // Robot Gear
  pets?: SavedPet[];
  petEq?: number[]; // uids of the pets out
  petSeen?: Record<string, boolean>;
  petUid?: number;
  spins?: { normal: number; golden: number; pity: number };
  petSlots?: number; // extra pet slots bought with cash
  timed?: TimedBoost[]; // running timed boosts (reward prizes)
  goals?: GoalsDoc; // the Goals tracker (client goals.js): client-authoritative like the rest, bounded by sanitize.ts
  rewards?: RewardsDoc; // Daily / Playtime / Free rewards: written ONLY by the server (rewards.ts)
  lastSeen?: number; // epoch ms of the last activity: written ONLY by the server (every save, leave and load)
  offlineSecs?: number; // seconds away not yet claimed as an offline reward: written ONLY by the server (offline.ts)
  // Invite Friends (invite.ts): written ONLY by the server, never taken from a save.
  invites?: number; // friends who started playing through this player's invites
  inviteClaimed?: number[]; // claimed INVITE_TIERS indexes
  welcome?: "ready" | "claimed"; // the invited player's welcome gift
  invitesSent?: string[]; // friend ids invited directly through Bloxity (newest last)
  invitedBy?: string; // who invited this player (set once)
  inviteCredited?: boolean; // this player already counted for their inviter (once)
  version: number;
  updatedAt: Date;
}

let client: MongoClient | null = null;
let players: Collection<PlayerDoc> | null = null;

export async function connectDb(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[db] MONGODB_URI not set -- player progress will not persist");
    return;
  }
  try {
    client = new MongoClient(uri);
    await client.connect();
    // No dbName passed to .db() -- the injected URI already points at this game+channel's database.
    players = client.db().collection<PlayerDoc>("players");
    console.log("[db] connected to MongoDB");
    // The leaderboards sort and count by these (leaderboard.ts).
    for (const field of new Set(Object.values(LEADERBOARD_FIELDS))) {
      players.createIndex({ [field]: -1 }).catch((err) => console.warn(`[db] index on ${field} failed`, err));
    }
  } catch (err) {
    console.warn("[db] connect failed -- player progress will not persist:", err);
    client = null;
    players = null;
  }
}

// Null whenever Mongo is unset/unreachable -- every caller must treat that as "skip persistence".
export function getPlayers(): Collection<PlayerDoc> | null {
  return players;
}

// Test-only seam: exercise the save/load logic against an in-memory fake collection.
export function __setPlayersForTest(fake: Collection<PlayerDoc> | null): void {
  players = fake;
}
