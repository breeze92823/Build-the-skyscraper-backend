// Keep in step with the client's src/config.js by hand (contract: see CLAUDE.md).
export const GAME_SLUG = "build-the-skyscraper"; // the game id registered on bloxity.io
export const ROOM_MAX_CLIENTS = 50; // 2..100 for Bloxity party play; read by the deploy workflow

// Longest accepted strings.
export const NAME_MAX = 64;
// Profile picture URL (Bloxity `pfp`), relayed so the leaderboard / name tags can use it.
export const PFP_MAX_LEN = 512;
// Account ids come from Bloxity's token verification (auth.ts); this bounds what we store of them.
export const USER_ID_MAX = 128;
export const USER_ID_PATTERN = /^[A-Za-z0-9_.#-]{1,128}$/;
// The client's per-browser id in local dev (no Bloxity SDK). Only accepted outside production.
export const DEV_ID_PATTERN = /^dev-[A-Za-z0-9_-]{1,32}$/;

// Presence (presence.ts): the other players' avatars. The look travels as equipped catalog IDS only
// (never URLs: each client derives the asset URLs itself), rebuilt and bounded server-side.
export const AVATAR_MAX_LEN = 3000;
export const AVATAR_ID_MAX_LEN = 64;
export const AVATAR_SLOT_KEYS = [
  "headId", "torsoId", "armLId", "armRId", "legLId", "legRId", "hatId", "backId", "hairId", "maskId",
  "neckId", "chestId", "waistId", "skinId", "pantsId", "shirtId", "faceId",
] as const;
// SDK avatar proportions (client PROPORTIONS in config.js: 0.5..1.6, clamped again there).
export const PROPORTION_KEYS = ["height", "shoulderWidth", "armLength", "legOffsetX", "torsoScaleX", "neckHeight", "headScale"] as const;
export const PROPORTION_RANGE = { min: 0.1, max: 3 };
// Pose bounds: |x|, |z| up to `xy` m, y within [-`y`, `y`] (a flying jet reaches ~260 m), speed in m/s.
export const POSE_BOUNDS = { xy: 5000, y: 2000, speed: 500 };
// Activities the others draw: "bench" (gym bench press), "chute" (hanging under a parachute, client
// parachute.js), "impact" (a Robot Gear superhero landing crouch, client impact.js), and what Robot Gear
// does: "fly" (thrusters on), "climb" (Spider Arms on the tower wall), "vehicle" (a transformer's vehicle
// form on the ground) and "jet" (the Jet Transformer in the air).
export const POSE_ACTS = ["", "bench", "chute", "impact", "fly", "climb", "vehicle", "jet"] as const;
// Emotes: Bloxity emote ids are 24-char hex strings; "" stops the emote.
export const EMOTE_ID_PATTERN = /^[a-f0-9]{24}$/;
// Highest rank index relayed for a name tag (client RANKS has 30).
export const RANK_MAX = 255;
export const GEAR_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// Colyseus drops the whole connection for a WebSocket message above this (default 4 KB).
export const MAX_PAYLOAD_BYTES = 128 * 1024;

// How long a dropped connection (WiFi blip, backgrounded tab) may reconnect with the same session.
export const RECONNECT_SECONDS = 20;

// Upper bounds for saved values, so a forged payload cannot store a bogus number. Generous
// ceilings, not game rules.
export const CURRENCY_MAX = 1e33; // cash
export const STAT_MAX = 1e15; // strength, speed, total blocks
export const BUILDINGS_MAX = 1e6;
export const BAG_MAX = 1e9;
export const PLAY_SECONDS_MAX = 31_536_000; // ~1 year
export const GIFT_SECONDS_MAX = 7 * 86_400;
export const UPGRADE_LEVEL_MAX = 1000;
export const UPGRADE_KINDS_MAX = 32;
export const FLAGS_MAX = 128; // passes, gym tiers, gear, pets seen: id -> true
export const DAILY_STREAK_MAX = 1e6;
export const TOWER_MAX = { n: 1e6, floors: 1000, blocks: 1e9 };
// Pets (client PETS / PET): at most PETS_MAX owned, PET_TIERS_MAX craft tiers, EQUIPPED_MAX out at once.
export const PETS_MAX = 500;
export const PET_TIERS_MAX = 8;
export const EQUIPPED_MAX = 12;
export const PET_UID_MAX = 1e9;
export const SPINS_MAX = 1e6;
export const PITY_MAX = 1e4;
// Extra pet slots bought with cash (client PET.extraSlots.prices.length).
export const PET_SLOTS_BOUGHT_MAX = 8;
// Timed boosts (client stats.js `state.timed`): [{ stat, mult, left (s) }] from the daily /
// playtime / free rewards. Kinds, the biggest multiplier and the longest time one may hold.
export const TIMED_STATS = ["cash", "strength", "speed"] as const;
export const TIMED_MAX = 12;
export const TIMED_MULT_MAX = 100;
export const TIMED_SECONDS_MAX = 7 * 86_400;

// Daily / Playtime / Free rewards (rewards.ts; client config.js REWARDS). Server-authoritative.
export const DAY_MS = 86_400_000; // rewards run on the server's UTC days
export const DAILY_DAYS = 7; // client REWARDS.daily.length
export const PLAY_TIERS_MIN = [1, 3, 5, 15, 20, 25, 30, 45]; // client REWARDS.play[].at (minutes played today)
export const REWARD_STREAK_MAX = 1e6;

// Offline ("While You Were Away") rewards (offline.ts; client config.js OFFLINE). Away time shorter than
// OFFLINE_MIN_S earns nothing; at most OFFLINE_MAX_S (24 h) is ever stored. Keep in step with the client.
export const OFFLINE_MIN_S = 300;
export const OFFLINE_MAX_S = 86_400;

// The shared tower (tower.ts): ONE authoritative tower per room that every client displays. Building n's
// size is deterministic from n (client config.js BUILDING_SCALE / INSIDE.time / NEXT_BUILDING / TOWER.sinkTime:
// keep in step by hand). Timeline: building -> celebrate (INSIDE_SECONDS open lobby) -> sinking -> building n+1
// NEXT_BUILDING_DELAY_S after the sinking started (sinkTime 3.2 + the Next Building reel's hold:
// fadeIn .45 + spin 4.8 + settle .35 + hold 2.9 + fadeOut .45 - fadeOut / 2).
export const BUILDING_SCALE = { floorsBase: 18, floorsPer: 6, floorsMax: 70, blocksBase: 220, blockGrowth: 2.15, floorGrowth: 0.05 };
export const TOWER_N_MAX = 200; // blocksBase * blockGrowth^n stays finite
export const INSIDE_SECONDS = 180;
export const NEXT_BUILDING_DELAY_S = 8.725;
export const TOWER_TICK_MS = 200; // how often the room advances the timeline
export const BUILD_MSG_MAX = 1e12; // blocks in one `build` message (it is also capped by what the building still needs)
export const BUILD_BUCKET = { burst: 20, perSec: 20 }; // `build` messages a session may send (a client batches ~4/s)
export const BUILDERS_TOP = 10; // contributors named in `built`

// Invite Friends (invite.ts; client config.js INVITE): a friend counts for their inviter once they ACTUALLY PLAY.
// Keep INVITE_TIERS in step with the client's INVITE.tiers[].friends and INVITE_ACTIVE with INVITE.need.
export const INVITE_TIERS = [1, 2, 3, 5, 8, 12, 20, 25] as const; // friends who started playing -> a reward each
export const INVITES_MAX = 100; // friends counted for one player, at most
export const INVITES_SENT_MAX = 50; // direct Bloxity invites remembered per player
// An invited friend counts for their inviter once their saved progress reaches both.
export const INVITE_ACTIVE = { playtime: 180, blocks: 300 };
// Only a NEW player can be invited: no save yet, or less than this much saved playtime (s) when they join.
export const INVITE_NEW_PLAYTIME_MAX = 60;

// Leaderboards (leaderboard.ts; client leaderboard.js boards): board key -> the saved doc field it
// ranks, rows per board and how often the lists are re-read and re-sent.
export const LEADERBOARD_FIELDS = {
  strength: "strength",
  speed: "speed",
  blocks: "totalBlocks",
  cash: "cash",
  buildings: "buildings",
  playtime: "playtime",
} as const;
export type LeaderboardStat = keyof typeof LEADERBOARD_FIELDS;
export const LEADERBOARD_STATS = Object.keys(LEADERBOARD_FIELDS) as LeaderboardStat[];
export const LEADERBOARD_SIZE = 10;
export const LEADERBOARD_EVERY_MS = 60 * 1000;

// Bloxity's own leaderboards and stats (boxity.ts; the client defines the same boards in
// config.js BLOXITY_BOARDS): ids are lowercase and permanent. `mode` best = the best score ever
// (the stats only ever grow), latest = the current value (cash goes down when spent).
export const BOXITY_BOARDS = [
  { id: "blocks", label: "Blocks Placed", order: "desc", mode: "best", format: "compact", stat: "totalBlocks" },
  { id: "buildings", label: "Buildings Finished", order: "desc", mode: "best", format: "number", stat: "buildings" },
  { id: "strength", label: "Strength", order: "desc", mode: "best", format: "compact", stat: "strength" },
  { id: "speed", label: "Speed", order: "desc", mode: "best", format: "compact", stat: "speed" },
  { id: "cash", label: "Cash", order: "desc", mode: "latest", format: "compact", stat: "cash" },
  { id: "playtime", label: "Playtime", order: "desc", mode: "best", format: "time", stat: "playtime" },
] as const;
// Bloxity stats (POST /v1/games/{id}/stats): lowercase keys, `max` = the platform's ceiling for the
// type (a value above it is rejected, so it is left out rather than sent).
export const BOXITY_STATS = [
  { key: "blocks_placed", label: "Blocks Placed", type: "number", sortOrder: 1, stat: "totalBlocks", max: 1e9 },
  { key: "buildings_finished", label: "Buildings Finished", type: "number", sortOrder: 2, stat: "buildings", max: 1e9 },
  { key: "strength", label: "Strength", type: "number", sortOrder: 3, stat: "strength", max: 1e9 },
  { key: "speed", label: "Speed", type: "number", sortOrder: 4, stat: "speed", max: 1e9 },
  { key: "cash", label: "Cash", type: "currency", sortOrder: 5, stat: "cash", max: 1e12 },
  { key: "playtime", label: "Playtime", type: "seconds", sortOrder: 6, stat: "playtime", max: 31_536_000_000 },
] as const;
export const BOXITY_FLUSH_MS = 20 * 1000;
export const BOXITY_SCORES_PER_CALL = 200;

// Ids from the client's catalogs (upgrades, passes, pets, gear): camelCase slugs.
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
