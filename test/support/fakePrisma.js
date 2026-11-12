// test/support/fakePrisma.js — A small in-memory stand-in for the Prisma
// client, enough for the auth / session / deletion services under test.
// Tables are plain arrays; `where` supports equality, null, { equals, mode },
// { not }, { gt, gte, lt, lte }, { in } and OR. Models nobody seeded answer
// like empty tables.

function matchValue(actual, cond) {
  if (cond === null) return actual === null || actual === undefined;
  if (cond instanceof Date) return actual instanceof Date && actual.getTime() === cond.getTime();
  if (typeof cond !== 'object') return actual === cond;
  if ('equals' in cond) {
    if (cond.mode === 'insensitive') return String(actual ?? '').toLowerCase() === String(cond.equals).toLowerCase();
    return actual === cond.equals;
  }
  const cmp = (v) => (v instanceof Date ? v.getTime() : v);
  const a = cmp(actual);
  if ('not' in cond && matchValue(actual, cond.not)) return false;
  if ('gt' in cond && !(a != null && a > cmp(cond.gt))) return false;
  if ('gte' in cond && !(a != null && a >= cmp(cond.gte))) return false;
  if ('lt' in cond && !(a != null && a < cmp(cond.lt))) return false;
  if ('lte' in cond && !(a != null && a <= cmp(cond.lte))) return false;
  if ('in' in cond && !cond.in.includes(actual)) return false;
  return true;
}

function matches(row, where = {}) {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return cond.some((w) => matches(row, w));
    if (key === 'AND') return cond.every((w) => matches(row, w));
    return matchValue(row[key], cond);
  });
}

function applyData(row, data) {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in value) row[key] = (row[key] ?? 0) + value.increment;
    else if (value && typeof value === 'object' && 'decrement' in value) row[key] = (row[key] ?? 0) - value.decrement;
    else row[key] = value;
  }
  return row;
}

export function model(rows, { idKey = 'id', autoId = true } = {}) {
  let nextId = 1n + BigInt(rows.filter((r) => typeof r[idKey] === 'bigint').length);
  const uniqueWhere = (where) => rows.find((r) => matches(r, where)) ?? null;
  // Reads return copies, as Prisma does — later writes don't show through.
  const copy = (row) => (row ? { ...row } : null);
  return {
    rows,
    findUnique: async ({ where }) => copy(uniqueWhere(where)),
    findFirst: async ({ where = {}, orderBy } = {}) => {
      let found = rows.filter((r) => matches(r, where));
      const [sortKey, dir] = Object.entries(orderBy ?? {})[0] ?? [];
      if (sortKey) found = [...found].sort((a, b) => (dir === 'desc' ? b[sortKey] - a[sortKey] : a[sortKey] - b[sortKey]));
      return copy(found[0]);
    },
    findMany: async ({ where = {}, skip = 0, take } = {}) => rows.filter((r) => matches(r, where)).slice(skip, skip + (take ?? Infinity)).map(copy),
    count: async ({ where = {} } = {}) => rows.filter((r) => matches(r, where)).length,
    create: async ({ data }) => {
      const row = { created_at: new Date(), ...data };
      if (autoId && row[idKey] === undefined) row[idKey] = nextId++;
      rows.push(row);
      return row;
    },
    update: async ({ where, data }) => {
      const row = uniqueWhere(where);
      if (!row) throw new Error('fakePrisma: record to update not found');
      return applyData(row, data);
    },
    updateMany: async ({ where = {}, data }) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => applyData(r, data));
      return { count: hit.length };
    },
    delete: async ({ where }) => {
      const i = rows.findIndex((r) => matches(r, where));
      return i >= 0 ? rows.splice(i, 1)[0] : null;
    },
    deleteMany: async ({ where = {} } = {}) => {
      let count = 0;
      for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], where)) { rows.splice(i, 1); count++; }
      return { count };
    },
    aggregate: async () => ({ _max: {} }),
  };
}

export function createFakePrisma(seed = {}) {
  const models = {
    users:          model(seed.users ?? []),
    auth_providers: model(seed.auth_providers ?? []),
    account_otps:   model(seed.account_otps ?? []),
    email_otps:     model(seed.email_otps ?? []),
    refresh_tokens: model(seed.refresh_tokens ?? [], { idKey: 'jti', autoId: false }),
    data_export_requests: model(seed.data_export_requests ?? []),
    notifications:  model(seed.notifications ?? []),
    user_settings:  model(seed.user_settings ?? [], { idKey: 'user_id', autoId: false }),
    pending_media_cleanup: model(seed.pending_media_cleanup ?? []),
    user_progression: model(seed.user_progression ?? []),
    streak_events:  model(seed.streak_events ?? []),
    user_rewards:   model(seed.user_rewards ?? []),
  };
  const empty = model([]);

  const client = new Proxy({}, {
    get(_, prop) {
      if (prop === '$transaction') {
        return async (arg) => (typeof arg === 'function' ? arg(client) : Promise.all(arg));
      }
      if (prop === '$queryRaw') {
        // Only the refresh_tokens row lock is used by the code under test.
        return async (strings, ...values) => {
          const sql = strings.join('?');
          if (sql.includes('FROM refresh_tokens')) {
            return models.refresh_tokens.rows.filter((r) => r.jti === values[0]);
          }
          return [];
        };
      }
      if (prop === '$disconnect') return async () => {};
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return models[prop] ?? empty;
    },
  });
  return { client, models };
}
