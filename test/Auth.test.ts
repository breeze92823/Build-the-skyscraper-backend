import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setFetchForTest, devIdentity, verifyToken } from "../src/auth.js";
import { __setPlayersForTest } from "../src/db.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

// A Bloxity answer for a given token: tokens "good-*" verify to that account, anything else is a 401.
function fakeBloxity(calls: { url: string; auth: string; body: any }[] = []): typeof fetch {
  return (async (url: string, init: any) => {
    const auth = init.headers.Authorization as string;
    calls.push({ url, auth, body: JSON.parse(init.body) });
    const token = auth.replace("Bearer ", "");
    if (!token.startsWith("good-")) return new Response("{}", { status: 401 });
    const id = token.slice(5);
    return new Response(JSON.stringify({ valid: true, user: { _id: id, username: `u_${id}`, displayName: `Name ${id}`, pfp: "https://static.bloxity.io/p.png" } }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("auth", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => {
    __setFetchForTest(null);
    __setPlayersForTest(null);
  });

  it("verifies a token against Bloxity and uses only the returned user id", async () => {
    const calls: any[] = [];
    __setFetchForTest(fakeBloxity(calls));
    const id = await verifyToken("good-abc");
    assert.deepStrictEqual(id, { userId: "abc", username: "Name abc", pfp: "https://static.bloxity.io/p.png" });
    assert.ok(calls[0].url.endsWith("/v1/auth/game-token/verify"));
    assert.strictEqual(calls[0].auth, "Bearer good-abc");
    assert.deepStrictEqual(calls[0].body, { gameSlug: "build-the-skyscraper" });
    assert.strictEqual(await verifyToken("bad"), null, "401 = guest");
    assert.strictEqual(await verifyToken(""), null);
    assert.strictEqual(await verifyToken(42), null);
    __setFetchForTest((async () => {
      throw new Error("down");
    }) as unknown as typeof fetch);
    assert.strictEqual(await verifyToken("good-abc"), null, "unverifiable = guest, never a client id");
  });

  it("never trusts an id the client sends: a forged userId is a guest, a good token is the account", async () => {
    __setFetchForTest(fakeBloxity());
    const fake = fakePlayers([{ _id: "victim", cash: 777, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const forged = await colyseus.connectTo(room, { userId: "victim", token: "bad", username: "Eve" });
    const real = await colyseus.connectTo(room, { token: "good-victim", username: "ignored" });
    let got: any = null;
    let mine: any = null;
    forged.onMessage("progress", (m: any) => (got = m));
    forged.onMessage("noProgress", () => {});
    forged.onMessage("leaderboard", () => {});
    real.onMessage("progress", (m: any) => (mine = m));
    real.onMessage("leaderboard", () => {});
    fake.release();
    await sleep(200);
    assert.strictEqual(got, null, "a forged id loads nothing");
    assert.strictEqual(mine?.cash, 777, "the verified token loads the account");
    forged.send("saveProgress", { cash: 1 });
    await sleep(100);
    assert.strictEqual(fake.docs.get("victim")!.cash, 777, "a guest save never reaches the account");
    assert.strictEqual(room.state.players.get(forged.sessionId)!.signedIn, false);
    const p = room.state.players.get(real.sessionId)!;
    assert.deepStrictEqual([p.signedIn, p.uid, p.username], [true, "victim", "Name victim"]);
  });

  it("honours a dev id only outside production", () => {
    assert.deepStrictEqual(devIdentity({ devId: "dev-ab12", username: "Dev One" }), { userId: "dev-ab12", username: "Dev One", pfp: "" });
    assert.strictEqual(devIdentity({ devId: "guest-ab12" }), null);
    assert.strictEqual(devIdentity({ devId: "dev-../x" }), null);
    const was = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      assert.strictEqual(devIdentity({ devId: "dev-ab12" }), null);
    } finally {
      if (was === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = was;
    }
  });
});
