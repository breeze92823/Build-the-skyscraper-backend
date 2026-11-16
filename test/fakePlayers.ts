import type { Collection } from "mongodb";

import type { PlayerDoc } from "../src/db.js";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Does a doc match a Mongo-style filter? Plain values (an array field matches when it CONTAINS the value),
// and the operators the server uses: $exists, $ne, $gt, $gte, $lt, $lte.
function matches(doc: any, filter: Record<string, any>): boolean {
  return Object.entries(filter).every(([field, cond]) => {
    const v = doc[field];
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      return Object.entries(cond).every(([op, arg]: [string, any]) => {
        if (op === "$exists") return (v !== undefined) === arg;
        if (op === "$ne") return v !== arg;
        if (op === "$gt") return v > arg;
        if (op === "$gte") return v >= arg;
        if (op === "$lt") return v < arg;
        if (op === "$lte") return v <= arg;
        throw new Error(`fake collection: unsupported operator ${op}`);
      });
    }
    return Array.isArray(v) ? v.includes(cond) : v === cond;
  });
}

// Just what the server calls: findOne / find().sort().limit().toArray() / countDocuments with those filters, and
// updateOne (upsert, $set, $max, $inc, $setOnInsert). Like Mongo, an upsert whose filter matches nothing but whose
// `_id` already exists fails with a duplicate-key error (that is how "set once" writes lose a race).
// Reads wait for release(), so a test registers its message handlers before the load answers.
export function fakePlayers(seed: PlayerDoc[] = []) {
  const docs = new Map<string, PlayerDoc>(seed.map((d) => [d._id, d]));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  // hold(): makes reads wait again until the returned function is called (for a player who joins after release()).
  let held: Promise<void> = Promise.resolve();
  const fake = {
    docs,
    gate,
    release,
    hold(): () => void {
      let go!: () => void;
      held = new Promise<void>((r) => (go = r));
      return go;
    },
    async findOne(filter: Record<string, any>) {
      await gate;
      await held;
      return [...docs.values()].find((d) => matches(d, filter)) ?? null;
    },
    find(filter: Record<string, any>) {
      let rows = [...docs.values()].filter((d) => matches(d, filter));
      const cursor = {
        sort(by: Record<string, number>) {
          const [f, dir] = Object.entries(by)[0];
          rows = rows.sort((a: any, b: any) => dir * ((a[f] ?? 0) - (b[f] ?? 0)));
          return cursor;
        },
        limit(n: number) {
          rows = rows.slice(0, n);
          return cursor;
        },
        toArray: async () => {
          await gate;
          return rows;
        },
      };
      return cursor;
    },
    async countDocuments(filter: Record<string, any>) {
      return [...docs.values()].filter((d) => matches(d, filter)).length;
    },
    async updateOne(filter: Record<string, any>, update: any, options: any) {
      const existing = [...docs.values()].find((d) => matches(d, filter));
      if (!existing) {
        if (!options?.upsert) return { modifiedCount: 0, matchedCount: 0 };
        if (typeof filter._id === "string" && docs.has(filter._id)) throw new Error("E11000 duplicate key error");
      }
      const next: any = { ...(existing ?? { _id: filter._id, ...(update.$setOnInsert ?? {}) }), ...(update.$set ?? {}) };
      for (const [k, v] of Object.entries(update.$max ?? {})) next[k] = Math.max(next[k] ?? -Infinity, v as number);
      for (const [k, v] of Object.entries(update.$inc ?? {})) next[k] = (next[k] ?? 0) + (v as number);
      docs.set(next._id, next);
      return { modifiedCount: 1, matchedCount: existing ? 1 : 0 };
    },
  };
  return fake as unknown as Collection<PlayerDoc> & { docs: Map<string, PlayerDoc>; gate: Promise<void>; release: () => void; hold: () => () => void };
}
