/**
 * Tiny in-memory fake Supabase client for unit tests of `apply.ts`.
 *
 * Implements only the subset of postgrest-builder methods that apply.ts
 * actually uses:
 *   .select(cols).eq(c, v)[.eq(...).order(...).limit(...)][.maybeSingle()|.single()|await]
 *   .insert(row|rows)[.select(cols)[.single()]]
 *   .update(patch).eq(c, v).eq(...)
 *   .upsert(rows, { onConflict })[.select(cols).single()]
 *   .rpc(name, args)
 *
 * Keeps tests fast (~1 ms per case) and side-effect-free. The store is
 * accessible on the client for assertions:
 *
 *   const client = makeFakeClient();
 *   client.seed('leads', [...]);
 *   await applyPlan({ client: client as any, ... });
 *   expect(client.tableRows('leads')).toHaveLength(2);
 */
import { randomUUID } from 'node:crypto';

type Row = Record<string, unknown>;

type RpcFn = (args: Record<string, unknown> | undefined) => unknown;

class Store {
  tables = new Map<string, Row[]>();
  rpcs = new Map<string, RpcFn>();

  table(name: string): Row[] {
    let t = this.tables.get(name);
    if (!t) {
      t = [];
      this.tables.set(name, t);
    }
    return t;
  }
}

interface QueryResult<T = Row | Row[] | null> {
  data: T;
  error: { message: string; code?: string } | null;
}

interface Filter {
  col: string;
  op: 'eq' | 'in' | 'not_is_null' | 'gte' | 'lt' | 'or' | 'is_null';
  val?: unknown;
  raw?: string;
}

class Builder implements PromiseLike<QueryResult> {
  private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private payload: Row | Row[] | null = null;
  private singleMode: 'none' | 'single' | 'maybeSingle' = 'none';
  private upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } | null = null;

  constructor(
    private store: Store,
    private tableName: string,
  ) {}

  // ---- chainable -----
  select(_cols?: string): this {
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push({ col, op: 'eq', val });
    return this;
  }
  in(col: string, vals: unknown[]): this {
    this.filters.push({ col, op: 'in', val: vals });
    return this;
  }
  not(col: string, _op: string, _val: unknown): this {
    this.filters.push({ col, op: 'not_is_null' });
    return this;
  }
  is(col: string, val: unknown): this {
    // Only the `is(null)` form is used by app code; mirror that.
    if (val === null) this.filters.push({ col, op: 'is_null' });
    return this;
  }
  gte(col: string, val: unknown): this {
    this.filters.push({ col, op: 'gte', val });
    return this;
  }
  lt(col: string, val: unknown): this {
    this.filters.push({ col, op: 'lt', val });
    return this;
  }
  or(raw: string): this {
    this.filters.push({ col: '', op: 'or', raw });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderCol = col;
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  maybeSingle(): Promise<QueryResult<Row | null>> {
    this.singleMode = 'maybeSingle';
    return Promise.resolve(this._exec()) as Promise<QueryResult<Row | null>>;
  }
  single(): Promise<QueryResult<Row>> {
    this.singleMode = 'single';
    return Promise.resolve(this._exec()) as Promise<QueryResult<Row>>;
  }

  // ---- mutations -----
  insert(payload: Row | Row[]): this {
    this.op = 'insert';
    this.payload = payload;
    return this;
  }
  update(payload: Row): this {
    this.op = 'update';
    this.payload = payload;
    return this;
  }
  upsert(payload: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
    this.op = 'upsert';
    this.payload = payload;
    this.upsertOpts = opts ?? null;
    return this;
  }
  delete(): this {
    this.op = 'delete';
    return this;
  }

  // ---- thenable so plain `await builder` resolves -----
  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: (value: QueryResult) => TResult1 | PromiseLike<TResult1>,
    onrejected?: (reason: unknown) => TResult2 | PromiseLike<TResult2>,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this._exec()).then(onfulfilled, onrejected);
  }

  // ---- internals -----
  private _exec(): QueryResult {
    const rows = this.store.table(this.tableName);

    if (this.op === 'insert') {
      const items = Array.isArray(this.payload) ? this.payload : [this.payload!];
      const inserted = items.map((p) => ({ id: randomUUID(), ...p }));
      rows.push(...inserted);
      return this._maybeSingleize(inserted);
    }

    if (this.op === 'update') {
      const matched = this._filter(rows);
      for (const r of matched) Object.assign(r, this.payload as Row);
      return this._maybeSingleize(matched);
    }

    if (this.op === 'upsert') {
      const items = Array.isArray(this.payload) ? this.payload : [this.payload!];
      const conflictCols = (this.upsertOpts?.onConflict ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const result: Row[] = [];
      for (const p of items) {
        let existing: Row | undefined;
        if (conflictCols.length > 0) {
          existing = rows.find((r) => conflictCols.every((c) => r[c] === (p as Row)[c]));
        }
        if (existing) {
          Object.assign(existing, p);
          result.push(existing);
        } else {
          const fresh = { id: randomUUID(), ...(p as Row) };
          rows.push(fresh);
          result.push(fresh);
        }
      }
      return this._maybeSingleize(result);
    }

    if (this.op === 'delete') {
      const matched = this._filter(rows);
      const toRemove = new Set(matched);
      const survivors = rows.filter((r) => !toRemove.has(r));
      rows.length = 0;
      rows.push(...survivors);
      return this._maybeSingleize(matched);
    }

    // select
    let filtered = this._filter(rows);
    if (this.orderCol) {
      const col = this.orderCol;
      filtered = [...filtered].sort((a, b) => {
        const av = a[col];
        const bv = b[col];
        if (av === bv) return 0;
        return ((av as number | string) < (bv as number | string) ? -1 : 1) * (this.orderAsc ? 1 : -1);
      });
    }
    if (this.limitN != null) filtered = filtered.slice(0, this.limitN);
    return this._maybeSingleize(filtered);
  }

  private _filter(rows: Row[]): Row[] {
    return rows.filter((r) =>
      this.filters.every((f) => {
        switch (f.op) {
          case 'eq':
            return r[f.col] === f.val;
          case 'in':
            return Array.isArray(f.val) && (f.val as unknown[]).includes(r[f.col]);
          case 'not_is_null':
            return r[f.col] != null;
          case 'is_null':
            return r[f.col] == null;
          case 'gte':
            return (r[f.col] as number | string) >= (f.val as number | string);
          case 'lt':
            return (r[f.col] as number | string) < (f.val as number | string);
          case 'or':
            return true; // not used by apply.ts; permissive default
          default:
            return true;
        }
      }),
    );
  }

  private _maybeSingleize(rows: Row[]): QueryResult {
    if (this.singleMode === 'single') {
      if (rows.length === 0) {
        return { data: null, error: { message: 'no rows', code: 'PGRST116' } };
      }
      return { data: rows[0]!, error: null };
    }
    if (this.singleMode === 'maybeSingle') {
      return { data: rows.length === 0 ? null : rows[0]!, error: null };
    }
    return { data: rows, error: null };
  }
}

export interface FakeClient {
  from(name: string): Builder;
  rpc(name: string, args?: Record<string, unknown>): Promise<QueryResult>;
  /** Direct seeding for test setup. */
  seed(table: string, rows: Row[]): void;
  /** Inspect the rows in a table. */
  tableRows(table: string): Row[];
  /** Register an RPC stub. */
  registerRpc(name: string, fn: RpcFn): void;
}

export function makeFakeClient(): FakeClient {
  const store = new Store();
  return {
    from(name) {
      return new Builder(store, name);
    },
    rpc(name, args) {
      const fn = store.rpcs.get(name);
      if (!fn) return Promise.resolve({ data: [] as Row[], error: null });
      const result = fn(args) as Row | Row[] | null;
      return Promise.resolve({ data: result, error: null });
    },
    seed(table, rows) {
      store.table(table).push(...rows);
    },
    tableRows(table) {
      return store.table(table);
    },
    registerRpc(name, fn) {
      store.rpcs.set(name, fn);
    },
  };
}
