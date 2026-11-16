import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setFetchForTest, reportRoomsOnce } from "../src/legion-room-reporter.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("room reporter (Bloxity Open Rooms)", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  const saved = { ...process.env };
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => {
    process.env = { ...saved };
    __setFetchForTest(null);
  });

  it("does nothing outside a Bloxity deployment (no token / matchmaker url)", async () => {
    delete process.env.BLOXITY_REPORT_TOKEN;
    delete process.env.MATCHMAKER_REPORT_URL;
    let calls = 0;
    __setFetchForTest((async () => {
      calls++;
      return new Response("{}");
    }) as unknown as typeof fetch);
    assert.strictEqual(await reportRoomsOnce(), false);
    assert.strictEqual(calls, 0);
  });

  it("posts this pod's live rooms to the matchmaker, filed under the game id", async () => {
    process.env.BLOXITY_REPORT_TOKEN = "report-token";
    process.env.MATCHMAKER_REPORT_URL = "https://play.example.test/v1/dir/";
    process.env.BLOXITY_GAME_ID = "build-the-skyscraper";
    process.env.POD_NAME = "pod-7";
    const calls: { url: string; auth: string; body: any }[] = [];
    __setFetchForTest((async (url: string, init: any) => {
      calls.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);

    const room = await colyseus.createRoom<WorldState>("world", {});
    await colyseus.connectTo(room, { username: "Ann" });
    await colyseus.connectTo(room, { username: "Bo" });
    await sleep(100);
    assert.strictEqual(await reportRoomsOnce(), true);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, "https://play.example.test/v1/dir/build-the-skyscraper/rooms");
    assert.strictEqual(calls[0].auth, "Bearer report-token");
    assert.strictEqual(calls[0].body.podName, "pod-7");
    const mine = calls[0].body.rooms.find((r: any) => r.colyseusRoomId === room.roomId);
    assert.ok(mine, "the live room is listed");
    assert.deepStrictEqual([mine.name, mine.clients, mine.maxClients, mine.locked, mine.private], ["world", 2, 50, false, false]);
    assert.ok(calls[0].body.players >= 2);
  });

  it("survives a failing or unreachable matchmaker", async () => {
    process.env.BLOXITY_REPORT_TOKEN = "report-token";
    process.env.MATCHMAKER_REPORT_URL = "https://play.example.test/v1/dir";
    __setFetchForTest((async () => new Response("no", { status: 503 })) as unknown as typeof fetch);
    assert.strictEqual(await reportRoomsOnce(), false);
    __setFetchForTest((async () => {
      throw new Error("down");
    }) as unknown as typeof fetch);
    assert.strictEqual(await reportRoomsOnce(), false);
  });
});
