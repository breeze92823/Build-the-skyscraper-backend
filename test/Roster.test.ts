import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("roster", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("lists every player with a bounded name and an http(s) picture only", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { username: "Ann", pfp: "https://static.bloxity.io/img/pfps/3.png" });
    const b = await colyseus.connectTo(room, { username: "B".repeat(500), pfp: "javascript:alert(1)" });
    await sleep(50);
    const pa = room.state.players.get(a.sessionId)!;
    const pb = room.state.players.get(b.sessionId)!;
    assert.strictEqual(room.state.players.size, 2);
    assert.deepStrictEqual([pa.username, pa.signedIn, pa.uid], ["Ann", false, ""]);
    assert.strictEqual(pa.pfp, "https://static.bloxity.io/img/pfps/3.png");
    assert.strictEqual(pb.username.length, 64);
    assert.strictEqual(pb.pfp, "", "only http(s) pictures are relayed");
  });

  it("drops a player from the roster when they leave", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { username: "Ann" });
    await sleep(50);
    assert.strictEqual(room.state.players.size, 1);
    await a.leave();
    await sleep(100);
    assert.strictEqual(room.state.players.size, 0);
  });
});
