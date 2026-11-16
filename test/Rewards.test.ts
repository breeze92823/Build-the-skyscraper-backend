import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { DAY_MS, PLAY_TIERS_MIN } from "../src/constants.js";
import { RewardsState, dayIndex, freshRewards, sanitizeRewards } from "../src/rewards.js";
import { sanitizeProgress } from "../src/sanitize.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("rewards (unit)", () => {
  const T0 = 1_800_000_000_000; // some UTC instant
  const today = dayIndex(T0);

  it("daily: claims once a day, continues the streak, resets after a missed day", () => {
    const r = new RewardsState(freshRewards(T0), T0);
    const a = r.claimDaily(T0);
    assert.ok("next" in a && a.day === 0);
    r.commit((a as any).next, T0);
    assert.deepStrictEqual("reason" in r.claimDaily(T0 + 1000) && r.claimDaily(T0 + 1000), { ok: false, reason: "claimed" });
    const b = r.claimDaily(T0 + DAY_MS);
    assert.ok("next" in b && b.day === 1, "next day continues the streak");
    r.commit((b as any).next, T0 + DAY_MS);
    const c = r.claimDaily(T0 + 3 * DAY_MS);
    assert.ok("next" in c && c.day === 0, "a missed day starts over at day 1");
  });

  it("daily: a finished week starts over at day 1", () => {
    const r = new RewardsState({ ...freshRewards(T0), streak: 7, last: today - 1 }, T0);
    assert.strictEqual(r.daily(T0).day, 0);
  });

  it("playtime: tiers open by minutes played today and reset at UTC midnight", () => {
    const r = new RewardsState(freshRewards(T0), T0);
    assert.deepStrictEqual(r.claimPlay(0, T0 + 30_000), { ok: false, reason: "early" });
    const ok = r.claimPlay(0, T0 + 61_000);
    assert.ok("next" in ok);
    r.commit((ok as any).next, T0 + 61_000);
    assert.deepStrictEqual(r.claimPlay(0, T0 + 62_000), { ok: false, reason: "claimed" });
    assert.deepStrictEqual(r.claimPlay(99, T0), { ok: false, reason: "tier" });
    const tomorrow = (today + 1) * DAY_MS + 1000;
    assert.deepStrictEqual(r.view(tomorrow).play.claimed, []);
    assert.ok(r.view(tomorrow).play.sec < 5);
  });

  it("free: once ever", () => {
    const r = new RewardsState(freshRewards(T0), T0);
    const a = r.claimFree(T0);
    assert.ok("next" in a);
    r.commit((a as any).next, T0);
    assert.deepStrictEqual(r.claimFree(T0), { ok: false, reason: "claimed" });
  });

  it("bounds stored rewards and never takes them from a save", () => {
    const s = sanitizeRewards({ streak: -4, last: today + 50, playSec: 1e12, playClaimed: [0, 0, 3, 77, "x"], free: "yes" }, T0);
    assert.strictEqual(s.streak, 0);
    assert.strictEqual(s.last, today);
    assert.deepStrictEqual(s.playClaimed, [0, 3]);
    assert.strictEqual(s.free, false);
    assert.ok(!("rewards" in (sanitizeProgress({ rewards: { free: true }, cash: 1 }) as object)));
    const t = sanitizeProgress({ timed: [{ stat: "cash", mult: 2, left: 60 }, { stat: "bogus", mult: 2, left: 5 }, { stat: "speed", mult: 1e9, left: 1e12 }], petSlots: 99 }) as any;
    assert.strictEqual(t.timed.length, 2);
    assert.ok(t.timed[1].mult <= 100 && t.timed[1].left <= 7 * 86_400);
    assert.strictEqual(t.petSlots, 8);
  });
});

describe("rewards (room)", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  it("sends a signed-in player the rewards view and stores a claim before answering ok", async () => {
    const fake = fakePlayers();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { devId: "dev-rw1" });
    let view: any = null;
    const results: any[] = [];
    c.onMessage("rewards", (m: any) => (view = m));
    c.onMessage("rewardResult", (m: any) => results.push(m));
    c.onMessage("noProgress", () => {});
    c.onMessage("leaderboard", () => {});
    fake.release();
    await sleep(150);
    assert.ok(view, "rewards view sent on load");
    assert.strictEqual(view.daily.day, 0);
    assert.strictEqual(view.daily.canClaim, true);
    assert.strictEqual(view.free, false);

    c.send("claimReward", { kind: "daily" });
    c.send("claimReward", { kind: "free" });
    c.send("claimReward", { kind: "play", tier: PLAY_TIERS_MIN.length - 1 });
    await sleep(200);
    const daily = results.find((r) => r.kind === "daily");
    assert.strictEqual(daily.ok, true);
    assert.strictEqual(daily.day, 0);
    assert.strictEqual(daily.view.daily.canClaim, false);
    const play = results.find((r) => r.kind === "play");
    assert.strictEqual(play.ok, false);
    assert.ok(play.reason === "early" || play.reason === "busy");
    const doc = fake.docs.get("dev-rw1") as any;
    assert.strictEqual(doc.rewards.streak, 1);

    // A save can never write rewards.
    c.send("saveProgress", { cash: 5, rewards: { streak: 99, free: false } });
    await sleep(150);
    assert.strictEqual((fake.docs.get("dev-rw1") as any).rewards.streak, 1);
  });

  it("guests get no server rewards (their browser keeps them)", async () => {
    __setPlayersForTest(fakePlayers());
    const room = await colyseus.createRoom<WorldState>("world", {});
    const g = await colyseus.connectTo(room, { username: "Gus" });
    let view: any = null;
    let result: any = null;
    g.onMessage("rewards", (m: any) => (view = m));
    g.onMessage("rewardResult", (m: any) => (result = m));
    g.onMessage("noProgress", () => {});
    g.onMessage("leaderboard", () => {});
    await sleep(150);
    g.send("claimReward", { kind: "daily" });
    await sleep(100);
    assert.strictEqual(view, null);
    assert.deepStrictEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: "none" });
  });
});
