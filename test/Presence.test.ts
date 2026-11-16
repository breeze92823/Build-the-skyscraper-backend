import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { AVATAR_MAX_LEN, POSE_BOUNDS } from "../src/constants.js";
import { sanitizeAvatar } from "../src/presence.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

const EMOTE = "000000000000000000000e01";

describe("presence", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("takes the pose, loadout and look from the join options", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, {
      username: "Ann",
      pose: { x: 3, y: 0.5, z: -12, yaw: Math.PI, speed: 4, act: "bench" },
      loadout: { rank: 7, strength: 1234.5, gear: "mech" },
      avatar: JSON.stringify({ equipped: { hatId: "h1", skinId: 4 }, proportions: { height: 1.2 } }),
    });
    await sleep(50);
    const p = room.state.players.get(a.sessionId)!;
    assert.deepStrictEqual([p.x, p.y, p.z, p.speed, p.act], [3, 0.5, -12, 4, "bench"]);
    assert.ok(Math.abs(Math.abs(p.yaw) - Math.PI) < 1e-5);
    assert.deepStrictEqual([p.rank, p.strength, p.gear], [7, 1234.5, "mech"]);
    assert.deepStrictEqual(JSON.parse(p.avatar), { equipped: { hatId: "h1", skinId: "4" }, proportions: { height: 1.2 } });
  });

  it("bounds pose and loadout updates and ignores junk", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, {});
    a.send("pose", { x: 1e9, y: -1e9, z: NaN, yaw: 7, speed: -5, act: "teleport" });
    a.send("loadout", { rank: 9999, strength: -1, gear: "Bad Gear!" });
    await sleep(50);
    const p = room.state.players.get(a.sessionId)!;
    assert.strictEqual(p.x, POSE_BOUNDS.xy);
    assert.strictEqual(p.y, -POSE_BOUNDS.y);
    assert.strictEqual(p.z, 0);
    assert.strictEqual(p.speed, 0);
    assert.strictEqual(p.act, "");
    assert.ok(Math.abs(p.yaw) <= Math.PI);
    assert.deepStrictEqual([p.rank, p.strength, p.gear], [255, 0, ""]);
    a.send("pose", { x: 4, act: "bench" });
    await sleep(50);
    assert.deepStrictEqual([p.x, p.act], [4, "bench"]);
    a.send("pose", { act: "" });
    await sleep(50);
    assert.strictEqual(p.act, "");
  });

  it("relays the parachute, landing and Robot Gear acts, nothing else", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, {});
    await sleep(50);
    const p = room.state.players.get(a.sessionId)!;
    for (const act of ["chute", "impact", "fly", "climb", "vehicle", "jet", ""]) {
      a.send("pose", { act });
      await sleep(50);
      assert.strictEqual(p.act, act);
    }
    a.send("pose", { act: "chute" });
    a.send("pose", { act: "jetpack" });
    await sleep(50);
    assert.strictEqual(p.act, "chute");
  });

  it("rebuilds the avatar from allowlisted ids: no URLs, no extra fields", () => {
    const look = sanitizeAvatar(
      JSON.stringify({
        equipped: { hatId: "hat_1", skinId: 12, backId: "https://evil.example/x.obj", bogus: "x", faceId: "-1" },
        proportions: { height: 9, headScale: 0.01, armLength: "x", extra: 1 },
        skin: "https://static.example/skin.png",
      }),
    )!;
    assert.deepStrictEqual(JSON.parse(look), { equipped: { hatId: "hat_1", skinId: "12", faceId: "-1" }, proportions: { height: 3, headScale: 0.1 } });
    assert.strictEqual(sanitizeAvatar(""), "");
    assert.strictEqual(sanitizeAvatar("not json"), null);
    assert.strictEqual(sanitizeAvatar("x".repeat(AVATAR_MAX_LEN + 1)), null);
    assert.strictEqual(sanitizeAvatar(7), null);
  });

  it("keeps the look through a bad update and relays emotes with the server clock", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, {});
    a.send("setAvatar", { avatar: JSON.stringify({ equipped: { hatId: "h2" } }) });
    await sleep(50);
    const p = room.state.players.get(a.sessionId)!;
    assert.deepStrictEqual(JSON.parse(p.avatar), { equipped: { hatId: "h2" } });
    a.send("setAvatar", { avatar: "not json" });
    await sleep(50);
    assert.deepStrictEqual(JSON.parse(p.avatar), { equipped: { hatId: "h2" } });

    const before = Date.now();
    a.send("emote", { id: EMOTE });
    await sleep(50);
    assert.strictEqual(p.emote, EMOTE);
    assert.ok(p.emoteAt >= before);
    a.send("emote", { id: "../../etc" });
    await sleep(50);
    assert.strictEqual(p.emote, EMOTE, "a malformed id is ignored");
    a.send("emote", { id: "" });
    await sleep(50);
    assert.strictEqual(p.emote, "");
  });
});
