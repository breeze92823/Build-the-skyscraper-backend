import { Room, Client, CloseCode } from "colyseus";
import { WorldState, PlayerState, TowerState } from "./schema/WorldState.js";
import { BUILD_BUCKET, BUILD_MSG_MAX, BUILDING_SCALE, TRIP_MAX, INVITES_MAX, INVITE_NEW_PLAYTIME_MAX, LEADERBOARD_EVERY_MS, NAME_MAX, PFP_MAX_LEN, RECONNECT_SECONDS, ROOM_MAX_CLIENTS, TOWER_TICK_MS } from "../constants.js";
import { getPlayers, type PlayerDoc } from "../db.js";
import { sanitizeProgress } from "../sanitize.js";
import { devIdentity, verifyToken, type Identity } from "../auth.js";
import { applyAvatar, applyEmote, applyLoadout, applyPose } from "../presence.js";
import { ranksOf, topBoards } from "../leaderboard.js";
import { flushBoxity, reportPlayer } from "../boxity.js";
import { RewardsState, freshRewards, sanitizeRewards } from "../rewards.js";
import { accrueOffline, offlineView, sanitizeOfflineSecs } from "../offline.js";
import { TowerRules, sanitizeTowerSeed } from "../tower.js";
import { claimInvite, inviteFields, inviteView, isActive, isNewPlayer, isUserId, readInvite, rememberSent, unclaimInvite, type InviteState } from "../invite.js";

function sanitizeName(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, NAME_MAX) : "";
}

function sanitizePfp(raw: unknown): string {
  return typeof raw === "string" && raw.length <= PFP_MAX_LEN && /^https?:\/\//i.test(raw) ? raw : "";
}

type JoinOptions = { token?: string; devId?: string; username?: string; pfp?: string; pose?: unknown; loadout?: unknown; avatar?: string; tower?: unknown; ref?: unknown };

/**
 * Room every client joins via `client.joinOrCreate("world", { token, username, pfp, ... })`.
 * Who the player is comes ONLY from Bloxity's verification of `token` (onAuth -> auth.ts); a guest
 * (no / refused token) is never loaded or saved. Loads and saves each signed-in player's progress
 * (MongoDB, see db.ts): the game is client-authoritative, so saves are only bounded (sanitize.ts).
 * The roster (WorldState) relays the players' poses, look and emotes for the others to draw, and the
 * room's ONE shared tower (tower.ts) lives in WorldState.tower: players report the blocks they place
 * (`build`) and every client displays the same building. Full rooms spill into a fresh one
 * automatically (maxClients).
 */
export class WorldRoom extends Room<{ state: WorldState }> {
  state = (() => {
    const s = new WorldState();
    s.tower = new TowerState();
    return s;
  })();
  maxClients = ROOM_MAX_CLIENTS;

  // sessionId -> the player's bag (blocks one full bag places, `build.trip`) and when they last built:
  // the floors are sized to the bags of the room's active builders (tower.ts floorNeed).
  private trips = new Map<string, { trip: number; at: number }>();
  // The summed bags of the builders who placed blocks in the last BUILDING_SCALE.active s.
  private roomTrip(): number {
    const since = Date.now() - BUILDING_SCALE.active * 1000;
    let sum = 0;
    for (const t of this.trips.values()) if (t.at >= since) sum += t.trip;
    return sum;
  }
  // The shared tower's rules over state.tower (tower.ts).
  private tower = new TowerRules(this.state.tower, () => this.roomTrip());
  // sessionId -> the tower the player's browser holds (join option `tower`): seeds a fresh room when the
  // first player to load has no stored one (a guest, or no database).
  private towerOffers = new Map<string, ReturnType<typeof sanitizeTowerSeed>>();
  // Invite Friends (invite.ts) of signed-in players with a database: sessionId -> state, read with the save.
  private invites = new Map<string, InviteState>();
  // sessionId -> the inviter's account id from the join options (`ref`, the invite link's tag).
  private refs = new Map<string, string>();
  // Sessions whose "started playing" credit is being written (one at a time).
  private activating = new Set<string>();
  // sessionId -> `build` message allowance (token bucket).
  private buildBuckets = new Map<string, { tokens: number; at: number }>();

  // sessionId -> verified account id. Deliberately NOT part of WorldState's private bookkeeping:
  // it only gates this room's own Mongo reads/writes. Guests have no entry.
  userIds = new Map<string, string>();

  // sessionIds whose save has been read: only these may write. A save sent before the load
  // answered would overwrite the stored progress with a fresh player's defaults.
  private loaded = new Set<string>();
  // Per-session save queue: one write in flight, the newest patch waits behind it (keeps order).
  private saves = new Map<string, { busy: boolean; next: Partial<PlayerDoc> | null }>();
  // Daily / Playtime / Free rewards (rewards.ts) of the sessions the server keeps them for: signed-in
  // players with a database. Everyone else's live in their browser save (client rewards.js).
  private rewards = new Map<string, RewardsState>();
  // Sessions with a reward claim being written: one at a time, so two claims never race.
  private claiming = new Set<string>();
  // Offline rewards (offline.ts): sessionId -> seconds away waiting to be claimed, for the sessions the
  // server keeps them for (signed-in players with a database).
  private offline = new Map<string, number>();
  // Sessions whose offline claim is being written (one at a time).
  private claimingOffline = new Set<string>();

  messages = {
    // Debounced push of the client's whole progress. Upserts, so a first save creates the document.
    saveProgress: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      const patch = sanitizeProgress(msg);
      if (!p || !patch || !this.loaded.has(client.sessionId)) return;
      const userId = this.userIds.get(client.sessionId);
      if (!userId || !getPlayers()) return; // guest / Mongo unset or unreachable -- degrade silently
      void this.persist(client.sessionId, userId, patch);
    },
    // Presence: the sender's pose ~10x/s, loadout and Bloxity look, relayed through the roster so
    // everyone draws them in the world (client remotePlayers.js), and the emote they started.
    pose: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyPose(p, msg);
    },
    loadout: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyLoadout(p, msg);
    },
    setAvatar: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyAvatar(p, msg);
    },
    emote: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyEmote(p, msg);
    },
    // The blocks this player just placed on the shared tower: { blocks, trip } (the client batches ~4/s;
    // `trip` = blocks one full bag of theirs places, which sizes the next floors). The server clamps to what
    // the floor needs, rolls floors over, may finish the building (-> `built` to everyone) and the new
    // state reaches every client through WorldState.tower.
    build: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !this.takeBuildToken(client.sessionId)) return;
      const m = msg as { blocks?: unknown; trip?: unknown } | null;
      const blocks = m?.blocks;
      if (typeof blocks !== "number" || !Number.isFinite(blocks)) return;
      const trip = typeof m?.trip === "number" && Number.isFinite(m.trip) ? Math.min(TRIP_MAX, Math.max(1, m.trip)) : this.trips.get(client.sessionId)?.trip ?? 1;
      this.trips.set(client.sessionId, { trip, at: Date.now() });
      const res = this.tower.addBlocks(Math.min(BUILD_MSG_MAX, blocks), { id: p.uid || client.sessionId, name: p.username || "Player" }, Date.now());
      // `built` { n, builders: [{ id, name, blocks }] }: the Top Builders of the building that just finished.
      if (res.built) this.broadcast("built", res.built);
    },
    // Invite Friends: claims `msg.id` ("welcome" or an INVITE_TIERS index). Answers `inviteResult`
    // { ok, id, reason?: "guest" | "loading" | "locked" | "save", ...view }: ok only once it is stored.
    claimInvite: async (client: Client, msg: { id?: unknown } | null) => {
      const id = msg?.id;
      const userId = this.userIds.get(client.sessionId);
      if (!userId) return this.safeSend(client, "inviteResult", { ok: false, id, reason: "guest" });
      const s = this.invites.get(client.sessionId);
      if (!s || !this.loaded.has(client.sessionId)) return this.safeSend(client, "inviteResult", { ok: false, id, reason: "loading" });
      if (!claimInvite(s, id)) return this.safeSend(client, "inviteResult", { ok: false, id, reason: "locked", ...inviteView(s) });
      if (!(await this.saveInvite(userId, inviteFields(s)))) {
        unclaimInvite(s, id); // not stored: not claimed
        return this.safeSend(client, "inviteResult", { ok: false, id, reason: "save", ...inviteView(s) });
      }
      this.safeSend(client, "inviteResult", { ok: true, id, ...inviteView(s) });
    },
    // The Invite window opened: re-read the friends count (friends credited in another room or pod
    // since the load) and the pending ones, and answer `invite`.
    inviteRefresh: async (client: Client) => {
      const s = this.invites.get(client.sessionId);
      const userId = this.userIds.get(client.sessionId);
      const players = getPlayers();
      if (!s || !userId || !players) return;
      try {
        const doc = await players.findOne({ _id: userId });
        s.invites = readInvite(doc).invites;
        s.pending = await players.countDocuments({ invitedBy: userId, inviteCredited: { $ne: true } });
      } catch (err) {
        console.warn("[WorldRoom] inviteRefresh failed", err);
      }
      if (this.invites.get(client.sessionId) === s) this.safeSend(client, "invite", inviteView(s));
    },
    // A direct Bloxity invite went to `msg.friendId`: remember it, so that friend counts for this
    // player when they join and play (even without the link's `ref`).
    invited: async (client: Client, msg: { friendId?: unknown } | null) => {
      const s = this.invites.get(client.sessionId);
      const userId = this.userIds.get(client.sessionId);
      const friendId = msg?.friendId;
      if (!s || !userId || !isUserId(friendId) || friendId === userId) return;
      if (rememberSent(s, friendId)) await this.saveInvite(userId, { invitesSent: [...s.sent] });
    },
    // `claimReward` { kind: "daily" | "play" | "free", tier? (play) } -> `rewardResult`
    // { ok, kind, day? | tier?, reason?: "none" | "busy" | "claimed" | "early" | "tier" | "kind" | "save", view }.
    // ok only once the claim is stored; the client grants the prize then. `rewardsRefresh` -> `rewards`.
    claimReward: (client: Client, msg: unknown): void => void this.handleClaim(client, msg),
    // `claimOffline` -> `offlineResult` { ok, secs?, reason?: "none" | "busy" | "claimed" | "save" }: the
    // seconds away are paid (by the client, as Strength + Speed) only once the claim is stored.
    claimOffline: (client: Client): void => void this.handleOfflineClaim(client),
    rewardsRefresh: (client: Client) => {
      const r = this.rewards.get(client.sessionId);
      if (r) this.safeSend(client, "rewards", r.view(Date.now()));
    },
  };

  private safeSend(client: Client, type: string, msg: unknown): void {
    try {
      client.send(type, msg);
    } catch {
      // Gone meanwhile.
    }
  }

  private async handleOfflineClaim(client: Client): Promise<void> {
    const sid = client.sessionId;
    const userId = this.userIds.get(sid);
    const players = getPlayers();
    const secs = this.offline.get(sid) ?? 0;
    const answer = (extra: Record<string, unknown>): void => this.safeSend(client, "offlineResult", extra);
    if (!userId || !players || !this.offline.has(sid)) return answer({ ok: false, reason: "none" });
    if (secs <= 0) return answer({ ok: false, reason: "claimed" });
    if (this.claimingOffline.has(sid)) return answer({ ok: false, reason: "busy" });
    this.claimingOffline.add(sid);
    let stored = false;
    try {
      // Conditional on the exact stored amount: another pod that already paid it leaves nothing to match.
      const res = await players.updateOne({ _id: userId, offlineSecs: secs }, { $set: { offlineSecs: 0, updatedAt: new Date() } });
      stored = res.modifiedCount === 1;
      if (!stored) {
        const doc = await players.findOne({ _id: userId });
        if (this.offline.has(sid)) this.offline.set(sid, sanitizeOfflineSecs(doc?.offlineSecs));
      }
    } catch (err) {
      console.warn("[WorldRoom] claimOffline failed", err);
      this.claimingOffline.delete(sid);
      return answer({ ok: false, reason: "save" });
    }
    this.claimingOffline.delete(sid);
    if (!this.offline.has(sid)) return; // left meanwhile
    if (!stored) return answer({ ok: false, reason: "claimed" });
    this.offline.set(sid, 0);
    answer({ ok: true, secs });
  }

  private async handleClaim(client: Client, msg: unknown): Promise<void> {
    const sid = client.sessionId;
    const m = (msg && typeof msg === "object" ? msg : {}) as { kind?: unknown; tier?: unknown };
    const kind = m.kind === "daily" || m.kind === "play" || m.kind === "free" ? m.kind : "";
    const r = this.rewards.get(sid);
    const userId = this.userIds.get(sid);
    const players = getPlayers();
    const answer = (extra: Record<string, unknown>): void => this.safeSend(client, "rewardResult", { kind, ...extra, view: r?.view(Date.now()) ?? null });
    if (!r || !userId || !players) return answer({ ok: false, reason: "none" });
    if (!kind) return answer({ ok: false, reason: "kind" });
    if (this.claiming.has(sid)) return answer({ ok: false, reason: "busy" });
    const now = Date.now();
    const res = kind === "daily" ? r.claimDaily(now) : kind === "play" ? r.claimPlay(m.tier, now) : r.claimFree(now);
    if ("reason" in res) return answer({ ok: false, reason: res.reason });
    this.claiming.add(sid);
    try {
      await players.updateOne({ _id: userId }, { $set: { rewards: res.next, updatedAt: new Date() }, $setOnInsert: { version: 1 } }, { upsert: true });
    } catch (err) {
      console.warn("[WorldRoom] claimReward failed", err);
      this.claiming.delete(sid);
      return answer({ ok: false, reason: "save" });
    }
    this.claiming.delete(sid);
    if (this.rewards.get(sid) !== r) return; // left meanwhile
    r.commit(res.next, Date.now());
    answer({ ok: true, ...("day" in res ? { day: res.day } : {}), ...("tier" in res ? { tier: res.tier } : {}) });
  }

  // Leaderboards (leaderboard.ts): everyone gets the top lists + their own ranks every
  // LEADERBOARD_EVERY_MS, and once right after their save loads.
  onCreate() {
    this.clock.setInterval(() => {
      for (const c of this.clients) void this.sendLeaderboard(c);
    }, LEADERBOARD_EVERY_MS);
    // The shared tower's timeline (celebrate -> sinking -> the next building).
    this.clock.setInterval(() => this.tower.tick(Date.now()), TOWER_TICK_MS);
  }

  // Token bucket for `build` messages: a client sends a few a second, a flood is dropped.
  private takeBuildToken(sessionId: string): boolean {
    const now = Date.now();
    const b = this.buildBuckets.get(sessionId) ?? { tokens: BUILD_BUCKET.burst, at: now };
    b.tokens = Math.min(BUILD_BUCKET.burst, b.tokens + ((now - b.at) / 1000) * BUILD_BUCKET.perSec);
    b.at = now;
    this.buildBuckets.set(sessionId, b);
    if (b.tokens < 1) return false;
    b.tokens--;
    return true;
  }

  // The room's tower starts from the first loaded player's saved tower (else the one their browser
  // offered, else building 0); later players adopt the room's. Called once per player after their load.
  private seedTower(sessionId: string, saved: unknown): void {
    this.tower.seed(sanitizeTowerSeed(saved) ?? this.towerOffers.get(sessionId) ?? null, Date.now());
  }

  // `leaderboard` { boards: { strength|speed|blocks|cash|buildings|playtime: [{ name, value }] }, ranks: { stat: n | null } }.
  private async sendLeaderboard(client: Client) {
    const userId = this.userIds.get(client.sessionId) ?? "";
    const [boards, ranks] = await Promise.all([topBoards(), ranksOf(userId)]);
    if (!this.state.players.has(client.sessionId)) return;
    try {
      client.send("leaderboard", { boards, ranks });
    } catch {
      // Gone meanwhile.
    }
  }

  // Bloxity rule: the account id is only ever what the platform's token verification returns.
  // Local dev (no SDK, no token) may use a `dev-` id outside production. Everyone else is a guest.
  async onAuth(_client: Client, options?: JoinOptions): Promise<Identity & { guest: boolean }> {
    const verified = (await verifyToken(options?.token)) ?? devIdentity(options);
    if (verified) return { ...verified, guest: false };
    return { userId: "", username: sanitizeName(options?.username) || "Guest", pfp: "", guest: true };
  }

  onJoin(client: Client, options: JoinOptions | undefined, auth: Identity & { guest: boolean }) {
    const p = new PlayerState();
    p.username = sanitizeName(auth.username) || "Player";
    p.pfp = sanitizePfp(auth.pfp) || sanitizePfp(options?.pfp);
    p.uid = auth.userId;
    p.signedIn = !auth.guest;
    this.towerOffers.set(client.sessionId, sanitizeTowerSeed(options?.tower));
    if (isUserId(options?.ref)) this.refs.set(client.sessionId, options.ref);
    // Presence from the join options, so the others draw the newcomer right away.
    applyPose(p, options?.pose);
    applyLoadout(p, options?.loadout);
    applyAvatar(p, options);
    this.state.players.set(client.sessionId, p);

    if (auth.userId) {
      // Evict any OTHER live session already claiming this account, so one account never has two
      // racing Mongo writers (a crashed tab lingers up to RECONNECT_SECONDS via allowReconnection).
      for (const [sid, uid] of this.userIds) {
        if (sid === client.sessionId || uid !== auth.userId) continue;
        this.forgetSession(sid);
        const stale = this.clients.find((c) => c.sessionId === sid);
        if (stale) {
          try {
            stale.leave(CloseCode.CONSENTED);
          } catch {
            // Already gone -- nothing to clean up.
          }
        }
      }
      this.userIds.set(client.sessionId, auth.userId);
    }
    void this.loadProgress(client, auth.userId, p);
  }

  // A deliberate `room.leave()` closes with CONSENTED -- drop the player at once. Anything
  // else (WiFi blip, backgrounded tab) gets RECONNECT_SECONDS to reconnect with the same session.
  async onLeave(client: Client, code?: number) {
    if (code === CloseCode.CONSENTED) {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
      return;
    }
    try {
      await this.allowReconnection(client, RECONNECT_SECONDS);
    } catch {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
    }
  }

  // Sends what is still queued for Bloxity before the room goes away (a deploy / scale-down).
  async onDispose() {
    await flushBoxity();
  }

  // Server-clock "last seen" for a player who has really gone. Call before forgetSession.
  private async stampLastSeen(sessionId: string) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    const rewards = this.rewards.get(sessionId);
    try {
      // The playtime counted since the last save goes with it.
      await players.updateOne({ _id: userId }, { $set: { lastSeen: Date.now(), ...(rewards && { rewards: rewards.snapshot(Date.now()) }) } });
    } catch (err) {
      console.warn("[WorldRoom] stampLastSeen failed", err);
    }
  }

  // Drops a session's per-connection bookkeeping.
  private forgetSession(sessionId: string) {
    this.state.players.delete(sessionId);
    this.userIds.delete(sessionId);
    this.loaded.delete(sessionId);
    this.saves.delete(sessionId);
    this.towerOffers.delete(sessionId);
    this.invites.delete(sessionId);
    this.refs.delete(sessionId);
    this.activating.delete(sessionId);
    this.buildBuckets.delete(sessionId);
    this.trips.delete(sessionId);
    this.rewards.delete(sessionId);
    this.claiming.delete(sessionId);
    this.offline.delete(sessionId);
    this.claimingOffline.delete(sessionId);
  }

  // Writes a save, one at a time per session so two quick saves never land out of order: while one
  // is in flight only the NEWEST waiting patch is kept (a later save already contains the earlier one).
  private async persist(sessionId: string, userId: string, patch: Partial<PlayerDoc>) {
    let slot = this.saves.get(sessionId);
    if (!slot) this.saves.set(sessionId, (slot = { busy: false, next: null }));
    slot.next = slot.next ? { ...slot.next, ...patch } : patch;
    if (slot.busy) return;
    slot.busy = true;
    try {
      while (slot.next) {
        const next = slot.next;
        slot.next = null;
        await this.write(sessionId, userId, next);
      }
    } finally {
      slot.busy = false;
    }
  }

  private async write(sessionId: string, userId: string, patch: Partial<PlayerDoc>) {
    const players = getPlayers();
    if (!players) return;
    try {
      await players.updateOne(
        { _id: userId },
        {
          // Display name comes from this connection's own (verified) PlayerState, not the message.
          // Today's playtime rides along with every save (a crash loses at most one save interval).
          // `lastSeen` (server clock) is what the offline reward measures the next absence from.
          $set: { ...patch, ...this.rewardsPatch(sessionId), lastSeen: Date.now(), username: this.state.players.get(sessionId)?.username || "Player", updatedAt: new Date() },
          $setOnInsert: { version: 1 },
        },
        { upsert: true },
      );
      reportPlayer(userId, patch); // Bloxity boards + stats, from the stored progress
      void this.maybeActivate(sessionId, userId, patch); // an invited friend who has played enough counts now
    } catch (err) {
      console.warn("[WorldRoom] saveProgress failed", err);
    }
  }

  // The session's rewards to store with a save; nothing while a claim is being written (that write
  // carries them, and an older copy must not land after it).
  private rewardsPatch(sessionId: string): { rewards?: ReturnType<RewardsState["snapshot"]> } {
    const r = this.rewards.get(sessionId);
    if (!r || this.claiming.has(sessionId)) return {};
    return { rewards: r.snapshot(Date.now()) };
  }

  // Sends the saved doc to just this client so it can hydrate its state ("progress"), or
  // "noProgress" when there is nothing to load (new account, guest, or Mongo unset). A failed read
  // sends "serverError" and keeps saving off, so a save that could not be read is never overwritten.
  private async loadProgress(client: Client, userId: string, p: PlayerState) {
    const players = getPlayers();
    let doc: PlayerDoc | null = null;
    if (userId && players) {
      try {
        doc = await players.findOne({ _id: userId });
      } catch (err) {
        console.warn("[WorldRoom] loadProgress failed", err);
        this.seedTower(client.sessionId, null); // the tower must not hold the others' boot
        client.send("serverError", {});
        return;
      }
    }
    // The player may have left meanwhile.
    if (this.state.players.get(client.sessionId) !== p) return;

    this.loaded.add(client.sessionId);
    this.seedTower(client.sessionId, doc?.tower); // before `progress`: the client's boot waits for both
    const now = Date.now();
    // Rewards first, so the client has them by the time its boot (waiting on progress) goes on.
    if (userId && players) {
      const r = new RewardsState(doc?.rewards ? sanitizeRewards(doc.rewards, now) : freshRewards(now), now);
      this.rewards.set(client.sessionId, r);
      this.safeSend(client, "rewards", r.view(now));
    }
    if (userId && players) await this.loadOffline(client, userId, doc, now);
    if (this.state.players.get(client.sessionId) !== p) return;
    if (!doc) client.send("noProgress", { serverTime: now });
    else {
      const saved = sanitizeProgress(doc) ?? {};
      client.send("progress", { ...saved, serverTime: now });
      if (userId) reportPlayer(userId, saved); // what the platform's boards should show for them
    }
    void this.sendLeaderboard(client);
    if (userId && players) void this.loadInvite(client, userId, doc, p);
  }

  // Offline reward: how long this player was away since their last save / leave, plus what they left
  // unclaimed. The new total is stored together with a fresh `lastSeen` (conditional on the one we read,
  // so two pods loading the same account never both add the same absence), then sent as `offline`
  // { secs, max } (secs 0 = nothing to claim). A failed read or write just means no popup this time.
  private async loadOffline(client: Client, userId: string, doc: PlayerDoc | null, now: number) {
    const players = getPlayers();
    if (!players) return;
    let secs = 0;
    try {
      if (doc) {
        secs = accrueOffline(doc.offlineSecs, doc.lastSeen, now);
        const filter = typeof doc.lastSeen === "number" ? { _id: userId, lastSeen: doc.lastSeen } : { _id: userId, lastSeen: { $exists: false } };
        const res = await players.updateOne(filter, { $set: { lastSeen: now, offlineSecs: secs } });
        if (res.modifiedCount !== 1) secs = sanitizeOfflineSecs((await players.findOne({ _id: userId }))?.offlineSecs); // another pod took this absence
      }
    } catch (err) {
      console.warn("[WorldRoom] loadOffline failed", err);
      secs = 0;
    }
    if (!this.state.players.has(client.sessionId)) return;
    this.offline.set(client.sessionId, secs);
    this.safeSend(client, "offline", offlineView(secs));
  }

  // Stores Invite Friends fields. True when stored.
  private async saveInvite(userId: string, fields: Partial<PlayerDoc>): Promise<boolean> {
    const players = getPlayers();
    if (!players) return false;
    try {
      await players.updateOne({ _id: userId }, { $set: { ...fields, updatedAt: new Date() }, $setOnInsert: { version: 1 } }, { upsert: true });
      return true;
    } catch (err) {
      console.warn("[WorldRoom] saveInvite failed", err);
      return false;
    }
  }

  // The player's invite state, read with the save: who invited them, their friends (and pending ones),
  // and -- for a NEW signed-in player who joined through a link or a direct invite -- the one-time link
  // to their inviter. Answers `invite` (and `invitedBy` when they were just invited).
  private async loadInvite(client: Client, userId: string, doc: PlayerDoc | null, p: PlayerState) {
    const players = getPlayers();
    if (!players) return;
    const sid = client.sessionId;
    try {
      const s = readInvite(doc);
      s.pending = await players.countDocuments({ invitedBy: userId, inviteCredited: { $ne: true } });
      if (s.invitedBy) s.invitedByName = (await players.findOne({ _id: s.invitedBy }))?.username || "A friend";
      else if (isNewPlayer(doc, INVITE_NEW_PLAYTIME_MAX)) await this.creditInvite(sid, userId, s);
      if (this.state.players.get(sid) !== p) return; // left meanwhile
      this.invites.set(sid, s);
      this.safeSend(client, "invite", inviteView(s));
      if (s.invitedBy && s.welcome === "ready" && !doc?.invitedBy) this.safeSend(client, "invitedBy", { name: s.invitedByName });
    } catch (err) {
      console.warn("[WorldRoom] loadInvite failed", err);
    }
  }

  // A new signed-in player joined: if their link's `ref` (or a direct invite, `invitesSent`) names an
  // existing player, that player becomes their inviter. `invitedBy` is set ONCE (a conditional write, so
  // two pods can't both link them) and their welcome gift is ready. The inviter is credited later, when
  // this friend has actually played (maybeActivate); they only see one more pending friend now.
  private async creditInvite(sid: string, userId: string, s: InviteState) {
    const players = getPlayers();
    if (!players) return;
    const ref = this.refs.get(sid);
    let inviter = ref && ref !== userId ? await players.findOne({ _id: ref }) : null;
    if (!inviter) inviter = await players.findOne({ invitesSent: userId });
    if (!inviter || inviter._id === userId) return;
    try {
      await players.updateOne(
        { _id: userId, invitedBy: { $exists: false } },
        { $set: { invitedBy: inviter._id, welcome: "ready" }, $setOnInsert: { version: 1, updatedAt: new Date() } },
        { upsert: true },
      );
    } catch {
      return; // already invited (a duplicate key on the upsert): the first link stands
    }
    s.invitedBy = inviter._id;
    s.invitedByName = inviter.username || "A friend";
    s.welcome = "ready";
    // The inviter, when online in this room: one more friend waiting to start playing.
    for (const [osid, uid] of this.userIds) {
      const is = this.invites.get(osid);
      const c = this.clients.find((x) => x.sessionId === osid);
      if (uid !== inviter._id || !is || !c) continue;
      is.pending++;
      this.safeSend(c, "invite", inviteView(is));
    }
  }

  // An invited friend whose saved progress now reaches the "actually playing" bar counts for their
  // inviter, once ever (`inviteCredited`, conditional): the inviter's friends go up and, when they are in
  // this room, they hear about it live. Others see it on `inviteRefresh` or their next join.
  private async maybeActivate(sid: string, userId: string, patch: Partial<PlayerDoc>) {
    const s = this.invites.get(sid);
    const players = getPlayers();
    if (!s || !players || !s.invitedBy || s.credited || this.activating.has(sid) || !isActive(patch.playtime, patch.totalBlocks)) return;
    this.activating.add(sid);
    try {
      const res = await players.updateOne({ _id: userId, inviteCredited: { $ne: true } }, { $set: { inviteCredited: true } });
      if (res.modifiedCount === 1) await players.updateOne({ _id: s.invitedBy }, { $inc: { invites: 1 } });
      s.credited = true; // credited now, or by another pod a moment ago
      const me = this.state.players.get(sid);
      const mine = this.clients.find((c) => c.sessionId === sid);
      if (mine) this.safeSend(mine, "invite", inviteView(s));
      if (res.modifiedCount !== 1) return;
      for (const [osid, uid] of this.userIds) {
        const is = this.invites.get(osid);
        const c = this.clients.find((x) => x.sessionId === osid);
        if (uid !== s.invitedBy || !is || !c) continue;
        is.invites = Math.min(INVITES_MAX, is.invites + 1);
        is.pending = Math.max(0, is.pending - 1);
        this.safeSend(c, "friendJoined", { name: me?.username || "A friend" });
        this.safeSend(c, "invite", inviteView(is));
      }
    } catch (err) {
      console.warn("[WorldRoom] maybeActivate failed", err); // not credited: the next save tries again
    } finally {
      this.activating.delete(sid);
    }
  }
}
