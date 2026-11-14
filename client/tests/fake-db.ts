import { ObjectId, type Db } from "mongodb";

// A tiny in-memory stand-in for the Mongo calls the write path makes.
// Supports equality, $in, dotted paths and $set. Docs are replaced on update, never mutated,
// so a transaction can roll back by restoring the array of references.

type Doc = Record<string, unknown>;

// Like Mongo, a path through an array matches any element ("members.user_id").
const get = (d: Doc, path: string): unknown => path.split(".").reduce<unknown>((v, k) => {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v.map((x) => (x as Doc)?.[k]);
  return (v as Doc)[k];
}, d);
const eq1 = (a: unknown, b: unknown) => (a instanceof ObjectId && b instanceof ObjectId ? a.equals(b) : a === b);
const eq = (a: unknown, b: unknown) => (Array.isArray(a) ? a.some((x) => eq1(x, b)) : eq1(a, b));

function matches(d: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([k, cond]) => {
    const v = get(d, k);
    if (cond && typeof cond === "object" && !(cond instanceof ObjectId) && "$in" in (cond as Doc)) {
      return ((cond as Doc).$in as unknown[]).some((c) => eq(v, c));
    }
    return eq(v, cond);
  });
}

function setPath(d: Doc, path: string, value: unknown): Doc {
  const [head, ...rest] = path.split(".");
  if (!rest.length) return { ...d, [head]: value };
  return { ...d, [head]: setPath(((d[head] as Doc) ?? {}), rest.join("."), value) };
}

export function fakeDb(seed: Record<string, Doc[]> = {}) {
  const store: Record<string, Doc[]> = { memories: [], households: [], audit_log: [], ...seed };
  let aggregateImpl: (pipeline: Doc[]) => Doc[] = () => [];
  const pipelines: Doc[][] = [];
  let failNextInsert = false;

  const collection = (name: string) => {
    store[name] ??= [];
    return {
      async findOne(filter: Doc) { return store[name].find((d) => matches(d, filter)) ?? null; },
      async findOneAndUpdate(filter: Doc, update: { $set: Doc }) {
        const i = store[name].findIndex((d) => matches(d, filter));
        if (i < 0) return null;
        const before = store[name][i];
        let next = before;
        for (const [k, v] of Object.entries(update.$set)) next = setPath(next, k, v);
        store[name] = store[name].map((d, j) => (j === i ? next : d));
        return before;
      },
      async updateOne(filter: Doc, update: { $set: Doc }) {
        const i = store[name].findIndex((d) => matches(d, filter));
        if (i < 0) return { matchedCount: 0, modifiedCount: 0 };
        let next = store[name][i];
        for (const [k, v] of Object.entries(update.$set)) next = setPath(next, k, v);
        store[name] = store[name].map((d, j) => (j === i ? next : d));
        return { matchedCount: 1, modifiedCount: 1 };
      },
      async deleteOne(filter: Doc) {
        const before = store[name].length;
        store[name] = store[name].filter((d) => !matches(d, filter));
        return { deletedCount: before - store[name].length };
      },
      async insertOne(doc: Doc) {
        if (failNextInsert) { failNextInsert = false; throw new Error("simulated write failure"); }
        const withId = { _id: new ObjectId(), ...doc };
        store[name] = [...store[name], withId];
        return { insertedId: withId._id };
      },
      find(filter: Doc) {
        const rows = store[name].filter((d) => matches(d, filter));
        const api = {
          sort(spec: Record<string, 1 | -1>) {
            const [[k, dir]] = Object.entries(spec);
            rows.sort((a, b) => ((get(a, k) as number) > (get(b, k) as number) ? dir : -dir));
            return api;
          },
          limit() { return api; },
          async toArray() { return rows; },
        };
        return api;
      },
      aggregate(pipeline: Doc[]) {
        pipelines.push(pipeline);
        return { toArray: async () => aggregateImpl(pipeline) };
      },
    };
  };

  const db = { collection } as unknown as Db;
  // Stand-in MongoClient: withSession + session.withTransaction with rollback on throw.
  const client = {
    withSession: async <T>(fn: (session: unknown) => Promise<T>) => fn({
      withTransaction: async <U>(inner: () => Promise<U>) => {
        const snapshot = Object.fromEntries(Object.entries(store).map(([k, v]) => [k, [...v]]));
        try { return await inner(); } catch (e) { for (const k of Object.keys(store)) store[k] = snapshot[k] ?? []; throw e; }
      },
    }),
  };
  return {
    db,
    client,
    store,
    pipelines,
    onAggregate(fn: (pipeline: Doc[]) => Doc[]) { aggregateImpl = fn; },
    failNextInsert() { failNextInsert = true; },
    // Rolls back every collection when fn throws, like session.withTransaction.
    withTransaction: async <T>(fn: (s: undefined) => Promise<T>): Promise<T> => {
      const snapshot = Object.fromEntries(Object.entries(store).map(([k, v]) => [k, [...v]]));
      try {
        return await fn(undefined);
      } catch (e) {
        for (const k of Object.keys(store)) store[k] = snapshot[k] ?? [];
        throw e;
      }
    },
  };
}
