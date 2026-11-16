import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState, TowerState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { INSIDE_SECONDS, NEXT_BUILDING_DELAY_S } from "../src/constants.js";
import { TowerRules, buildingFloors, buildingTotal, floorNeed, sanitizeTowerSeed } from "../src/tower.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

const who = (id: string, name = id) => ({ id, name });
// Waits (up to 2 s) for a client's mirror of the room state to catch up.
async function until(check: () => boolean, ms = 2000) {
  for (let t = 0; t < ms && !check(); t += 25) await sleep(25);
}
const fresh = () => {
  const t = new TowerState();
  const rules = new TowerRules(t);
  rules.seed(null, 1000);
  return { t, rules };
};

describe("tower rules", () => {
  it("sizes buildings like the client's buildingSpec", () => {
    assert.strictEqual(buildingFloors(0), 18);
    assert.strictEqual(buildingFloors(3), 36);
    assert.strictEqual(buildingFloors(99), 70, "capped at floorsMax");
    assert.strictEqual(floorNeed(0, 0), 220);
    assert.strictEqual(floorNeed(0, 17), 410); // round(220 * 1.85 / 10) * 10
    assert.strictEqual(floorNeed(1, 0), 470); // round(220 * 2.15 / 10) * 10
    assert.strictEqual(buildingTotal(0), [...Array(18).keys()].reduce((a, f) => a + floorNeed(0, f), 0));
  });

  it("bounds a saved tower", () => {
    assert.strictEqual(sanitizeTowerSeed(null), null);
    assert.strictEqual(sanitizeTowerSeed({ floors: 3 }), null);
    assert.deepStrictEqual(sanitizeTowerSeed({ n: 2.9, floors: 4.5, blocks: 7.7 }), { n: 2, floors: 4, blocks: 7 });
    assert.strictEqual(sanitizeTowerSeed({ n: 1e9, floors: 0, blocks: 0 })!.n, 200);
    assert.strictEqual(sanitizeTowerSeed({ n: 0, floors: 5, blocks: 1e9 })!.blocks, floorNeed(0, 5), "never more than the floor needs");
    assert.deepStrictEqual(sanitizeTowerSeed({ n: 0, floors: 99, blocks: 50 }), { n: 0, floors: 18, blocks: 0 }, "a finished building has no open floor");
  });

  it("seeds once; a finished saved building starts its celebration", () => {
    const t = new TowerState();
    const rules = new TowerRules(t);
    assert.strictEqual(t.seeded, false);
    assert.ok(rules.seed({ n: 2, floors: 5, blocks: 30 }, 500));
    assert.deepStrictEqual([t.n, t.floors, t.blocks, t.phase, t.phaseAt, t.seeded], [2, 5, 30, "building", 500, true]);
    assert.strictEqual(rules.seed({ n: 9, floors: 0, blocks: 0 }, 900), false, "later players never reseed it");
    assert.strictEqual(t.n, 2);

    const done = new TowerState();
    new TowerRules(done).seed({ n: 0, floors: 18, blocks: 0 }, 700);
    assert.deepStrictEqual([done.phase, done.phaseAt], ["celebrate", 700]);
  });

  it("adds blocks, rolls floors over and credits who placed them", () => {
    const { t, rules } = fresh();
    assert.deepStrictEqual(rules.addBlocks(100, who("a", "Ann"), 2000), { taken: 100, built: null });
    assert.deepStrictEqual([t.floors, t.blocks], [0, 100]);
    // 120 finish floor 0 (needs 220); the next floor needs 230 (round(220 * 1.05 / 10) * 10).
    const r = rules.addBlocks(120 + 230 + 5, who("b", "Bo"), 2000);
    assert.strictEqual(r.taken, 355);
    assert.deepStrictEqual([t.floors, t.blocks], [2, 5]);
    assert.strictEqual(rules.addBlocks(0, who("a"), 2000).taken, 0);
    assert.strictEqual(rules.addBlocks(-4, who("a"), 2000).taken, 0);
    assert.strictEqual(rules.addBlocks(NaN, who("a"), 2000).taken, 0);
    assert.strictEqual(rules.addBlocks("9" as any, who("a"), 2000).taken, 0);
  });

  it("finishes the building at the last floor, names the top builders and takes no more blocks", () => {
    const { t, rules } = fresh();
    rules.addBlocks(1000, who("a", "Ann"), 2000);
    rules.addBlocks(500, who("b", "Bo"), 2000);
    rules.addBlocks(200, who("a", "Ann2"), 2000);
    const rest = buildingTotal(0) - 1700;
    const r = rules.addBlocks(1e12, who("c", "Cy"), 3000);
    assert.strictEqual(r.taken, rest, "never more than the building still needs");
    assert.deepStrictEqual([t.phase, t.phaseAt, t.floors, t.blocks], ["celebrate", 3000, 18, 0]);
    assert.deepStrictEqual(r.built, {
      n: 0,
      builders: [
        { id: "c", name: "Cy", blocks: rest },
        { id: "a", name: "Ann2", blocks: 1200 },
        { id: "b", name: "Bo", blocks: 500 },
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
    const a = await colyseus.connectTo(room, { username: "Ann", tower: { n: 1, floors: 3, blocks: 40 } });
    a.onMessage("noProgress", () => {});
    a.onMessage("leaderboard", () => {});
    await sleep(150);
    assert.deepStrictEqual([room.state.tower.seeded, room.state.tower.n, room.state.tower.floors, room.state.tower.blocks], [true, 1, 3, 40]);

    const b = await colyseus.connectTo(room, { username: "Bo", tower: { n: 7, floors: 9, blocks: 9 } });
    b.onMessage("noProgress", () => {});
    b.onMessage("leaderboard", () => {});
    await sleep(150);
    assert.strictEqual(room.state.tower.n, 1, "a later player adopts the room's tower, not theirs");
    // The client mirror sees the same numbers.
    await until(() => b.state.tower?.seeded === true);
    assert.deepStrictEqual([b.state.tower.n, b.state.tower.floors, b.state.tower.blocks, b.state.tower.seeded], [1, 3, 40, true]);
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
    a.send("build", { blocks: 100 });
    b.send("build", { blocks: 150 });
    await sleep(150);
    assert.deepStrictEqual([room.state.tower.floors, room.state.tower.blocks], [1, 30], "100 + 150 = floor 0 (220) + 30");
    await until(() => a.state.tower.floors === 1 && b.state.tower.blocks === 30);
    assert.deepStrictEqual([a.state.tower.floors, b.state.tower.blocks], [1, 30], "both clients see it");

    a.send("build", { blocks: 1e12 });
    await sleep(150);
    assert.strictEqual(room.state.tower.phase, "celebrate");
    assert.strictEqual(room.state.tower.floors, buildingFloors(0));
    assert.strictEqual(built.length, 2, "both players got `built`");
    assert.deepStrictEqual(built[0].builders.map((x: any) => x.name), ["Ann", "Bo"]);
    assert.strictEqual(built[0].builders[0].blocks + built[0].builders[1].blocks, buildingTotal(0));

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
