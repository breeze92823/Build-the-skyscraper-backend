import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("progress", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  it("sends a saved player their progress and saves what they send back", async () => {
    const fake = fakePlayers([{ _id: "dev-u1", cash: 5000, totalBlocks: 900, upgrades: { grab: 2 }, gear: { owned: { jetboots: true }, on: "jetboots" }, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { devId: "dev-u1", username: "Ann" });
    let got: any = null;
    c.onMessage("progress", (m: any) => (got = m));
    c.onMessage("leaderboard", () => {});
    fake.release();
    await sleep(150);
    assert.strictEqual(got?.cash, 5000);
    assert.deepStrictEqual(got?.upgrades, { grab: 2 });
    assert.deepStrictEqual(got?.gear, { owned: { jetboots: true }, on: "jetboots" });
    assert.ok(typeof got?.serverTime === "number");

    c.send("saveProgress", { cash: 7000, strength: 33, tower: { n: 1, floors: 4, blocks: 10 }, hack: 1 });
    await sleep(150);
    const doc = fake.docs.get("dev-u1")! as any;
    assert.strictEqual(doc.cash, 7000);
    assert.strictEqual(doc.strength, 33);
    assert.deepStrictEqual(doc.tower, { n: 1, floors: 4, blocks: 10 });
    assert.strictEqual(doc.totalBlocks, 900, "fields the save does not carry are kept");
    assert.strictEqual(doc.username, "Ann");
    assert.ok(!("hack" in doc));
  });

  it("keeps quick saves in order", async () => {
    const fake = fakePlayers();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { devId: "dev-order" });
    c.onMessage("noProgress", () => {});
    c.onMessage("leaderboard", () => {});
    fake.release();
    await sleep(100);
    for (let i = 1; i <= 20; i++) c.send("saveProgress", { cash: i });
    await sleep(300);
    assert.strictEqual(fake.docs.get("dev-order")!.cash, 20);
  });

  it("creates a new account's save and never saves a guest", async () => {
    const fake = fakePlayers();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { devId: "dev-new1" });
    let none = false;
    c.onMessage("noProgress", () => (none = true));
    c.onMessage("leaderboard", () => {});
    fake.release();
    await sleep(150);
    assert.ok(none);
    c.send("saveProgress", { cash: 10 });
    await sleep(150);
    assert.strictEqual(fake.docs.get("dev-new1")?.cash, 10);

    const guest = await colyseus.connectTo(room, { username: "Gus" });
    guest.onMessage("noProgress", () => {});
    guest.onMessage("leaderboard", () => {});
    await sleep(150);
    guest.send("saveProgress", { cash: 99 });
    await sleep(150);
    assert.strictEqual(fake.docs.size, 1, "a guest is never written");
    assert.strictEqual(room.state.players.get(guest.sessionId)?.signedIn, false);
  });

  it("ignores a save sent before the load answered", async () => {
    const fake = fakePlayers([{ _id: "dev-early", cash: 42, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { devId: "dev-early" });
    c.onMessage("progress", () => {});
    c.onMessage("leaderboard", () => {});
    c.send("saveProgress", { cash: 0 });
    await sleep(100);
    fake.release();
    await sleep(150);
    assert.strictEqual(fake.docs.get("dev-early")!.cash, 42, "a fresh player's defaults never overwrite the stored save");
  });

  it("keeps saving off when the save could not be read", async () => {
    const fake = fakePlayers([{ _id: "dev-u3", cash: 1e9, version: 1, updatedAt: new Date() }]);
    (fake as any).findOne = async () => {
      await fake.gate;
      throw new Error("down");
    };
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { devId: "dev-u3" });
    let failed = false;
    c.onMessage("serverError", () => (failed = true));
    fake.release();
    await sleep(150);
    assert.ok(failed);
    c.send("saveProgress", { cash: 0 });
    await sleep(150);
    assert.strictEqual(fake.docs.get("dev-u3")!.cash, 1e9, "the unread save is never overwritten");
  });

  it("evicts an older session of the same account", async () => {
    const fake = fakePlayers();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const first = await colyseus.connectTo(room, { devId: "dev-twin" });
    first.onMessage("noProgress", () => {});
    first.onMessage("leaderboard", () => {});
    fake.release();
    await sleep(100);
    const second = await colyseus.connectTo(room, { devId: "dev-twin" });
    second.onMessage("noProgress", () => {});
    second.onMessage("leaderboard", () => {});
    await sleep(200);
    assert.strictEqual(room.state.players.has(first.sessionId), false);
    assert.strictEqual(room.state.players.has(second.sessionId), true);
  });
});
