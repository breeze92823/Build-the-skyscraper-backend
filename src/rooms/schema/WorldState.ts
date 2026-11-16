import { schema, t, type SchemaType } from "@colyseus/schema";

// The live roster: who is in the room and what the others draw of them. Durable progress lives in
// Mongo (src/db.ts). To sync something new about a player, add a field here and accept it in a
// WorldRoom message (presence.ts bounds it).
export const PlayerState = schema(
  {
    username: t.string().default(""), // verified Bloxity display name (guests: the client-reported one, sanitized)
    signedIn: t.boolean().default(false), // has a verified Bloxity id: only signed-in players are saved
    pfp: t.string().default(""), // Bloxity profile picture URL ("" = none), http(s) only
    uid: t.string().default(""), // the verified account id ("" = guest): Bloxity chat's `userId` matches it
    // Presence (presence.ts, `pose` / `loadout` / `setAvatar` / `emote`): what the others draw.
    x: t.float64().default(0), // feet position, world metres
    y: t.float64().default(0),
    z: t.float64().default(0),
    yaw: t.float32().default(0), // heading, rad
    speed: t.float32().default(0), // m/s, drives the walk / run cycle
    act: t.string().default(""), // activity: "" | "bench" | "chute" (parachute) | "impact" (gear landing) | "fly" | "climb" | "vehicle" | "jet" (Robot Gear)
    rank: t.uint8().default(0), // client RANKS index, for the name tag
    strength: t.float64().default(0), // bulks up the avatar
    gear: t.string().default(""), // worn Robot Gear id ("" = none)
    avatar: t.string().default(""), // Bloxity look JSON { equipped (ids), proportions }, "" = default
    emote: t.string().default(""), // the Bloxity emote id playing ("" = none)
    emoteAt: t.float64().default(0), // server time (ms) it started: clients replay when it changes
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

// The room's shared tower (tower.ts holds the rules): every client displays it (client tower.js `sync`).
export const TowerState = schema(
  {
    n: t.uint32().default(0), // building index (the look is the client's pickBuilding(n))
    floors: t.uint16().default(0), // finished floors of this building
    blocks: t.float64().default(0), // blocks in the floor being built
    need: t.float64().default(0), // blocks the floor being built needs (sized to the room's bags when it started)
    placed: t.float64().default(0), // blocks placed on this building so far (all floors)
    phase: t.string().default("building"), // "building" | "celebrate" | "sinking"
    phaseAt: t.float64().default(0), // server clock (ms) the phase began
    seeded: t.boolean().default(false), // the room's tower has its starting state (clients wait for it)
  },
  "TowerState",
);
export type TowerState = SchemaType<typeof TowerState>;

export const WorldState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
    tower: t.ref(TowerState),
  },
  "WorldState",
);
export type WorldState = SchemaType<typeof WorldState>;
