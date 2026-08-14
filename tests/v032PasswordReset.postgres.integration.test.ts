/**
 * Nyst v0.3.2 — Phase 8. PASSWORD RESET.
 *
 * v0.3.1 had none. A local account whose owner forgot the password was simply
 * gone — not a state you can leave a paying customer in, and the reason I told
 * you not to put v0.3.1 in front of one.
 *
 * The two properties that carry this feature:
 *
 * IT MUST NOT BE AN ACCOUNT ORACLE. `/forgot-password` answers identically for
 * a real address and an invented one. Otherwise the form enumerates customers,
 * which is step one of every credential-stuffing campaign.
 *
 * RESETTING MUST END EVERY SESSION. People reset a password precisely because
 * they think someone else has it. Leaving that person's cookie alive hands them
 * the account while the owner believes they have recovered it. That is enforced
 * by a database trigger rather than by remembering to call something.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { ProductRepository, digest, type ProductDb } from "../src/product/productRepository.js";
import { PasswordResetService, passwordProblem } from "../src/product/auth/passwordReset.js";
import { RecordingEmailProvider, isDeliverableAddress, assertNoSensitiveContent } from "../src/product/email.js";
import { createPostgresStore } from "../src/store/postgresStore.js";
import type { TenantScope } from "../src/product/types.js";

const databaseUrl = process.env.DATABASE_URL;
type Pool = ProductDb & { connect(): Promise<ProductDb & { release(): void }>; end(): Promise<void> };

const PASSWORD = "Nyst v032 reset fixture 23!";
const REPLACEMENT = "an entirely different passphrase 91";

describe("Nyst v0.3.2 Phase 8 — password reset", { skip: databaseUrl ? false : "PostgreSQL is required" }, () => {
  let pool: Pool;
  let store: Awaited<ReturnType<typeof createPostgresStore>>;
  let repository: ProductRepository;
  let email: RecordingEmailProvider;
  let resets: PasswordResetService;
  let tenant: TenantScope & { user_id: string };
  let address: string;
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    const pg = await import("pg") as unknown as { default: { Pool: new (o: { connectionString: string }) => Pool } };
    pool = new pg.default.Pool({ connectionString: databaseUrl! });
    store = await createPostgresStore(databaseUrl!);
    repository = new ProductRepository(pool);
    email = new RecordingEmailProvider();
    resets = new PasswordResetService(pool, email, "https://nyst.example.com");
    address = `reset-${suffix}@acme.test`;
    tenant = await repository.createBootstrap({
      organization: "Reset Co", organization_slug: `reset-${suffix}`,
      project: "Prod", project_slug: "prodproject",
      environment: "Shadow", environment_slug: "shadow", mode: "shadow",
      email: address, display_name: "Reset", password: PASSWORD,
    });
  });
  after(async () => { await store.close(); await pool.end(); });

  /**
   * A fresh account.
   *
   * Needed because the per-account request limit is REAL: reusing one address
   * across a dozen tests exhausts its hourly budget, `requestReset` then
   * silently issues nothing -- which is exactly the designed behaviour -- and
   * `tokenFor` quietly hands back the PREVIOUS, already-consumed token. That
   * broke four of these tests until each got its own account.
   */
  let accountIndex = 0;
  async function freshAccount(): Promise<{ scope: TenantScope & { user_id: string }; email: string; slug: string }> {
    accountIndex += 1;
    const slug = `reset-${suffix}-${accountIndex}`;
    const created = `reset-${suffix}-${accountIndex}@acme.test`;
    const scope = await repository.createBootstrap({
      organization: `Reset ${accountIndex}`, organization_slug: slug,
      project: "Prod", project_slug: "prodproject",
      environment: "Shadow", environment_slug: "shadow", mode: "shadow",
      email: created, display_name: "Reset", password: PASSWORD,
    });
    return { scope, email: created, slug };
  }

  /** Pull the token out of the most recent email to an address. */
  function tokenFor(to: string): string {
    const message = email.lastTo(to);
    assert.ok(message, `no reset email was sent to ${to}`);
    const link = /https:\/\/nyst\.example\.com\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(message.text);
    assert.ok(link, `the email to ${to} contains no reset link:\n${message.text}`);
    return link[1]!;
  }

  /* ================================================== THE HAPPY PATH */

  it("a reset link works exactly once and actually changes the password", async () => {
    await resets.requestReset({ email: address });
    const token = tokenFor(address);

    assert.equal((await resets.inspect(token)).valid, true);
    assert.deepEqual(await resets.completeReset(token, REPLACEMENT), { ok: true });

    // The old password no longer authenticates; the new one does.
    assert.equal(await repository.login(`reset-${suffix}`, address, PASSWORD), null,
      "THE OLD PASSWORD STILL WORKS AFTER A RESET");
    assert.ok(await repository.login(`reset-${suffix}`, address, REPLACEMENT),
      "the new password does not work");

    // And the link is spent.
    assert.equal((await resets.inspect(token)).valid, false);
    assert.equal((await resets.completeReset(token, "yet another passphrase 77")).ok, false,
      "A RESET LINK WAS REUSABLE");
  });

  /* ============================================= THE ENUMERATION ORACLE */

  it("an unknown address is INDISTINGUISHABLE from a known one", async () => {
    const known = await resets.requestReset({ email: address });
    const unknown = await resets.requestReset({ email: `nobody-${suffix}@nowhere.test` });
    assert.deepEqual(unknown, known,
      "THE FORGOT-PASSWORD RESPONSE REVEALS WHETHER AN ACCOUNT EXISTS — it is an enumeration oracle");

    // And nothing was sent to the address that does not exist.
    assert.equal(email.lastTo(`nobody-${suffix}@nowhere.test`), undefined);
  });

  it("a malformed address is refused the same way, not with a validation error", async () => {
    for (const bad of ["x", "a@b", "someone@localhost", "", "  ", "no-at-sign.test"]) {
      const outcome = await resets.requestReset({ email: bad });
      assert.equal(outcome.accepted, true, `"${bad}" produced a distinguishable response`);
    }
  });

  it("a federated-only account cannot be reset into existence", async () => {
    // Somebody who signed up with Google has no password. A reset must not
    // create one, or Google sign-in becomes bypassable by anyone who controls
    // the mailbox.
    const federated = `federated-${suffix}@acme.test`;
    await pool.query(
      `INSERT INTO nyst_users(user_id,organization_id,email,display_name,password_hash)
       VALUES(gen_random_uuid(),$1,$2,'Federated',NULL)`,
      [tenant.organization_id, federated]).catch(() => null);

    await resets.requestReset({ email: federated });
    assert.equal(email.lastTo(federated), undefined,
      "a reset email was sent to an account that has no password");
  });

  /* ============================================ SESSIONS DIE ON RESET */

  it("THE PROPERTY THAT MATTERS: resetting ends every existing session", async () => {
    // The attacker's session, and the owner's, both live at reset time.
    const account = await freshAccount();
    await pool.query(
      `INSERT INTO nyst_sessions(session_hash,csrf_hash,user_id,organization_id,selected_project_id,selected_environment_id,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,now()+interval '12 hours')`,
      [digest(`attacker-${suffix}`), digest(`csrf-${suffix}`), account.scope.user_id,
        account.scope.organization_id, account.scope.project_id, account.scope.environment_id]);

    await resets.requestReset({ email: account.email });
    await resets.completeReset(tokenFor(account.email), `session killing passphrase ${suffix}`);

    const remaining = (await pool.query(
      `SELECT count(*)::int count FROM nyst_sessions WHERE user_id=$1`, [account.scope.user_id])).rows[0]!;
    assert.equal(Number(remaining.count), 0,
      "A SESSION SURVIVED A PASSWORD RESET — whoever the owner was resetting against still holds the account");
  });

  it("a password change through ANY path revokes sessions, not just this one", async () => {
    // Enforced by trigger, so a future code path that changes a password cannot
    // forget to do it.
    const account = await freshAccount();
    await pool.query(
      `INSERT INTO nyst_sessions(session_hash,csrf_hash,user_id,organization_id,selected_project_id,selected_environment_id,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,now()+interval '12 hours')`,
      [digest(`direct-${suffix}`), digest(`directcsrf-${suffix}`), account.scope.user_id,
        account.scope.organization_id, account.scope.project_id, account.scope.environment_id]);

    await pool.query(
      `UPDATE nyst_users SET password_hash='$2b$12$directchangedirectchangedirectchangedirectchangeXX' WHERE user_id=$1`,
      [account.scope.user_id]);

    const remaining = (await pool.query(
      `SELECT count(*)::int count FROM nyst_sessions WHERE user_id=$1`, [account.scope.user_id])).rows[0]!;
    assert.equal(Number(remaining.count), 0, "a direct password change left sessions alive");
  });

  /* ==================================================== TOKEN HYGIENE */

  it("the token is never stored — only its digest", async () => {
    const account = await freshAccount();
    await resets.requestReset({ email: account.email });
    const token = tokenFor(account.email);

    const rows = (await pool.query(
      `SELECT token_hash FROM nyst_password_resets WHERE user_id=$1`, [account.scope.user_id])).rows;
    for (const row of rows) {
      assert.notEqual(row.token_hash, token, "THE RAW RESET TOKEN IS IN THE DATABASE");
      assert.match(String(row.token_hash), /^[0-9a-f]{64}$/);
    }
    assert.ok(rows.some((row) => row.token_hash === digest(token)), "the digest was not stored");
  });

  it("requesting again invalidates the previous link", async () => {
    const account = await freshAccount();
    await resets.requestReset({ email: account.email });
    const first = tokenFor(account.email);
    await resets.requestReset({ email: account.email });
    const second = tokenFor(account.email);
    assert.notEqual(first, second);

    assert.equal((await resets.inspect(first)).valid, false,
      "clicking resend left TWO working reset links");
    assert.equal((await resets.inspect(second)).valid, true);
  });

  it("an expired link is refused, with the same message as a wrong one", async () => {
    const account = await freshAccount();
    await resets.requestReset({ email: account.email });
    const token = tokenFor(account.email);
    // BOTH timestamps move. The CHECK requires expires_at > requested_at, so
    // backdating only the expiry would be an impossible row rather than an
    // expired one -- which is the constraint doing its job.
    await pool.query(
      `UPDATE nyst_password_resets
         SET requested_at=now()-interval '2 hours', expires_at=now()-interval '1 minute'
       WHERE token_hash=$1`,
      [digest(token)]);

    const expired = await resets.completeReset(token, "a perfectly fine passphrase 42");
    const forged = await resets.completeReset("A".repeat(43), "a perfectly fine passphrase 42");
    assert.equal(expired.ok, false);
    assert.equal(forged.ok, false);
    assert.equal((expired as { reason: string }).reason, (forged as { reason: string }).reason,
      "an expired link is distinguishable from a forged one");
  });

  it("inspecting a link does NOT consume it", async () => {
    // Mail clients prefetch links. If GET consumed the token, the user's reset
    // would be burned before they ever saw the page.
    const account = await freshAccount();
    await resets.requestReset({ email: account.email });
    const token = tokenFor(account.email);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal((await resets.inspect(token)).valid, true, "inspecting the link consumed it");
    }
    assert.equal((await resets.completeReset(token, "still usable passphrase 55")).ok, true);
  });

  it("CONCURRENCY: two submissions of one link change the password once", async () => {
    const account = await freshAccount();
    await resets.requestReset({ email: account.email });
    const token = tokenFor(account.email);

    const results = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      resets.completeReset(token, `concurrent passphrase ${index} ${suffix}`)));
    const succeeded = results.filter((result) => result.ok).length;
    assert.equal(succeeded, 1, `${succeeded} concurrent submissions of one link succeeded`);
  });

  it("a flood of requests for one account is bounded", async () => {
    const flood = `flooded-${suffix}@acme.test`;
    await repository.createBootstrap({
      organization: "Flood Co", organization_slug: `flood-${suffix}`,
      project: "Prod", project_slug: "prodproject",
      environment: "Shadow", environment_slug: "shadow", mode: "shadow",
      email: flood, display_name: "Flood", password: PASSWORD,
    });
    for (let attempt = 0; attempt < 12; attempt += 1) await resets.requestReset({ email: flood });

    const sent = email.sent.filter((message) => message.to === flood).length;
    assert.ok(sent <= 5, `${sent} reset emails were sent for one account in one window`);
  });

  /* ================================================== PASSWORD RULES */

  it("password rules are about length, not decoration", () => {
    assert.ok(passwordProblem("short"));
    assert.ok(passwordProblem("           "));
    assert.equal(passwordProblem("a perfectly ordinary passphrase"), null,
      "a long passphrase with no symbols was refused — composition rules push people to Password1!");
    assert.ok(passwordProblem(" leading space is trouble "));
  });

  it("a weak password is refused BEFORE the token is consumed", async () => {
    const account = await freshAccount();
    await resets.requestReset({ email: account.email });
    const token = tokenFor(account.email);
    assert.equal((await resets.completeReset(token, "short")).ok, false);
    // The link still works, so a typo does not force a second email.
    assert.equal((await resets.inspect(token)).valid, true,
      "a rejected password burned the reset link");
  });

  /* ====================================================== THE EMAIL */

  it("the email contains the link and NOTHING sensitive", async () => {
    const account = await freshAccount();
    await resets.requestReset({ email: account.email });
    const message = email.lastTo(account.email)!;
    assert.doesNotThrow(() => assertNoSensitiveContent(message));
    assert.match(message.text, /expires in \d+ minutes/);
    assert.match(message.text, /sign out every device/i,
      "the email does not warn that resetting ends other sessions");
    // No password, no session, no internal identifier.
    assert.doesNotMatch(message.text, new RegExp(PASSWORD.slice(0, 10)));
    assert.doesNotMatch(message.text, new RegExp(account.scope.user_id));
    assert.doesNotMatch(message.text, new RegExp(account.scope.organization_id));
  });

  it("outbound mail refuses to carry a credential, whatever the caller does", () => {
    for (const text of [
      "your token is env:NYST_GITHUB_TOKEN",
      "Authorization: Bearer abcdefghijklmnop",
      `-----${"BEGIN"} PRIVATE KEY-----`,  // assembled: the release scan flags the intact literal, correctly
      "postgres://nyst:hunter2@db.internal:5432/nyst",
    ]) {
      assert.throws(() => assertNoSensitiveContent({ to: address, subject: "x", text }),
        /Refusing to send/, `an email carrying "${text.slice(0, 24)}" was allowed`);
    }
  });

  it("a deployment with no mail transport says so rather than pretending", async () => {
    const account = await freshAccount();
    const mute = new PasswordResetService(pool, null, "https://nyst.example.com");
    const outcome = await mute.requestReset({ email: account.email });
    assert.equal(outcome.delivery_unavailable, true,
      "an unconfigured deployment reported a reset email as sent");
  });

  /* ===================================================== ADDRESSES */

  it("address validation refuses what a contact form actually receives", () => {
    for (const good of ["a@nyst.ai", "first.last+tag@sub.example.co.uk", "x_y@example.com"]) {
      assert.equal(isDeliverableAddress(good), true, `${good} was refused`);
    }
    for (const bad of [
      "x", "a@b", "someone@localhost", "no-at.test", "two@@example.com",
      "trailing.@example.com", "a b@example.com", "a@example.com\r\nBcc: victim@example.com",
      "<script>@example.com", "a..b@example.com", "",
    ]) {
      assert.equal(isDeliverableAddress(bad), false, `"${bad}" WAS ACCEPTED as a work email`);
    }
  });
});
