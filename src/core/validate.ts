/**
 * Minimal strict schema/validation library.
 *
 * DEVIATION NOTE: the founding spec prefers Zod. This build environment has no
 * npm registry access, so schemas are implemented with this dependency-free
 * combinator library. The API is deliberately Zod-shaped (parse/safeParse)
 * so migrating to Zod later is mechanical. Behavior is strict: closed
 * objects reject unknown keys.
 */

export class SchemaError extends Error {
  override name = "SchemaError";
  constructor(public issues: string[]) {
    super(issues.join("; "));
  }
}

export interface Schema<T> {
  parse(input: unknown, path?: string): T;
  safeParse(input: unknown): { ok: true; value: T } | { ok: false; issues: string[] };
}

function mk<T>(fn: (input: unknown, path: string) => T): Schema<T> {
  return {
    parse: (input, path = "$") => fn(input, path),
    safeParse(input) {
      try {
        return { ok: true, value: fn(input, "$") };
      } catch (e) {
        if (e instanceof SchemaError) return { ok: false, issues: e.issues };
        throw e;
      }
    },
  };
}

const fail = (path: string, msg: string): never => {
  throw new SchemaError([`${path}: ${msg}`]);
};

export const str = (opts?: { min?: number; max?: number; pattern?: RegExp }) =>
  mk<string>((i, p) => {
    if (typeof i !== "string") return fail(p, "expected string");
    if (opts?.min !== undefined && i.length < opts.min) return fail(p, `min length ${opts.min}`);
    if (opts?.max !== undefined && i.length > opts.max) return fail(p, `max length ${opts.max}`);
    if (opts?.pattern && !opts.pattern.test(i)) return fail(p, `pattern ${String(opts.pattern)}`);
    return i;
  });

export const num = (opts?: { int?: boolean; min?: number; max?: number }) =>
  mk<number>((i, p) => {
    if (typeof i !== "number" || !Number.isFinite(i)) return fail(p, "expected finite number");
    if (opts?.int && !Number.isSafeInteger(i)) return fail(p, "expected safe integer (|n| <= 2^53-1)");
    if (opts?.min !== undefined && i < opts.min) return fail(p, `min ${opts.min}`);
    if (opts?.max !== undefined && i > opts.max) return fail(p, `max ${opts.max}`);
    return i;
  });

export const bool = () =>
  mk<boolean>((i, p) => (typeof i === "boolean" ? i : fail(p, "expected boolean")));

export const nul = () => mk<null>((i, p) => (i === null ? null : fail(p, "expected null")));

export const lit = <const V extends string | number | boolean>(v: V) =>
  mk<V>((i, p) => (i === v ? v : fail(p, `expected literal ${JSON.stringify(v)}`)));

/** Closed enum of string values. Anything outside the set is rejected. */
export const en = <const V extends readonly string[]>(values: V) =>
  mk<V[number]>((i, p) =>
    typeof i === "string" && (values as readonly string[]).includes(i)
      ? (i as V[number])
      : fail(p, `expected one of [${values.join(", ")}], got ${JSON.stringify(i)}`)
  );

export const nullable = <T>(s: Schema<T>): Schema<T | null> =>
  mk((i, p) => (i === null ? null : s.parse(i, p)));

export const arr = <T>(s: Schema<T>, opts?: { min?: number }) =>
  mk<T[]>((i, p) => {
    if (!Array.isArray(i)) return fail(p, "expected array");
    if (opts?.min !== undefined && i.length < opts.min) return fail(p, `min items ${opts.min}`);
    return i.map((v, idx) => s.parse(v, `${p}[${idx}]`));
  });

export const unknownJson = (): Schema<unknown> => mk<unknown>((i) => i);

type Shape = Record<string, Schema<unknown>>;

const OPT = Symbol("optional");
export interface OptSchema<T> extends Schema<T> {
  readonly [OPT]: true;
}

/** Mark an object property as optional (may be absent; if present must validate). */
export const opt = <T>(s: Schema<T>): OptSchema<T> =>
  Object.assign(mk<T>((i, p) => s.parse(i, p)), { [OPT]: true as const });

type Out<S extends Shape> = {
  [K in keyof S as S[K] extends OptSchema<unknown> ? never : K]: S[K] extends Schema<infer T>
    ? T
    : never;
} & {
  [K in keyof S as S[K] extends OptSchema<unknown> ? K : never]?: S[K] extends Schema<infer T>
    ? T
    : never;
};

/** Strict (closed) object: unknown keys are rejected. */
export const obj = <S extends Shape>(shape: S): Schema<Out<S>> =>
  mk((i, p) => {
    if (typeof i !== "object" || i === null || Array.isArray(i)) return fail(p, "expected object");
    const rec = i as Record<string, unknown>;
    const issues: string[] = [];
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec)) {
      if (!(key in shape)) issues.push(`${p}.${key}: unknown key`);
    }
    for (const [key, schema] of Object.entries(shape)) {
      const optional = (schema as Partial<Record<typeof OPT, boolean>>)[OPT] === true;
      const val = rec[key];
      if (val === undefined) {
        if (!optional) issues.push(`${p}.${key}: required`);
        continue;
      }
      try {
        out[key] = schema.parse(val, `${p}.${key}`);
      } catch (e) {
        if (e instanceof SchemaError) issues.push(...e.issues);
        else throw e;
      }
    }
    if (issues.length) throw new SchemaError(issues);
    return out as Out<S>;
  });
