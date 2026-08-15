import type { ClockAttestor } from "../core/clock.js";
import type { Signer } from "../core/signing.js";
import { createFakeSpec } from "../fake/fakeSpec.js";
import { RuntimeFakeProvider } from "../fake/runtimeFakeProvider.js";
import { EMPTY_CONTEXT } from "../model/metadata.js";
import { GitHubRestClient } from "../providers/github/githubClient.js";
import { GitHubRepositoryPermissionProvider } from "../providers/github/githubProvider.js";
import { GitHubRepositoryPermissionService } from "../providers/github/githubService.js";
import { createGitHubRepositoryPermissionSpec } from "../providers/github/githubSpec.js";
import { EnvironmentGitHubCredentialSource, GITHUB_EFFECT_NAME, GITHUB_SPEC_VERSION, type GitHubCredentialSource, type GitHubTransport } from "../providers/github/types.js";
import { scopedCredentialSource } from "./scopedCredentials.js";
import type { SecretProvider } from "./secretProvider.js";
import { requireTestStripeKey } from "../providers/stripe/types.js";
import { OktaRestClient } from "../providers/okta/oktaClient.js";
import { OktaUserSuspensionProvider } from "../providers/okta/oktaProvider.js";
import { OktaUserSuspensionService } from "../providers/okta/oktaService.js";
import { createOktaUserSuspensionSpec } from "../providers/okta/oktaSpec.js";
import { EnvironmentOktaCredentialSource, OKTA_CREDENTIAL_REF, OKTA_EFFECT_NAME, OKTA_SPEC_VERSION, type OktaCredentialSource, type OktaTransport } from "../providers/okta/types.js";
import { StripeRestClient } from "../providers/stripe/stripeClient.js";
import { StripeEffectProvider } from "../providers/stripe/stripeProvider.js";
import { stripeCaptureService, stripeRefundService } from "../providers/stripe/stripeService.js";
import { createStripePaymentCaptureSpec, createStripeRefundSpec } from "../providers/stripe/stripeSpec.js";
import { EnvironmentStripeCredentialSource, STRIPE_CAPTURE_EFFECT, STRIPE_CAPTURE_SPEC_VERSION, STRIPE_CREDENTIAL_REF, STRIPE_REFUND_EFFECT, STRIPE_REFUND_SPEC_VERSION, type StripeCredentialSource, type StripeTransport } from "../providers/stripe/types.js";
import { NystRuntime } from "../runtime/nystRuntime.js";
import type { ProviderAdapter } from "../runtime/provider.js";
import { EffectRegistry } from "../runtime/registry.js";
import type { Store } from "../store/store.js";
import type { ProductCommitter, EffectSpecDescriptor } from "./types.js";
import type { ProductRepository } from "./productRepository.js";
import { OffboardingCoordinator } from "../offboarding/offboardingCoordinator.js";

export const REAL_PRODUCT_EFFECT_SPECS: readonly EffectSpecDescriptor[] = [
  { effect_name: GITHUB_EFFECT_NAME, spec_version: GITHUB_SPEC_VERSION, provider: "github", supported_topology: "Private organization repository, active member, existing direct standard role" },
  { effect_name: OKTA_EFFECT_NAME, spec_version: OKTA_SPEC_VERSION, provider: "okta", supported_topology: "Existing synthetic Okta-sourced non-admin user; ACTIVE/SUSPENDED only" },
  { effect_name: STRIPE_REFUND_EFFECT, spec_version: STRIPE_REFUND_SPEC_VERSION, provider: "stripe", supported_topology: "Sandbox-only exact full refund" },
  { effect_name: STRIPE_CAPTURE_EFFECT, spec_version: STRIPE_CAPTURE_SPEC_VERSION, provider: "stripe", supported_topology: "Sandbox-only final full manual card capture" },
] as const;

export interface ProductProviderFactoryOptions {
  production: boolean;
  enable_development_fake?: boolean;
  /**
   * Resolves a tenant's own credential reference (v0.3.2 Phase 2).
   *
   * Supplied, every provider call resolves whatever reference that
   * environment's IntegrationConnection recorded. Absent, the runtime falls
   * back to the single-tenant environment sources.
   */
  secrets?: SecretProvider;
  github_transport?: GitHubTransport;
  okta_transport?: OktaTransport;
  stripe_transport?: StripeTransport;
  github_credentials?: GitHubCredentialSource;
  okta_credentials?: OktaCredentialSource;
  stripe_credentials?: StripeCredentialSource;
}

export function createProductProviderRuntime(
  store: Store,
  repository: ProductRepository,
  signer: Signer,
  clock: ClockAttestor,
  options: ProductProviderFactoryOptions
): { runtime: NystRuntime; descriptors: readonly EffectSpecDescriptor[]; commit: ProductCommitter; offboarding: OffboardingCoordinator; preflight: ProductIntegrationPreflight } {
  if (options.production && options.enable_development_fake) {
    throw new Error("The deterministic fake provider cannot be enabled in production");
  }
  const registry = new EffectRegistry();
  const githubSpec = createGitHubRepositoryPermissionSpec();
  const oktaSpec = createOktaUserSuspensionSpec();
  const refundSpec = createStripeRefundSpec();
  const captureSpec = createStripePaymentCaptureSpec();
  for (const spec of [githubSpec, oktaSpec, refundSpec, captureSpec]) registry.register(spec);

  /**
   * CREDENTIAL SOURCES ARE NOW TENANT-AGNOSTIC AND STATELESS (v0.3.2 Phase 2).
   *
   * Each Environment*CredentialSource resolved exactly one hardcoded variable
   * and refused every other reference, which meant every customer on the
   * deployment shared one provider credential.
   *
   * `scopedCredentialSource` resolves whatever reference the tenant's own
   * IntegrationConnection recorded, through the SecretProvider. It holds no
   * state and caches nothing, so no instance can carry one tenant's secret into
   * another tenant's request -- and a rotated or revoked credential stops
   * working immediately rather than at the end of some cache TTL.
   *
   * The Environment* sources remain the fallback for a deployment that supplies
   * no SecretProvider, which is the single-tenant local case.
   */
  const scoped = (provider: string, validate?: (value: string) => void) =>
    options.secrets ? scopedCredentialSource(options.secrets, provider, validate) : undefined;

  const githubClient = new GitHubRestClient(options.github_credentials ?? scoped("github") ?? new EnvironmentGitHubCredentialSource(), { clock, ...(options.github_transport ? { transport: options.github_transport } : {}) });
  const oktaClient = new OktaRestClient(options.okta_credentials ?? scoped("okta") ?? new EnvironmentOktaCredentialSource(), { clock, ...(options.okta_transport ? { transport: options.okta_transport } : {}) });
  const stripeClient = new StripeRestClient(options.stripe_credentials ?? scoped("stripe", requireTestStripeKey) ?? new EnvironmentStripeCredentialSource(), { clock, ...(options.stripe_transport ? { transport: options.stripe_transport } : {}) });
  const providers: ProviderAdapter[] = [
    new GitHubRepositoryPermissionProvider(githubClient, clock),
    new OktaUserSuspensionProvider(oktaClient, clock),
    new StripeEffectProvider(STRIPE_REFUND_EFFECT, stripeClient, clock),
    new StripeEffectProvider(STRIPE_CAPTURE_EFFECT, stripeClient, clock),
  ];
  const descriptors: EffectSpecDescriptor[] = [...REAL_PRODUCT_EFFECT_SPECS];
  let fakeEffectName: string | null = null;
  if (options.enable_development_fake) {
    const fake = createFakeSpec();
    fakeEffectName = fake.effect_name;
    registry.register(fake);
    providers.push(new RuntimeFakeProvider(clock));
    descriptors.unshift({ effect_name: fake.effect_name, spec_version: fake.schema_version, provider: "fake", supported_topology: "Deterministic development/onboarding only" });
  }
  const runtime = new NystRuntime(store, registry, providers, signer, clock, {
    dispatch_eligibility: (action) => repository.assertActionScoped(action.action_id),
  });
  const github = new GitHubRepositoryPermissionService(runtime, githubClient, clock);
  const okta = new OktaUserSuspensionService(runtime, oktaClient, clock);
  const refund = stripeRefundService(runtime, stripeClient, clock);
  const capture = stripeCaptureService(runtime, stripeClient, clock);

  const commit: ProductCommitter = async (request, principal) => {
    const establish = { establish_dispatch_eligibility: async (action: { action_id: string }) => {
      await repository.scopeAction(principal, action.action_id, request.displayBusinessKey, request.agent_id);
      await repository.bindActionControl(principal, action.action_id, request.policy_version_id, request.environment_mode);
    } };
    switch (request.effect) {
      case GITHUB_EFFECT_NAME:
        return github.commit(request.businessKey, request.input, EMPTY_CONTEXT, establish);
      case OKTA_EFFECT_NAME:
        return okta.commit(request.businessKey, request.input, EMPTY_CONTEXT, establish);
      case STRIPE_REFUND_EFFECT:
        return refund.commit(request.businessKey, request.input, EMPTY_CONTEXT, establish);
      case STRIPE_CAPTURE_EFFECT:
        return capture.commit(request.businessKey, request.input, EMPTY_CONTEXT, establish);
      default:
        if (options.enable_development_fake && request.effect === fakeEffectName) {
          return runtime.commit(request.effect, request.businessKey, request.input, EMPTY_CONTEXT, establish);
        }
        throw Object.assign(new Error("No provider runtime is registered for this EffectSpec"), { statusCode: 503 });
    }
  };
  /**
   * THE CONNECTION PREFLIGHT (rewritten in v0.3.3).
   *
   * WHAT WAS WRONG, AND IT MADE THE WHOLE FEATURE UNREACHABLE.
   *
   * This probe hardcoded `ref = "env:NYST_GITHUB_TOKEN"` and IGNORED the
   * credential it was handed. So a customer's own token could be stored,
   * encrypted and resolved correctly — and the one thing that verifies a
   * credential went looking for the OPERATOR's environment variable instead.
   * `Configured: YES`, `Credential available: YES`, `Preflight verified: NO`,
   * forever, with nothing the customer could do about it.
   *
   * That is the v0.3.2 Phase 2 multi-tenancy defect surviving in the verifier,
   * which is the third place this same shape has turned up.
   *
   * It was also the wrong QUESTION. It demanded three operator fixture
   * variables and then required a PRIVATE repository in which a NAMED
   * principal was a DIRECT collaborator, throwing "GitHub fixture topology is
   * unsupported" otherwise. That is an acceptance test for one deployment, not
   * a connection check any customer could pass.
   *
   * WHAT IT ASKS NOW: does this credential authenticate, who does it belong to,
   * and what does the provider say it may do. Nothing else. Those are the
   * questions "is this connection working" actually means, and none of them
   * needs configuration beyond the credential itself.
   *
   * `secret` is the value `runIntegrationPreflight` resolved from THIS
   * TENANT's own credential reference. Every call below goes through a
   * throwaway client bound to that one value, so a preflight cannot reach any
   * other tenant's credential and cannot silently fall back to the operator's.
   */
  const preflight:ProductIntegrationPreflight=async(provider,secret)=>{
    // A credential source over one literal value. The reference passed to the
    // client is a label; nothing resolves it, because the value is already in
    // hand and belongs to exactly one tenant.
    const only=(value:string)=>({ async resolve(){ return value; } });
    const ref="tenant:preflight";

    if(provider==="github"){
      const client=new GitHubRestClient(only(secret),{clock,...(options.github_transport?{transport:options.github_transport}:{})});
      const user=await client.getAuthenticatedUser(ref);
      if(user.status===401||user.status===403){
        throw new Error(`GitHub rejected this credential (${user.status}). Check that the token is valid and not expired.`);
      }
      if(user.status!==200||!user.data)throw new Error(`GitHub read-only preflight failed (HTTP ${user.status})`);

      /**
       * VERIFIED versus AUTHORIZED, and the line is not decorative.
       *
       * `github:user:read` was PROVED — this request read something and it
       * worked. Everything derived from the scope header was merely STATED by
       * GitHub, and a write capability can never be proved by a read-only
       * probe without performing the write invariant I20 forbids.
       *
       * Fine-grained tokens send no scope header at all, and absence means
       * "not stated", never "not granted".
       */
      /**
       * PROVE THE READS THE ENABLED EFFECTSPEC ACTUALLY REQUIRES.
       *
       * The first version of this rewrite probed only `GET /user`, which fixed
       * the fixture problem and introduced a smaller one: it proved a single
       * capability nothing requires, so `github:repository:read` and
       * `github:organization:read` sat at AVAILABLE — "the provider supports
       * this, but nothing has observed that this credential holds it" — and
       * readiness stayed Not ready with three capabilities missing.
       *
       * These two endpoints are scoped to the CREDENTIAL rather than to a named
       * resource, so they need no configuration and performing them IS the
       * proof. A 200 with an empty list is still a successful read: the
       * capability is proved by the status, never by the row count, because an
       * account with no repositories has not failed anything.
       *
       * A non-200 is NOT treated as failure of the whole preflight. The
       * credential authenticates — that was established above — and this
       * particular permission simply was not granted, which is a capability
       * fact and not a connection fault. Conflating them would tell a customer
       * their token is broken when it is merely narrow.
       */
      const [repos,orgs]=await Promise.all([
        client.listAccessibleRepositories(ref).catch(()=>({status:0,data:null,headers:undefined})),
        client.listAccessibleOrganizations(ref).catch(()=>({status:0,data:null,headers:undefined})),
      ]);
      const verified=["github:user:read"];
      if(repos.status===200)verified.push("github:repository:read");
      if(orgs.status===200)verified.push("github:organization:read");

      /**
       * VERIFIED versus AUTHORIZED, and the line is not decorative.
       *
       * Everything in `verified` was PROVED by performing a read. Everything
       * below was merely STATED by GitHub in its scope header, and a WRITE
       * capability can never be proved by a read-only probe without performing
       * the mutation invariant I20 forbids — so `github:collaborator:write`
       * appears here at most, never in `verified`.
       *
       * Fine-grained tokens send no scope header at all, and absence means
       * "not stated", never "not granted".
       */
      const stated=(user.headers?.oauth_scopes??"").split(",").map(s=>s.trim()).filter(Boolean);
      const authorized:string[]=[];
      if(stated.includes("repo"))authorized.push("github:collaborator:write");
      if(stated.includes("repo")||stated.includes("public_repo"))authorized.push("github:repository:read");
      if(stated.includes("read:org")||stated.includes("admin:org"))authorized.push("github:organization:read");
      return {
        status:"ready",provider,provider_mutation_performed:false,
        verified_capabilities:verified,
        authorized_capabilities:authorized,
        scopes_stated_by_provider:stated,
        // Fine-grained tokens publish no scope list. Say that, rather than
        // letting an empty array read as "this token can do nothing".
        scope_metadata_available:stated.length>0,
        principal:{login:user.data.login,id:user.data.id},
      };
    }

    if(provider==="okta"){
      /**
       * Okta needs one piece of NON-SECRET configuration Nyst cannot guess:
       * the customer's own org URL. It is not a credential, so it does not
       * belong in the credential store, and until there is a field for it the
       * environment variable stays — but the failure now NAMES it instead of
       * throwing an opaque fixture error.
       */
      const origin=process.env.NYST_OKTA_ORG_URL??process.env.OKTA_ORG_URL;
      if(!origin||/[\r\n\0]/.test(origin)){
        throw Object.assign(new Error(
          "Okta needs your organization URL (for example https://example.okta.com) before its credential can be "
          + "checked. Set NYST_OKTA_ORG_URL. It is configuration, not a secret."),{statusCode:503});
      }
      const client=new OktaRestClient(only(secret),{clock,...(options.okta_transport?{transport:options.okta_transport}:{})});
      // `/api/v1/users/me` needs no fixture user: it describes the credential.
      const user=await client.getUser(origin,"me",ref);
      if(user.status===401||user.status===403){
        throw new Error(`Okta rejected this credential (${user.status}). Check that the API token is valid and not expired.`);
      }
      if(user.status!==200||!user.data)throw new Error(`Okta read-only preflight failed (HTTP ${user.status})`);
      // okta:user:lifecycle is a WRITE capability and cannot be proved by a
      // read-only preflight. See the GitHub note above.
      return {status:"ready",provider,provider_mutation_performed:false,
        verified_capabilities:["okta:user:read"],tenant:new URL(origin).hostname,
        user:{id:user.data.id,login:user.data.login,status:user.data.status}};
    }

    const client=new StripeRestClient(only(secret),{clock,...(options.stripe_transport?{transport:options.stripe_transport}:{})});
    const account=await client.getAccount(ref);
    if(account.status===401||account.status===403){
      throw new Error(`Stripe rejected this credential (${account.status}). Check that the key is valid and not revoked.`);
    }
    if(account.status!==200||!account.data)throw new Error(`Stripe read-only preflight failed (HTTP ${account.status})`);
    // Reading the account proves the key authenticates. It proves nothing
    // about charge/refund/capture permissions: Stripe restricted keys publish
    // no scope list, so those capabilities stay AVAILABLE until an operator
    // attests to them. This boundary is named in docs/product/known-boundaries.md.
    return {status:"ready",provider,provider_mutation_performed:false,verified_capabilities:[],account:{id:account.data.id},mode:"test_or_restricted_test_credential"};
  };
  return { runtime, descriptors, commit, offboarding:new OffboardingCoordinator(store,runtime,okta,github,clock), preflight };
}


/**
 * `secret` is THIS TENANT's resolved credential (v0.3.3).
 *
 * It used to be absent from the signature, so the probe had nowhere to get a
 * credential from except a hardcoded operator environment variable — which is
 * exactly what it did, and why no customer-supplied credential could ever be
 * verified. Taking it as a required argument means a probe that forgets to use
 * it does not compile.
 */
export type ProductIntegrationPreflight = (provider: "github" | "okta" | "stripe", secret: string) => Promise<Record<string, unknown>>;
