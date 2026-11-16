import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState, TowerState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { INSIDE_SECONDS, NEXT_BUILDING_DELAY_S, TOWER_N_MAX } from "../src/constants.js";
import { BuildRate, TowerRules, buildingFloors, crewOf, floorMin, floorMinutes, floorNeed, sanitizeTowerSeed, type Crew } from "../src/tower.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

const who = (id: string, name = id) => ({ id, name });
// Waits (up to 2 s) for a client's mirror of the room state to catch up.
async function until(check: () => boolean, ms = 2000) {
  for (let t = 0; t < ms && !check(); t += 25) await sleep(25);
}
// A tower whose room's active builders are `crew()` ({ n: 0 } = an empty room: the floor at its minimum).
const fresh = (crew: () => Crew = () => ({ n: 0, rate: 0 })) => {
  const t = new TowerState();
  const rules = new TowerRules(t, crew);
  rules.seed(null, 1000);
  return { t, rules };
};
// Fills the floor in progress (as one builder) and returns the size of the floor that starts next.
const nextFloor = (t: TowerState, rules: TowerRules) => {
  rules.addBlocks(t.need - t.blocks, who("a"), 2000);
  return t.need;
};

describe("tower rules", () => {
  it("sizes floors to the room's pace and the minutes its crowd should take (client tower.js floorNeed)", () => {
    assert.strictEqual(buildingFloors(0), 8);
    assert.strictEqual(buildingFloors(3), 14);
    assert.strictEqual(buildingFloors(99), 40, "capped at floorsMax");
    assert.strictEqual(floorMinutes(0), 2.5, "nobody: a solo floor");
    assert.strictEqual(floorMinutes(1), 2.5, "a lone builder: 2.5 min");
    assert.strictEqual(floorMinutes(2), 4);
    assert.strictEqual(floorMinutes(3), 4.5);
    assert.ok(Math.abs(floorMinutes(5) - 4.9) < 1e-9);
    assert.ok(floorMinutes(50) < 5.5 && floorMinutes(50) > 5.4, "a full room: about 5.5 min");
    assert.strictEqual(floorMin(0), 30);
    assert.strictEqual(floorMin(1), 32);
    assert.strictEqual(floorNeed(0, 0, 2.5), 30, "no pace known: the minimum");
    assert.strictEqual(floorNeed(0, 4, 2.5), 30, "a crawl: still the minimum");
    assert.strictEqual(floorNeed(0, 100, 2.5), 250, "100 blocks/min for 2.5 min");
    assert.strictEqual(floorNeed(0, 1e20, 6), 1e15, "bounded");
  });

  it("measures a builder's pace: their bag first, then what they really placed", () => {
    const r = new BuildRate();
    r.add(0, 50, 0); // a bag of 50: first guess one bag every 50 s = 60 a minute
    assert.strictEqual(r.perMinute(0), 60);
    assert.ok(r.active(0));
    // They actually place 30 a minute: after a full window the guess is gone.
    for (let s = 60; s <= 180; s += 60) r.add(30, 50, s * 1000);
    assert.strictEqual(r.perMinute(180_000), 30);
    // Half way through the window it is half guess, half measured.
    const h = new BuildRate();
    h.add(0, 50, 0);
    h.add(45, 50, 90_000);
    assert.strictEqual(h.perMinute(90_000), (45 * 60) / 180 + 0.5 * 60);
    // Idle longer than `active`: not counted, and back from it they start over from the bag.
    assert.strictEqual(r.active(180_000 + 91_000), false);
    r.add(0, 100, 400_000);
    assert.strictEqual(r.perMinute(400_000), 120);
    assert.deepStrictEqual(crewOf([r, h], 400_000), { n: 1, rate: 120 }, "only active builders count");
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
    assert.deepStrictEqual([t.n, t.floors, t.blocks, t.need, t.phase, t.phaseAt, t.seeded], [2, 5, 30, floorMin(2), "building", 500, true]);
    // A saved floor bigger than this room's floor: one more block finishes it.
    const big = new TowerState();
    new TowerRules(big).seed({ n: 0, floors: 1, blocks: 5000 }, 500);
    assert.deepStrictEqual([big.blocks, big.need], [floorMin(0) - 1, floorMin(0)]);
    assert.strictEqual(rules.seed({ n: 9, floors: 0, blocks: 0 }, 900), false, "later players never reseed it");
    assert.strictEqual(t.n, 2);

    const done = new TowerState();
    new TowerRules(done).seed({ n: 0, floors: 8, blocks: 0 }, 700);
    assert.deepStrictEqual([done.phase, done.phaseAt], ["celebrate", 700]);
  });

  it("sizes a fresh room's first floor by its first builder, rolls floors over and credits who placed them", () => {
    let crew: Crew = { n: 0, rate: 0 };
    const { t, rules } = fresh(() => crew);
    assert.strictEqual(t.need, 30, "seeded in an empty room: the minimum floor");
    crew = { n: 1, rate: 100 }; // a builder placing 100 a minute shows up
    assert.deepStrictEqual(rules.addBlocks(100, who("a", "Ann"), 2000), { taken: 100, built: null });
    // The empty floor is sized again by its first blocks: 100/min x 2.5 min.
    assert.deepStrictEqual([t.floors, t.blocks, t.need, t.placed], [0, 100, 250, 100]);
    const r = rules.addBlocks(150 + 5, who("b", "Bo"), 2000);
    assert.strictEqual(r.taken, 155);
    assert.deepStrictEqual([t.floors, t.blocks, t.need], [1, 5, 250], "the next floor: the same lone pace and minutes");
    assert.strictEqual(rules.addBlocks(0, who("a"), 2000).taken, 0);
    assert.strictEqual(rules.addBlocks(-4, who("a"), 2000).taken, 0);
    assert.strictEqual(rules.addBlocks(NaN, who("a"), 2000).taken, 0);
    assert.strictEqual(rules.addBlocks("9" as any, who("a"), 2000).taken, 0);
  });

  it("makes floors take longer as the room fills, easing in floor by floor (and back out)", () => {
    let crew: Crew = { n: 1, rate: 100 };
    const { t, rules } = fresh(() => crew);
    assert.strictEqual(t.need, 250, "alone: 2.5 min of their pace");
    crew = { n: 5, rate: 500 }; // four friends join mid-floor
    assert.strictEqual(t.need, 250, "the floor in progress never changes");
    // Five should take 4.9 min a floor: the minutes go half way there each floor (3.7, 4.3, 4.6, ...).
    assert.strictEqual(nextFloor(t, rules), 1850);
    assert.strictEqual(nextFloor(t, rules), 2150);
    assert.strictEqual(nextFloor(t, rules), 2300);
    crew = { n: 1, rate: 100 }; // back to one: 3/4 of the way down each floor
    const down = nextFloor(t, rules); // 4.6 - 2.1 x 3/4 = ~3.03 min of 100 a minute
    assert.ok(Math.abs(down - 302.5) <= 1, `${down}`);
  });

  it("finishes the building at the last floor, names the top builders and takes no more blocks", () => {
    const { t, rules } = fresh(() => ({ n: 1, rate: 40 }));
    // Every floor: 40/min x 2.5 min = 100.
    const total = 100 * buildingFloors(0);
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

  it("runs the timeline: celebrate, sinking, then the next building (sized by the last crew)", () => {
    let crew: Crew = { n: 2, rate: 200 };
    const { t, rules } = fresh(() => crew);
    rules.addBlocks(1e12, who("a"), 5000);
    assert.strictEqual(t.phase, "celebrate");
    crew = { n: 0, rate: 0 }; // nobody can build while the lobby is open: they all go idle
    assert.strictEqual(rules.tick(5000 + INSIDE_SECONDS * 1000 - 1), false);
    assert.strictEqual(rules.tick(5000 + INSIDE_SECONDS * 1000), true);
    assert.deepStrictEqual([t.phase, t.phaseAt], ["sinking", 5000 + INSIDE_SECONDS * 1000]);
    const sunk = t.phaseAt;
    assert.strictEqual(rules.tick(sunk + NEXT_BUILDING_DELAY_S * 1000 - 1), false);
    assert.strictEqual(rules.tick(sunk + NEXT_BUILDING_DELAY_S * 1000), true);
    assert.deepStrictEqual([t.n, t.floors, t.blocks, t.phase, t.phaseAt], [1, 0, 0, "building", sunk + NEXT_BUILDING_DELAY_S * 1000]);
    assert.deepStrictEqual(rules.builders(), [], "the new building starts with a clean tally");
    assert.strictEqual(rules.tick(sunk + 1e9), false, "a building in progress never times out");
    assert.strictEqual(t.placed, 0);
    assert.strictEqual(t.need, 800, "the new building's first floor: the last crew's 200/min x 4 min, not the minimum");
  });

  it("shrinks only the rest of a floor when the room slows down, never below what is on it", () => {
    let crew: Crew = { n: 2, rate: 1000 };
    const { t, rules } = fresh(() => crew);
    assert.strictEqual(t.need, 4000);
    rules.addBlocks(1000, who("a"), 2000);
    crew = { n: 2, rate: 800 }; // a little slower: left alone
    rules.tick(2100);
    assert.strictEqual(t.need, 4000);
    crew = { n: 0, rate: 0 }; // everyone idle: left alone (they will be back)
    rules.tick(2150);
    assert.strictEqual(t.need, 4000);
    crew = { n: 1, rate: 500 }; // the strong builder left: the 3000 still to place halve
    rules.tick(2200);
    assert.strictEqual(t.need, 1000 + 1500);
    crew = { n: 3, rate: 5000 };
    rules.tick(2300);
    assert.strictEqual(t.need, 2500, "a faster room never grows a floor that already started");
    crew = { n: 1, rate: 0.1 }; // all but stopped
    rules.tick(2400);
    assert.strictEqual(t.need, 1001, "never below what is on it + 1");
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
    // Floor 0 was sized in the empty room (30), then again by Ann's first blocks: her bag of 100 = 120 a minute,
    // x 2.5 min = 300. Bo joining mid-floor never grows it: 250 on it.
    assert.deepStrictEqual([room.state.tower.floors, room.state.tower.blocks, room.state.tower.need, room.state.tower.placed], [0, 250, 300, 250]);
    await until(() => a.state.tower.blocks === 250 && b.state.tower.blocks === 250);
    assert.deepStrictEqual([a.state.tower.blocks, b.state.tower.blocks, b.state.tower.need], [250, 250, 300], "both clients see it");

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
