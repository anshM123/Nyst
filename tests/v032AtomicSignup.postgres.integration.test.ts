/**
 * Nyst v0.3.2 — Phase 4. A WORKSPACE IS CREATED WHOLE, OR NOT AT ALL.
 *
 * THE DEFECT.
 *
 * `createBootstrap` ran three separate statements on the pool: the
 * organization/project/environment/user CTE, then the default policy, then the
 * default Autonomy Line rule. Nothing tied them together.
 *
 * A failure after the first one — a constraint, a dropped connection, a
 * restart, a deploy landing mid-signup — left a REAL organization with a REAL
 * user who could sign in, in a workspace with NO POLICY and NO AUTONOMY LINE.
 *
 * That is the worst shape a partial failure can take, because it is invisible.
 * The person gets an account and signs in successfully. The missing pieces
 * surface later as behaviour nobody can explain, in a product whose entire
 * value is explaining behaviour.
 *
 * HOW THIS IS TESTED.
 *
 * Not by hoping a failure happens. Each statement is failed ON PURPOSE by a db
 * wrapper that throws on the Nth call, and after every forced failure the test
 * asserts that NOTHING survives — no organization, no user, no environment.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { ProductRepository, type ProductDb } from "../src/product/productRepository.js";
import { createPostgresStore } from "../src/store/postgresStore.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

const PASSWORD = "Nyst v032 atomic fixture 23!";

describe("Nyst v0.3.2 Phase 4 — signup is one transaction", { skip: databaseUrl ? false : "PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
  });
  after(async () => { await store.close(); await pool.end(); });

  function bootstrapInput(tag: string) {
    return {
      organization: `Atomic ${tag}`, organization_slug: `atomic-${tag}-${suffix}`,
      project: "Prod", project_slug: "prodproject",
      environment: "Shadow", environment_slug: "shadow", mode: "shadow" as const,
      email: `atomic-${tag}-${suffix}@test.test`, display_name: "Atomic", password: PASSWORD,
    };
  }

  /** Nothing at all was created for this slug. The assertion that matters. */
  async function assertNothingSurvives(tag: string) {
    const slug = `atomic-${tag}-${suffix}`;
    const email = `atomic-${tag}-${suffix}@test.test`;
    const organizations = (await pool.query(
      `SELECT organization_id FROM nyst_organizations WHERE slug=$1`, [slug])).rows;
    assert.equal(organizations.length, 0,
      `A PARTIAL WORKSPACE SURVIVED a forced failure at "${tag}" — an organization exists`);
    const users = (await pool.query(`SELECT user_id FROM nyst_users WHERE email=$1`, [email])).rows;
    assert.equal(users.length, 0,
      `A USER SURVIVED a forced failure at "${tag}" — they could sign in to a workspace that does not exist`);
  }

  /**
   * A pool that fails the Nth statement inside the transaction.
   *
   * It wraps the REAL pool and the REAL checked-out client, so everything up to
   * the failure genuinely happens in the real database. A mock that recorded
   * calls without executing them would prove nothing about rollback.
   */
  function poolFailingAt(target: number): ProductDb {
    let statement = 0;
    return {
      query: (sql: string, params?: readonly unknown[]) => pool.query(sql, params),
      async connect() {
        const client = await pool.connect();
        return {
          query: async (sql: string, params?: readonly unknown[]) => {
            // BEGIN/COMMIT/ROLLBACK are not counted: the interesting statements
            // are the inserts.
            if (!/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
              statement += 1;
              if (statement === target) {
                throw Object.assign(new Error(`forced failure at statement ${target}`), { code: "TEST" });
              }
            }
            return client.query(sql, params);
          },
          release: () => client.release(),
        };
      },
    } as unknown as ProductDb;
  }

  /* ================================================== THE HAPPY PATH */

  it("a successful signup creates the whole workspace", async () => {
    const created = await repository.createBootstrap(bootstrapInput("whole"));

    const rows = (await pool.query(
      `SELECT
         (SELECT count(*)::int FROM nyst_organizations WHERE organization_id=$1) organizations,
         (SELECT count(*)::int FROM nyst_projects      WHERE project_id=$2)      projects,
         (SELECT count(*)::int FROM nyst_environments  WHERE environment_id=$3)  environments,
         (SELECT count(*)::int FROM nyst_users         WHERE user_id=$4)         users,
         (SELECT count(*)::int FROM nyst_policy_versions WHERE environment_id=$3) policies,
         (SELECT count(*)::int FROM nyst_autonomy_rules  WHERE environment_id=$3) rules`,
      [created.organization_id, created.project_id, created.environment_id, created.user_id])).rows[0]!;

    for (const [what, count] of Object.entries(rows)) {
      assert.equal(Number(count), 1, `a complete signup produced ${count} ${what}`);
    }
  });

  it("the environment is in the requested mode, and the policy is conservative", async () => {
    const created = await repository.createBootstrap(bootstrapInput("posture"));
    const row = (await pool.query(
      `SELECT e.mode, p.execution_mode, p.retry_mode, p.auto_continuation
       FROM nyst_environments e JOIN nyst_policy_versions p USING(environment_id)
       WHERE e.environment_id=$1`, [created.environment_id])).rows[0]!;
    assert.equal(row.mode, "shadow");
    assert.equal(row.retry_mode, "never", "a new workspace permits automatic retry of consequential actions");
    assert.equal(row.auto_continuation, false, "a new workspace continues automatically past ambiguity");
  });

  /* =========================================== FAILURE AT EACH STATEMENT */

  it("THE DEFECT: a failure at the ORGANIZATION insert leaves nothing", async () => {
    const failing = new ProductRepository(poolFailingAt(1));
    await assert.rejects(failing.createBootstrap(bootstrapInput("org")), /forced failure/);
    await assertNothingSurvives("org");
  });

  it("a failure at the POLICY insert leaves nothing — not an org with no policy", async () => {
    // The dangerous one. Statement 1 created a real organization, project,
    // environment and user; before v0.3.2 they would all have stayed.
    const failing = new ProductRepository(poolFailingAt(2));
    await assert.rejects(failing.createBootstrap(bootstrapInput("policy")), /forced failure/);
    await assertNothingSurvives("policy");
  });

  it("a failure at the AUTONOMY LINE insert leaves nothing", async () => {
    const failing = new ProductRepository(poolFailingAt(3));
    await assert.rejects(failing.createBootstrap(bootstrapInput("autonomy")), /forced failure/);
    await assertNothingSurvives("autonomy");
  });

  it("no orphan policy or autonomy rule survives either", async () => {
    // The user-facing check above looks for the organization. This looks for
    // the rows that would be left DANGLING if the transaction leaked.
    //
    // Scoped to THIS signup's identifiers rather than counted globally: other
    // suites create workspaces concurrently, and a global count made this
    // assertion depend on what else happened to be running.
    const failing = new ProductRepository(poolFailingAt(3));
    await assert.rejects(failing.createBootstrap(bootstrapInput("orphan")), /forced failure/);

    const orphans = (await pool.query(
      `SELECT (SELECT count(*)::int FROM nyst_policy_versions p
                 JOIN nyst_organizations o USING(organization_id) WHERE o.slug=$1) policies,
              (SELECT count(*)::int FROM nyst_autonomy_rules a
                 JOIN nyst_organizations o USING(organization_id) WHERE o.slug=$1) rules`,
      [`atomic-orphan-${suffix}`])).rows[0]!;
    assert.equal(Number(orphans.policies), 0, "an orphan policy survived");
    assert.equal(Number(orphans.rules), 0, "an orphan autonomy rule survived");
  });

  /* ==================================================== REAL CONFLICTS */

  it("a duplicate short name fails cleanly, leaving the FIRST workspace intact", async () => {
    const first = await repository.createBootstrap(bootstrapInput("duplicate"));
    await assert.rejects(repository.createBootstrap(bootstrapInput("duplicate")), /duplicate|unique/i);

    // The original must be untouched — a failed second signup may not damage it.
    const row = (await pool.query(
      `SELECT (SELECT count(*)::int FROM nyst_policy_versions WHERE environment_id=$1) policies,
              (SELECT count(*)::int FROM nyst_autonomy_rules  WHERE environment_id=$1) rules`,
      [first.environment_id])).rows[0]!;
    assert.equal(Number(row.policies), 1);
    assert.equal(Number(row.rules), 1);
  });

  it("concurrent signups for the same short name produce exactly one workspace", async () => {
    const results = await Promise.allSettled(Array.from({ length: 5 }, () =>
      repository.createBootstrap(bootstrapInput("race"))));
    const created = results.filter((result) => result.status === "fulfilled").length;
    assert.equal(created, 1, `${created} concurrent signups claimed the same short name`);

    const organizations = (await pool.query(
      `SELECT count(*)::int count FROM nyst_organizations WHERE slug=$1`, [`atomic-race-${suffix}`])).rows[0]!;
    assert.equal(Number(organizations.count), 1);
  });

  /* ======================================================= STRUCTURAL */

  it("STRUCTURAL: a single-statement interface is REFUSED, not silently degraded", async () => {
    // Without a pool there is no transaction, and writing a half-workspace
    // anyway is precisely the behaviour being removed. It must refuse.
    const noPool = new ProductRepository({
      query: (sql: string, params?: readonly unknown[]) => pool.query(sql, params),
    });
    await assert.rejects(noPool.createBootstrap(bootstrapInput("nopool")),
      /transaction/i,
      "a workspace was created WITHOUT a transaction — a partial failure would leave someone signed in to nothing");
    await assertNothingSurvives("nopool");
  });
});
