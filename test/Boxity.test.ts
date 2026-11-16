import assert from "assert";

import { __setFetchForTest, flushBoxity, legionId, reportPlayer } from "../src/boxity.js";

type Call = { url: string; auth: string; body: any };

function fakeApi(calls: Call[], answer = { status: 200 }): typeof fetch {
  return (async (url: string, init: any) => {
    calls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, dropped: {} }), { status: answer.status });
  }) as unknown as typeof fetch;
}

describe("Bloxity reporting", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.BLOXITY_REPORT_TOKEN = "report-token";
    process.env.BLOXITY_GAME_ID = "build-the-skyscraper";
    process.env.BLOXITY_API_URL = "https://api.example.test/";
  });
  afterEach(() => {
    process.env = { ...saved };
    __setFetchForTest(null);
  });

  it("maps account ids to legion identities and never reports dev ids", () => {
    assert.strictEqual(legionId("abc"), "legion_abc");
    assert.strictEqual(legionId("legion_abc#m1"), "legion_abc");
    assert.strictEqual(legionId("dev-ab12"), "");
    assert.strictEqual(legionId("bad id!"), "");
  });

  it("reports boards (declared once) and stats from the saved values, only what changed", async () => {
    const calls: Call[] = [];
    __setFetchForTest(fakeApi(calls));
    reportPlayer("u1", { totalBlocks: 1500.7, buildings: 2, cash: 40, strength: 0, speed: 3, playtime: 600 });
    await flushBoxity();
    const boards = calls.find((c) => c.url.includes("/leaderboards/hosted/"))!;
    assert.strictEqual(boards.url, "https://api.example.test/v1/leaderboards/hosted/build-the-skyscraper/report");
    assert.strictEqual(boards.auth, "Bearer report-token");
    assert.deepStrictEqual(boards.body.boards.map((b: any) => b.id), ["blocks", "buildings", "strength", "speed", "cash", "playtime"]);
    assert.ok(!("stat" in boards.body.boards[0]));
    const byBoard = Object.fromEntries(boards.body.scores.map((s: any) => [s.board, s]));
    assert.strictEqual(byBoard.blocks.userId, "legion_u1");
    assert.strictEqual(byBoard.blocks.score, 1500);
    assert.ok(!("strength" in byBoard), "a zero score is not reported");

    const stats = calls.find((c) => c.url.endsWith("/v1/games/build-the-skyscraper/stats"))!;
    assert.deepStrictEqual(stats.body.definitions.map((d: any) => d.key), ["blocks_placed", "buildings_finished", "strength", "speed", "cash", "playtime"]);
    assert.deepStrictEqual(stats.body.players, [{ userId: "legion_u1", values: { blocks_placed: 1500, buildings_finished: 2, strength: 0, speed: 3, cash: 40, playtime: 600 } }]);

    calls.length = 0;
    reportPlayer("u1", { totalBlocks: 1500, cash: 55 }); // blocks unchanged, cash changed
    await flushBoxity();
    assert.strictEqual(calls.length, 2);
    const again = calls.find((c) => c.url.includes("/leaderboards/"))!;
    assert.ok(!again.body.boards, "boards ride along only until one call is accepted");
    assert.deepStrictEqual(again.body.scores.map((s: any) => s.board), ["cash"]);
    assert.deepStrictEqual(calls.find((c) => c.url.endsWith("/stats"))!.body.players, [{ userId: "legion_u1", values: { cash: 55 } }]);
  });

  it("omits values over the platform ceiling and re-sends what a failed call left queued", async () => {
    const calls: Call[] = [];
    const answer = { status: 500 };
    __setFetchForTest(fakeApi(calls, answer));
    reportPlayer("u2", { cash: 5e12, totalBlocks: 10 });
    await flushBoxity();
    assert.ok(calls.length >= 1, "it tried");
    calls.length = 0;
    answer.status = 200; // the platform is back: the same queue goes out now
    await flushBoxity();
    const scores = calls.find((c) => c.url.includes("/leaderboards/"))!;
    assert.deepStrictEqual(scores.body.scores.map((s: any) => s.board).sort(), ["blocks", "cash"]);
    const stats = calls.find((c) => c.url.endsWith("/stats"))!;
    assert.deepStrictEqual(stats.body.players[0].values, { blocks_placed: 10 }, "5e12 cash is over the currency ceiling");
  });

  it("sends nothing without the report token (local dev)", async () => {
    delete process.env.BLOXITY_REPORT_TOKEN;
    const calls: Call[] = [];
    __setFetchForTest(fakeApi(calls));
    reportPlayer("u3", { totalBlocks: 10 });
    await flushBoxity();
    assert.strictEqual(calls.length, 0);
  });
});
