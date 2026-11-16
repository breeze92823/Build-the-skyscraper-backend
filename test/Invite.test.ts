import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest, type PlayerDoc } from "../src/db.js";
import { INVITE_ACTIVE, INVITE_TIERS } from "../src/constants.js";
import { claimInvite, inviteView, isActive, isNewPlayer, readInvite, rememberSent, unclaimInvite } from "../src/invite.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

const doc = (id: string, f: Partial<PlayerDoc> = {}): PlayerDoc => ({ _id: id, version: 1, updatedAt: new Date(), ...f });

describe("invite rules", () => {
  it("reads a bounded state and tells an active friend from a new one", () => {
    const s = readInvite(doc("a", { invites: 1e9, inviteClaimed: [0, 0, 99, -1, 2], welcome: "ready", invitesSent: ["x", "bad id!", "x", "y"], invitedBy: "boss" }));
    assert.deepStrictEqual([s.invites, s.claimed, s.welcome, s.sent, s.invitedBy, s.credited], [100, [0, 2], "ready", ["x", "y"], "boss", false]);
    assert.deepStrictEqual(readInvite(null).claimed, []);
    assert.strictEqual(isActive(INVITE_ACTIVE.playtime, INVITE_ACTIVE.blocks), true);
    assert.strictEqual(isActive(INVITE_ACTIVE.playtime - 1, INVITE_ACTIVE.blocks), false);
    assert.strictEqual(isActive(INVITE_ACTIVE.playtime, INVITE_ACTIVE.blocks - 1), false);
    assert.strictEqual(isActive(undefined, 1e9), false);
    assert.strictEqual(isNewPlayer(null, 60), true);
    assert.strictEqual(isNewPlayer(doc("n", { playtime: 59 }), 60), true);
    assert.strictEqual(isNewPlayer(doc("v", { playtime: 60 }), 60), false);
  });

  it("claims a tier once, only when enough friends started playing, and a welcome gift once", () => {
    const s = readInvite(null);
    s.invites = 2;
    assert.strictEqual(claimInvite(s, 0), true);
    assert.strictEqual(claimInvite(s, 0), false, "once");
    assert.strictEqual(claimInvite(s, 2), false, "tier 3 needs 3 friends");
    assert.strictEqual(claimInvite(s, 1), true);
    assert.strictEqual(claimInvite(s, 99), false);
    assert.strictEqual(claimInvite(s, "x"), false);
    unclaimInvite(s, 1);
    assert.deepStrictEqual(s.claimed, [0]);
    assert.strictEqual(claimInvite(s, "welcome"), false, "no welcome gift unless invited");
    s.welcome = "ready";
    assert.strictEqual(claimInvite(s, "welcome"), true);
    assert.strictEqual(claimInvite(s, "welcome"), false);
    assert.strictEqual(inviteView(s).tiers.length, INVITE_TIERS.length);
    assert.ok(rememberSent(s, "friend1"));
    assert.ok(!rememberSent(s, "friend1"));
  });
});

describe("invite friends in a room", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  // Joins a player and records every message the invite flow sends.
  async function join(room: any, options: any) {
    const c = await colyseus.connectTo(room, options);
    const got = { invite: [] as any[], invitedBy: [] as any[], friendJoined: [] as any[], result: [] as any[] };
    c.onMessage("invite", (m: any) => got.invite.push(m));
    c.onMessage("invitedBy", (m: any) => got.invitedBy.push(m));
    c.onMessage("friendJoined", (m: any) => got.friendJoined.push(m));
    c.onMessage("inviteResult", (m: any) => got.result.push(m));
    c.onMessage("progress", () => {});
    c.onMessage("noProgress", () => {});
    c.onMessage("leaderboard", () => {});
    return { c, got };
  }
  const last = (a: any[]) => a[a.length - 1];

  it("links a new player to their inviter, and counts the friend only once they have actually played", async () => {
    const fake = fakePlayers([doc("dev-inv1", { username: "Ann", totalBlocks: 5000, playtime: 9000 })]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const inviter = await join(room, { devId: "dev-inv1", username: "Ann" });
    const friend = await join(room, { devId: "dev-new1", username: "Bo", ref: "dev-inv1" });
    fake.release();
    await sleep(250);

    // The invited friend: linked once, welcome gift ready, told who invited them.
    assert.strictEqual(fake.docs.get("dev-new1")!.invitedBy, "dev-inv1");
    assert.deepStrictEqual(friend.got.invitedBy, [{ name: "Ann" }]);
    assert.strictEqual(last(friend.got.invite).welcome, "ready");
    assert.strictEqual(last(friend.got.invite).invitedBy, "Ann");
    assert.strictEqual(last(friend.got.invite).active, false);
    // The inviter: one friend waiting, none counted yet, no reward.
    assert.deepStrictEqual([last(inviter.got.invite).invites, last(inviter.got.invite).pending], [0, 1]);
    assert.strictEqual(fake.docs.get("dev-inv1")!.invites ?? 0, 0);

    // Not playing enough: still pending.
    friend.c.send("saveProgress", { playtime: INVITE_ACTIVE.playtime - 1, totalBlocks: 10_000 });
    friend.c.send("saveProgress", { playtime: 10_000, totalBlocks: INVITE_ACTIVE.blocks - 1 });
    await sleep(200);
    assert.strictEqual(fake.docs.get("dev-inv1")!.invites ?? 0, 0);
    assert.strictEqual(friend.got.friendJoined.length + inviter.got.friendJoined.length, 0);

    // Played enough: the inviter is credited, once, and hears about it live.
    friend.c.send("saveProgress", { playtime: INVITE_ACTIVE.playtime, totalBlocks: INVITE_ACTIVE.blocks, cash: 100 });
    await sleep(250);
    assert.strictEqual(fake.docs.get("dev-inv1")!.invites, 1);
    assert.strictEqual(fake.docs.get("dev-new1")!.inviteCredited, true);
    assert.deepStrictEqual(inviter.got.friendJoined, [{ name: "Bo" }]);
    assert.deepStrictEqual([last(inviter.got.invite).invites, last(inviter.got.invite).pending], [1, 0]);
    assert.strictEqual(last(friend.got.invite).active, true);
    friend.c.send("saveProgress", { playtime: INVITE_ACTIVE.playtime + 600, totalBlocks: 9999 });
    await sleep(200);
    assert.strictEqual(fake.docs.get("dev-inv1")!.invites, 1, "never credited twice");

    // Claims: tier 1 ok once, tier 2 needs two friends; the friend claims the welcome gift once.
    inviter.c.send("claimInvite", { id: 0 });
    inviter.c.send("claimInvite", { id: 0 });
    inviter.c.send("claimInvite", { id: 1 });
    friend.c.send("claimInvite", { id: "welcome" });
    friend.c.send("claimInvite", { id: "welcome" });
    await sleep(250);
    const key = (r: any) => `${r.id}|${r.ok}|${r.reason}`;
    assert.deepStrictEqual(inviter.got.result.map(key).sort(), ["0|false|locked", "0|true|undefined", "1|false|locked"]);
    assert.deepStrictEqual(friend.got.result.map(key).sort(), ["welcome|false|locked", "welcome|true|undefined"]);
    assert.deepStrictEqual(fake.docs.get("dev-inv1")!.inviteClaimed, [0]);
    assert.strictEqual(fake.docs.get("dev-new1")!.welcome, "claimed");
  });

  it("never links a guest, a veteran, a stranger's ref or yourself", async () => {
    const fake = fakePlayers([doc("dev-inv2", { username: "Ann" }), doc("dev-vet", { username: "Vet", playtime: 5000, totalBlocks: 9000 })]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const guest = await join(room, { username: "Gus", ref: "dev-inv2" });
    const veteran = await join(room, { devId: "dev-vet", username: "Vet", ref: "dev-inv2" });
    const stranger = await join(room, { devId: "dev-new2", username: "Sam", ref: "dev-nobody" });
    const selfRef = await join(room, { devId: "dev-new3", username: "Self", ref: "dev-new3" });
    fake.release();
    await sleep(300);
    assert.strictEqual(fake.docs.get("dev-vet")!.invitedBy, undefined, "a veteran is not an invited friend");
    assert.ok(!fake.docs.has("dev-new2") || fake.docs.get("dev-new2")!.invitedBy === undefined, "an unknown inviter links nobody");
    assert.ok(!fake.docs.has("dev-new3") || fake.docs.get("dev-new3")!.invitedBy === undefined, "no self-invite");
    for (const p of [veteran, stranger, selfRef]) assert.strictEqual(p.got.invitedBy.length, 0);
    // A guest can neither be linked nor claim.
    guest.c.send("claimInvite", { id: 0 });
    await sleep(150);
    assert.deepStrictEqual(guest.got.result.map((r) => [r.ok, r.reason]), [[false, "guest"]]);
    assert.strictEqual(fake.docs.get("dev-inv2")!.invites ?? 0, 0);
  });

  it("keeps the first inviter: a second link changes nothing", async () => {
    const fake = fakePlayers([doc("dev-a", { username: "A" }), doc("dev-b", { username: "B" })]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const keeper = await join(room, { devId: "dev-a", username: "A" }); // keeps the room open
    const first = await join(room, { devId: "dev-friend", username: "F", ref: "dev-a" });
    fake.release();
    await sleep(250);
    assert.strictEqual(fake.docs.get("dev-friend")!.invitedBy, "dev-a");
    await first.c.leave();
    await sleep(150);
    const go = fake.hold();
    const again = await join(room, { devId: "dev-friend", username: "F", ref: "dev-b" });
    go();
    await sleep(300);
    void keeper;
    assert.strictEqual(fake.docs.get("dev-friend")!.invitedBy, "dev-a", "set once");
    assert.strictEqual(last(again.got.invite).invitedBy, "A");
    assert.strictEqual(again.got.invitedBy.length, 0, "no second welcome toast");
  });

  it("links a friend through a direct Bloxity invite (no link)", async () => {
    const fake = fakePlayers([doc("dev-inv3", { username: "Ann" })]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const inviter = await join(room, { devId: "dev-inv3", username: "Ann" });
    fake.release();
    await sleep(200);
    inviter.c.send("invited", { friendId: "dev-pal" });
    inviter.c.send("invited", { friendId: "dev-inv3" }); // yourself: ignored
    inviter.c.send("invited", { friendId: "bad id!" });
    await sleep(150);
    assert.deepStrictEqual(fake.docs.get("dev-inv3")!.invitesSent, ["dev-pal"]);
    const go = fake.hold();
    const pal = await join(room, { devId: "dev-pal", username: "Pal" });
    go();
    await sleep(300);
    assert.strictEqual(fake.docs.get("dev-pal")!.invitedBy, "dev-inv3");
    assert.deepStrictEqual(pal.got.invitedBy, [{ name: "Ann" }]);
  });

  it("refreshes the counts for an inviter who was elsewhere when the friend started playing", async () => {
    const fake = fakePlayers([doc("dev-inv4", { username: "Ann", invites: 3, inviteClaimed: [0] }), doc("dev-w1", { invitedBy: "dev-inv4" }), doc("dev-w2", { invitedBy: "dev-inv4", inviteCredited: true })]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const inviter = await join(room, { devId: "dev-inv4", username: "Ann" });
    fake.release();
    await sleep(250);
    assert.deepStrictEqual([last(inviter.got.invite).invites, last(inviter.got.invite).pending, last(inviter.got.invite).claimed], [3, 1, [0]]);
    fake.docs.get("dev-inv4")!.invites = 4; // credited on another pod meanwhile
    fake.docs.get("dev-w1")!.inviteCredited = true;
    inviter.c.send("inviteRefresh", {});
    await sleep(200);
    assert.deepStrictEqual([last(inviter.got.invite).invites, last(inviter.got.invite).pending], [4, 0]);
  });
});
