import assert from "assert";

import { CURRENCY_MAX, STAT_MAX } from "../src/constants.js";
import { sanitizeProgress } from "../src/sanitize.js";

describe("sanitizeProgress", () => {
  it("rejects non-objects and bounds numbers", () => {
    assert.strictEqual(sanitizeProgress(null), null);
    assert.strictEqual(sanitizeProgress([1]), null);
    const out = sanitizeProgress({ cash: 1e40, strength: -5, speed: NaN, totalBlocks: 3.7, buildings: "x", hack: "x" })!;
    assert.strictEqual(out.cash, CURRENCY_MAX);
    assert.strictEqual(out.strength, 0);
    assert.strictEqual(out.speed, undefined);
    assert.strictEqual(out.totalBlocks, 3);
    assert.strictEqual(out.buildings, undefined);
    assert.ok(!("hack" in out));
    assert.strictEqual(sanitizeProgress({ totalBlocks: 1e30 })!.totalBlocks, STAT_MAX);
  });

  it("only returns the fields the save carries", () => {
    assert.deepStrictEqual(sanitizeProgress({ cash: 5 }), { cash: 5 });
  });

  it("keeps well-formed maps and drops the rest", () => {
    const out = sanitizeProgress({
      upgrades: { grab: 3.9, build: -2, "bad id!": 4, range: "x" },
      passes: { cash2: true, str2: false, "bad id!": true, slots: 1 },
      gymOwned: { "3": true, "9": true, x: true },
      petSeen: { dog: true, "Bad Id!": true },
      daily: { day: "2026-11-16", streak: 4.5 },
    })!;
    assert.deepStrictEqual(out.upgrades, { grab: 3, build: 0 });
    assert.deepStrictEqual(out.passes, { cash2: true });
    assert.deepStrictEqual(out.gymOwned, { "3": true, "9": true });
    assert.deepStrictEqual(out.petSeen, { dog: true });
    assert.ok(!("crew" in sanitizeProgress({ crew: ["x"] })!), "the Crew concept is gone: an old save's crew is ignored");
    assert.deepStrictEqual(out.daily, { day: "2026-11-16", streak: 4 });
    assert.deepStrictEqual(sanitizeProgress({ daily: { day: "yesterday", streak: -1 } })!.daily, { day: "", streak: 0 });
  });

  it("keeps the tower, spins and only wears owned gear", () => {
    const out = sanitizeProgress({
      tower: { n: 2, floors: 7.9, blocks: 120 },
      spins: { normal: 3, golden: -1, pity: 12.5 },
      gear: { owned: { jetboots: true, mech: true, "Bad Id!": true }, on: "jetboots" },
    })!;
    assert.deepStrictEqual(out.tower, { n: 2, floors: 7, blocks: 120 });
    assert.deepStrictEqual(out.spins, { normal: 3, golden: 0, pity: 12 });
    assert.deepStrictEqual(out.gear, { owned: { jetboots: true, mech: true }, on: "jetboots" });
    assert.strictEqual(sanitizeProgress({ gear: { owned: { mech: true }, on: "titan" } })!.gear!.on, null);
    assert.strictEqual(sanitizeProgress({ tower: { floors: 3 } })!.tower, undefined);
  });

  it("keeps well-formed pets and only equips owned ones", () => {
    const out = sanitizeProgress({
      pets: [
        { uid: 1, id: "dog", tier: 0 },
        { uid: 1, id: "dup", tier: 0 },
        { uid: 2, id: "cat", tier: 2 },
        { uid: 3, id: "Bad Id!", tier: 0 },
        { uid: 4, id: "fox", tier: 1.5 },
        { uid: 5, id: "bear", tier: 99 },
        { uid: 0, id: "zero", tier: 0 },
        "x",
      ],
      petEq: [2, 2, 1, 9, "x"],
      petUid: 6,
    })!;
    assert.deepStrictEqual(out.pets, [
      { uid: 1, id: "dog", tier: 0 },
      { uid: 2, id: "cat", tier: 2 },
    ]);
    assert.deepStrictEqual(out.petEq, [2, 1]);
    assert.strictEqual(out.petUid, 6);
  });

  it("keeps the Goals tracker bounded (client goals.js)", () => {
    const out = sanitizeProgress({ goals: { kind: "place", need: 340, have: 120.5, reward: 1e40, done: 7.9, day: 20773, today: -3, seen: 1.7e12, extra: "x" } })!;
    assert.deepStrictEqual(out.goals, { kind: "place", need: 340, have: 120.5, reward: CURRENCY_MAX, done: 7, day: 20773, today: 0, seen: 1.7e12 });
    assert.strictEqual(sanitizeProgress({ goals: { kind: "<script>" } })!.goals!.kind, "", "only slug kinds");
    assert.strictEqual(sanitizeProgress({ goals: "junk" })!.goals, undefined, "junk leaves the field alone");
  });
});
