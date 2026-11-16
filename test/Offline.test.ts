import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest, type PlayerDoc } from "../src/db.js";
import { OFFLINE_MAX_S, OFFLINE_MIN_S } from "../src/constants.js";
import { accrueOffline, awaySeconds, sanitizeOfflineSecs } from "../src/offline.js";
import { sanitizeProgress } from "../src/sanitize.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

const HOUR = 3_600_000;
const doc = (id: string, extra: Partial<PlayerDoc>): PlayerDoc => ({ _id: id, username: "T", version: 1, updatedAt: new Date(), ...extra }) as PlayerDoc;

describe("offline rewards (unit)", () => {
  const now = 1_800_000_000_000;

  it("counts the time away, nothing under the minimum, nothing past the cap", () => {
    assert.strictEqual(awaySeconds(now - 60_000, now), 0);
    assert.strictEqual(awaySeconds(now - (OFFLINE_MIN_S - 1) * 1000, now), 0);
    assert.strictEqual(awaySeconds(now - OFFLINE_MIN_S * 1000, now), OFFLINE_MIN_S);
    assert.strictEqual(awaySeconds(now - 3 * HOUR, now), 3 * 3600);
    assert.strictEqual(awaySeconds(now - 90 * HOUR, now), OFFLINE_MAX_S);
  });

  it("ignores an unknown or future lastSeen", () => {
    for (const bad of [undefined, null, "x", NaN, -5, 0, now + HOUR]) assert.strictEqual(awaySeconds(bad, now), 0);
  });

  it("adds a new absence to what was left unclaimed, capped", () => {
    assert.strictEqual(accrueOffline(1000, now - HOUR, now), 1000 + 3600);
    assert.strictEqual(accrueOffline(OFFLINE_MAX_S - 10, now - HOUR, now), OFFLINE_MAX_S);
    assert.strictEqual(accrueOffline(1e12, undefined, now), OFFLINE_MAX_S);
    assert.strictEqual(sanitizeOfflineSecs(-3), 0);
    assert.strictEqual(sanitizeOfflineSecs("many"), 0);
    assert.strictEqual(sanitizeOfflineSecs(12.9), 12);
  });

  it("never takes lastSeen or offlineSecs from a save", () => {
    const s = sanitizeProgress({ cash: 1, lastSeen: 1, offlineSecs: 86_400 }) as object;
    assert.ok(!("lastSeen" in s) && !("offlineSecs" in s));
  });
});

describe("offline rewards (room)", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  async function join(fake: ReturnType<typeof fakePlayers>, devId: string) {
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { devId });
    const seen = { view: null as any, results: [] as any[] };
    c.onMessage("offline", (m: any) => (seen.view = m));
    c.onMessage("offlineResult", (m: any) => seen.results.push(m));
    for (const t of ["progress", "noProgress", "rewards", "leaderboard", "invite"]) c.onMessage(t, () => {});
    fake.release();
    await sleep(200);
    return { c, seen };
  }

  it("offers the time away on load and pays it once, after it is stored", async () => {
    const fake = fakePlayers([doc("dev-off1", { strength: 5, lastSeen: Date.now() - 10 * HOUR })]);
    const { c, seen } = await join(fake, "dev-off1");
    assert.ok(seen.view, "offline view sent on load");
    assert.ok(Math.abs(seen.view.secs - 10 * 3600) < 5);
    assert.strictEqual(seen.view.max, OFFLINE_MAX_S);
    assert.ok(Math.abs((fake.docs.get("dev-off1") as any).offlineSecs - 10 * 3600) < 5, "pending stored, so a reload keeps it");

    c.send("claimOffline");
    c.send("claimOffline");
    await sleep(200);
    const ok = seen.results.filter((r) => r.ok);
    assert.strictEqual(ok.length, 1, "exactly one claim pays");
    assert.ok(Math.abs(ok[0].secs - 10 * 3600) < 5);
    assert.ok(seen.results.some((r) => !r.ok && (r.reason === "claimed" || r.reason === "busy")));
    assert.strictEqual((fake.docs.get("dev-off1") as any).offlineSecs, 0);
  });

  it("a short absence, a new account and a guest earn nothing", async () => {
    const fake = fakePlayers([doc("dev-off2", { lastSeen: Date.now() - 60_000 })]);
    const a = await join(fake, "dev-off2");
    assert.strictEqual(a.seen.view.secs, 0);
    a.c.send("claimOffline");
    await sleep(100);
    assert.strictEqual(a.seen.results[0].ok, false);

    const fresh = await join(fakePlayers(), "dev-off3");
    assert.strictEqual(fresh.seen.view.secs, 0);

    __setPlayersForTest(fakePlayers());
    const room = await colyseus.createRoom<WorldState>("world", {});
    const g = await colyseus.connectTo(room, { username: "Gus" });
    let view: any = null;
    let res: any = null;
    g.onMessage("offline", (m: any) => (view = m));
    g.onMessage("offlineResult", (m: any) => (res = m));
    for (const t of ["noProgress", "rewards", "leaderboard"]) g.onMessage(t, () => {});
    await sleep(150);
    g.send("claimOffline");
    await sleep(100);
    assert.strictEqual(view, null);
    assert.deepStrictEqual({ ok: res.ok, reason: res.reason }, { ok: false, reason: "none" });
  });

  it("an unclaimed reward waits and grows with the next absence, up to the cap", async () => {
    const fake = fakePlayers([doc("dev-off4", { lastSeen: Date.now() - 20 * HOUR, offlineSecs: 10 * 3600 })]);
    const { seen } = await join(fake, "dev-off4");
    assert.strictEqual(seen.view.secs, OFFLINE_MAX_S);
  });

  it("a save cannot forge lastSeen, and every save stamps the server's clock", async () => {
    const fake = fakePlayers([doc("dev-off5", { lastSeen: Date.now() - 2 * HOUR })]);
    const { c } = await join(fake, "dev-off5");
    c.send("saveProgress", { cash: 7, lastSeen: 1, offlineSecs: OFFLINE_MAX_S });
    await sleep(150);
    const d = fake.docs.get("dev-off5") as any;
    assert.ok(Date.now() - d.lastSeen < 5000, "lastSeen is the server's now");
    assert.ok(Math.abs(d.offlineSecs - 2 * 3600) < 5, "offlineSecs untouched by the save");
  });
});
