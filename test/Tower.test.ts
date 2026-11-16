import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState, TowerState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { INSIDE_SECONDS, NEXT_BUILDING_DELAY_S, TOWER_N_MAX } from "../src/constants.js";
import { TowerRules, buildingFloors, floorMin, floorNeed, floorTrips, sanitizeTowerSeed } from "../src/tower.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

const who = (id: string, name = id) => ({ id, name });
// Waits (up to 2 s) for a client's mirror of the room state to catch up.
async function until(check: () => boolean, ms = 2000) {
  for (let t = 0; t < ms && !check(); t += 25) await sleep(25);
}
// A tower whose room's active bags add up to `trip()` (0 = an empty room: every floor at its minimum).
const fresh = (trip: () => number = () => 0) => {
  const t = new TowerState();
  const rules = new TowerRules(t, trip);
  rules.seed(null, 1000);
  return { t, rules };
};
// Blocks building n takes when the room's bags stay at `trip` all the way up.
const totalAt = (n: number, trip: number) => [...Array(buildingFloors(n)).keys()].reduce((a, f) => a + floorNeed(n, f, trip), 0);

describe("tower rules", () => {
  it("sizes floors to the room's bags (client tower.js floorNeed)", () => {
    assert.strictEqual(buildingFloors(0), 8);
    assert.strictEqual(buildingFloors(3), 14);
    assert.strictEqual(buildingFloors(99), 40, "capped at floorsMax");
    assert.strictEqual(floorTrips(0), 1.2);
    assert.strictEqual(floorTrips(99), 3, "capped at tripsMax");
    assert.strictEqual(floorMin(0, 0), 30);
    assert.strictEqual(floorNeed(0, 0, 0), 30, "an empty room: the minimum");
    assert.strictEqual(floorNeed(0, 0, 10), 30, "a tiny bag: still the minimum");
    assert.strictEqual(floorNeed(0, 0, 100), 120, "1.2 bags of 100");
    assert.strictEqual(floorNeed(0, 10, 100), 156, "x (1 + 10 * 0.03) higher up");
    assert.strictEqual(floorNeed(5, 0, 1000), 1800, "1.8 bags at building 5");
    assert.strictEqual(floorNeed(99, 0, 1e6), 3e6, "3 bags at most");
  });

  it("bounds a saved tower", () => {
    assert.strictEqual(sanitizeTowerSeed(null), null);
    assert.strictEqual(sanitizeTowerSeed({ floors: 3 }), null);
    assert.deepStrictEqual(sanitizeTowerSeed({ n: 2.9, floors: 4.5, blocks: 7.7 }), { n: 2, floors: 4, blocks: 7 });
    assert.strictEqual(sanitizeTowerSeed({ n: 1e9, floors: 0, blocks: 0 })!.n, TOWER_N_MAX);
    assert.strictEqual(sanitizeTowerSeed({ n: 0, floors: 5, blocks: 1e15 })!.blocks, 1e13, "bounded");
    assert.deepStrictEqual(sanitizeTowerSeed({ n: 0, floors: 99, blocks: 50 }), { n: 0, floors: 8, blocks: 0 }, "a finished building has no open floor");
  });

  it("seeds once; a finished saved building starts its celebration", () => {
    const t = new TowerState();
    const rules = new TowerRules(t);
    assert.strictEqual(t.seeded, false);
    assert.ok(rules.seed({ n: 2, floors: 5, blocks: 30 }, 500));
    assert.deepStrictEqual([t.n, t.floors, t.blocks, t.need, t.phase, t.phaseAt, t.seeded], [2, 5, 30, floorMin(2, 5), "building", 500, true]);
    // A saved floor bigger than this room's floor: one more block finishes it.
    const big = new TowerState();
    new TowerRules(big).seed({ n: 0, floors: 1, blocks: 5000 }, 500);
    assert.deepStrictEqual([big.blocks, big.need], [floorMin(0, 1) - 1, floorMin(0, 1)]);
    assert.strictEqual(rules.seed({ n: 9, floors: 0, blocks: 0 }, 900), false, "later players never reseed it");
    assert.strictEqual(t.n, 2);

    const done = new TowerState();
    new TowerRules(done).seed({ n: 0, floors: 8, blocks: 0 }, 700);
    assert.deepStrictEqual([done.phase, done.phaseAt], ["celebrate", 700]);
  });

  it("adds blocks, rolls floors over (each sized when it starts) and credits who placed them", () => {
    let trip = 0;
    const { t, rules } = fresh(() => trip);
    assert.strictEqual(t.need, 30, "seeded in an empty room: the minimum floor");
    trip = 200; // a builder with a 200-block bag shows up
    assert.deepStrictEqual(rules.addBlocks(100, who("a", "Ann"), 2000), { taken: 100, built: null });
    // 30 finish floor 0; floor 1 is sized to the room now: 1.2 x 200 x 1.03 = 247.
    assert.deepStrictEqual([t.floors, t.blocks, t.need, t.placed], [1, 70, 247, 100]);
    const r = rules.addBlocks(177 + 5, who("b", "Bo"), 2000);
    assert.strictEqual(r.taken, 182);
    assert.deepStrictEqual([t.floors, t.blocks, t.need], [2, 5, floorNeed(0, 2, 200)]);
    assert.strictEqual(rules.addBlocks(0, who("a"), 2000).taken, 0);
    assert.strictEqual(rules.addBlocks(-4, who("a"), 2000).taken, 0);
    assert.strictEqual(rules.addBlocks(NaN, who("a"), 2000).taken, 0);
    assert.strictEqual(rules.addBlocks("9" as any, who("a"), 2000).taken, 0);
  });

  it("finishes the building at the last floor, names the top builders and takes no more blocks", () => {
    const { t, rules } = fresh(() => 100);
    // Seeded in a room of bags of 100: every floor is sized to them.
    const total = totalAt(0, 100);
    rules.addBlocks(100, who("a", "Ann"), 2000);
    rules.addBlocks(150, who("b", "Bo"), 2000);
    rules.addBlocks(100, who("a", "Ann2"), 2000);
    const rest = total - 350;
    const r = rules.addBlocks(1e12, who("c", "Cy"), 3000);
    assert.strictEqual(r.taken, rest, "never more than the building still needs");
    assert.deepStrictEqual([t.phase, t.phaseAt, t.floors, t.blocks, t.placed], ["celebrate", 3000, 8, 0, total]);
    assert.deepStrictEqual(r.built, {
      n: 0,
      builders: [
        { id: "c", name: "Cy", blocks: rest },
        { id: "a", name: "Ann2", blocks: 200 },
        { id: "b", name: "Bo", blocks: 150 },
      ],
    });
    assert.strictEqual(rules.addBlocks(50, who("a"), 3100).taken, 0, "a finished building is closed");
  });

  it("runs the timeline: celebrate, sinking, then the next building", () => {
    const { t, rules } = fresh();
    rules.addBlocks(1e12, who("a"), 5000);
    assert.strictEqual(t.phase, "celebrate");
    assert.strictEqual(rules.tick(5000 + INSIDE_SECONDS * 1000 - 1), false);
    assert.strictEqual(rules.tick(5000 + INSIDE_SECONDS * 1000), true);
    assert.deepStrictEqual([t.phase, t.phaseAt], ["sinking", 5000 + INSIDE_SECONDS * 1000]);
    const sunk = t.phaseAt;
    assert.strictEqual(rules.tick(sunk + NEXT_BUILDING_DELAY_S * 1000 - 1), false);
    assert.strictEqual(rules.tick(sunk + NEXT_BUILDING_DELAY_S * 1000), true);
    assert.deepStrictEqual([t.n, t.floors, t.blocks, t.phase, t.phaseAt], [1, 0, 0, "building", sunk + NEXT_BUILDING_DELAY_S * 1000]);
    assert.deepStrictEqual(rules.builders(), [], "the new building starts with a clean tally");
    assert.strictEqual(rules.tick(sunk + 1e9), false, "a building in progress never times out");
    assert.deepStrictEqual([t.placed, t.need], [0, floorMin(1, 0)], "the new building's first floor is sized again");
  });

  it("shrinks the floor when the room gets weaker, never below what is on it", () => {
    let trip = 0;
    const { t, rules } = fresh(() => trip);
    trip = 1000;
    rules.addBlocks(30, who("a"), 2000); // floor 0 (the minimum) done; floor 1 sized to bags of 1000
    assert.deepStrictEqual([t.floors, t.need], [1, floorNeed(0, 1, 1000)]);
    rules.addBlocks(500, who("a"), 2000);
    trip = 0; // the strong builder left
    rules.tick(2100);
    assert.strictEqual(t.need, 501, "the next block finishes it");
    rules.addBlocks(1, who("b"), 2200);
    assert.deepStrictEqual([t.floors, t.need], [2, floorMin(0, 2)]);
    trip = 50;
    rules.tick(2300);
    assert.strictEqual(t.need, floorMin(0, 2), "a stronger room never grows a floor that already started");
  });
});

describe("shared tower in a room", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  it("seeds a fresh room from the first player's offered tower and everyone shares it", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    assert.strictEqual(room.state.tower.seeded, false);
    const a = await colyseus.connectTo(room, { username: "Ann", tower: { n: 1, floors: 3, blocks: 20 } });
    a.onMessage("noProgress", () => {});
    a.onMessage("leaderboard", () => {});
    await sleep(150);
    assert.deepStrictEqual([room.state.tower.seeded, room.state.tower.n, room.state.tower.floors, room.state.tower.blocks], [true, 1, 3, 20]);

    const b = await colyseus.connectTo(room, { username: "Bo", tower: { n: 7, floors: 9, blocks: 9 } });
    b.onMessage("noProgress", () => {});
    b.onMessage("leaderboard", () => {});
    await sleep(150);
    assert.strictEqual(room.state.tower.n, 1, "a later player adopts the room's tower, not theirs");
    // The client mirror sees the same numbers.
    await until(() => b.state.tower?.seeded === true);
    assert.deepStrictEqual([b.state.tower.n, b.state.tower.floors, b.state.tower.blocks, b.state.tower.seeded], [1, 3, 20, true]);
  });

  it("prefers a signed-in player's stored tower over what their browser offers", async () => {
    const fake = fakePlayers([{ _id: "dev-t1", tower: { n: 2, floors: 6, blocks: 11 }, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { devId: "dev-t1", tower: { n: 0, floors: 0, blocks: 0 } });
    c.onMessage("progress", () => {});
    c.onMessage("leaderboard", () => {});
    fake.release();
    await sleep(200);
    assert.deepStrictEqual([room.state.tower.n, room.state.tower.floors, room.state.tower.blocks], [2, 6, 11]);
  });

  it("starts at building 0 when nobody has a tower, and seeds even if the save cannot be read", async () => {
    const fake = fakePlayers();
    (fake as any).findOne = async () => {
      await fake.gate;
      throw new Error("down");
    };
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { devId: "dev-t2" });
    c.onMessage("serverError", () => {});
    fake.release();
    await sleep(150);
    assert.deepStrictEqual([room.state.tower.seeded, room.state.tower.n, room.state.tower.floors, room.state.tower.phase], [true, 0, 0, "building"]);
  });

  it("adds every player's blocks to the one tower and tells everyone when it is finished", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { username: "Ann" });
    const b = await colyseus.connectTo(room, { username: "Bo" });
    const built: any[] = [];
    for (const c of [a, b]) {
      c.onMessage("noProgress", () => {});
      c.onMessage("leaderboard", () => {});
      c.onMessage("built", (m: any) => built.push(m));
    }
    await sleep(150);
    a.send("build", { blocks: 100, trip: 100 });
    await sleep(100);
    b.send("build", { blocks: 150, trip: 100 });
    await sleep(150);
    // Floor 0 was sized in the empty room (30); Ann's other 70 go into floor 1, sized to her bag (1.2 x 100
    // x 1.03 = 124); Bo's first 54 finish it and floor 2 is sized to both bags (1.2 x 200 x 1.06 = 254): 96 on it.
    assert.deepStrictEqual([room.state.tower.floors, room.state.tower.blocks, room.state.tower.need, room.state.tower.placed], [2, 96, 254, 250]);
    await until(() => a.state.tower.floors === 2 && b.state.tower.blocks === 96);
    assert.deepStrictEqual([a.state.tower.floors, b.state.tower.blocks, b.state.tower.need], [2, 96, 254], "both clients see it");

    a.send("build", { blocks: 1e12 });
    await sleep(150);
    assert.strictEqual(room.state.tower.phase, "celebrate");
    assert.strictEqual(room.state.tower.floors, buildingFloors(0));
    assert.strictEqual(built.length, 2, "both players got `built`");
    assert.deepStrictEqual(built[0].builders.map((x: any) => x.name), ["Ann", "Bo"]);
    assert.strictEqual(built[0].builders[0].blocks + built[0].builders[1].blocks, room.state.tower.placed);

    a.send("build", { blocks: 10 });
    await sleep(100);
    assert.strictEqual(room.state.tower.phase, "celebrate", "no more blocks once finished");
  });

  it("ignores junk and floods", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { username: "Ann" });
    a.onMessage("noProgress", () => {});
    a.onMessage("leaderboard", () => {});
    await sleep(120);
    a.send("build", { blocks: "50" });
    a.send("build", { blocks: -5 });
    a.send("build", { blocks: NaN });
    a.send("build", {});
    a.send("build");
    await sleep(100);
    assert.strictEqual(room.state.tower.blocks, 0);
    for (let i = 0; i < 60; i++) a.send("build", { blocks: 1 });
    await sleep(150);
    assert.ok(room.state.tower.blocks >= 15 && room.state.tower.blocks <= 30, `a flood is rate limited (took ${room.state.tower.blocks} of 60)`);
  });

  it("advances the timeline on the room clock", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { username: "Ann" });
    a.onMessage("noProgress", () => {});
    a.onMessage("leaderboard", () => {});
    await sleep(120);
    a.send("build", { blocks: 1e12 });
    await sleep(100);
    assert.strictEqual(room.state.tower.phase, "celebrate");
    // Pretend the lobby has been open the whole time: the next tick moves on.
    room.state.tower.phaseAt = Date.now() - INSIDE_SECONDS * 1000 - 1;
    await sleep(450);
    assert.strictEqual(room.state.tower.phase, "sinking");
    room.state.tower.phaseAt = Date.now() - NEXT_BUILDING_DELAY_S * 1000 - 1;
    await sleep(450);
    assert.deepStrictEqual([room.state.tower.n, room.state.tower.phase, room.state.tower.floors], [1, "building", 0]);
  });
});
