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

  const githubClient = new GitHubRestClient(options.github_credentials ?? new EnvironmentGitHubCredentialSource(), { clock, ...(options.github_transport ? { transport: options.github_transport } : {}) });
  const oktaClient = new OktaRestClient(options.okta_credentials ?? new EnvironmentOktaCredentialSource(), { clock, ...(options.okta_transport ? { transport: options.okta_transport } : {}) });
  const stripeClient = new StripeRestClient(options.stripe_credentials ?? new EnvironmentStripeCredentialSource(), { clock, ...(options.stripe_transport ? { transport: options.stripe_transport } : {}) });
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
  const preflight:ProductIntegrationPreflight=async provider=>{
    if(provider==="github"){
      const owner=requiredFixture("NYST_GITHUB_OWNER"),repository=requiredFixture("NYST_GITHUB_REPOSITORY"),principal=requiredFixture("NYST_GITHUB_PRINCIPAL"),ref="env:NYST_GITHUB_TOKEN";
      const organization=await githubClient.getOrganization(owner,ref),repo=await githubClient.getRepository(owner,repository,ref),user=await githubClient.getUser(principal,ref),member=await githubClient.checkOrganizationMember(owner,principal,ref),collaborators=await githubClient.listDirectCollaborators(owner,repository,ref),permission=await githubClient.getPermission(owner,repository,principal,ref);
      if(organization.status!==200||repo.status!==200||user.status!==200||member.status!==204||collaborators.status!==200||permission.status!==200||!organization.data||!repo.data||!user.data||member.data!==true||!collaborators.data||!permission.data)throw new Error("GitHub read-only preflight failed");
      const direct=collaborators.data.find(item=>item.id===user.data!.id);if(!repo.data.private||!direct)throw new Error("GitHub fixture topology is unsupported");
      // Capabilities this read-only preflight ACTUALLY proved by performing
      // the read. github:collaborator:write is deliberately absent: proving it
      // would require a mutation, which invariant I20 forbids. It becomes
      // AUTHORIZED only from GitHub's own scope metadata, or from an explicit
      // operator attestation labelled as a claim.
      return {status:"ready",provider,provider_mutation_performed:false,verified_capabilities:["github:organization:read","github:repository:read"],repository:{owner:repo.data.owner,name:repo.data.name,id:repo.data.id,private:repo.data.private},principal:{login:user.data.login,id:user.data.id,organization_member:true,direct_collaborator:true,role_name:direct.role_name,effective_permission:permission.data.permission}};
    }
    if(provider==="okta"){
      const origin=requiredFixtureAny(["NYST_OKTA_ORG_URL","OKTA_ORG_URL"]),userId=requiredFixtureAny(["NYST_OKTA_TEST_USER_ID","OKTA_TEST_USER_ID"]);const user=await oktaClient.getUser(origin,userId,OKTA_CREDENTIAL_REF),roles=await oktaClient.listUserRoles(origin,userId,OKTA_CREDENTIAL_REF);
      if(user.status!==200||roles.status!==200||!user.data||!roles.data||user.data.id!==userId)throw new Error("Okta read-only preflight failed");
      // okta:user:lifecycle is a write capability and cannot be proved by a
      // read-only preflight. See the GitHub note above.
      return {status:"ready",provider,provider_mutation_performed:false,verified_capabilities:["okta:user:read"],tenant:new URL(origin).hostname,user:{id:user.data.id,login:user.data.login,status:user.data.status,source_type:user.data.source_type,admin_role_count:roles.data.length}};
    }
    const account=await stripeClient.getAccount(STRIPE_CREDENTIAL_REF);if(account.status!==200||!account.data)throw new Error("Stripe read-only preflight failed");
    // Reading the account proves the key authenticates. It proves nothing
    // about charge/refund/capture permissions: Stripe restricted keys publish
    // no scope list, so those capabilities stay AVAILABLE until an operator
    // attests to them. This boundary is named in docs/product/known-boundaries.md.
    return {status:"ready",provider,provider_mutation_performed:false,verified_capabilities:[],account:{id:account.data.id},mode:"test_or_restricted_test_credential"};
  };
  return { runtime, descriptors, commit, offboarding:new OffboardingCoordinator(store,runtime,okta,github,clock), preflight };
}

function requiredFixture(name:string):string{const value=process.env[name];if(!value||/[\r\n\0]/.test(value))throw new Error(`Required non-secret fixture configuration is unavailable: ${name}`);return value;}
function requiredFixtureAny(names:readonly string[]):string{for(const name of names){const value=process.env[name];if(value&&!/[\r\n\0]/.test(value))return value}throw new Error(`Required non-secret fixture configuration is unavailable: ${names.join(" or ")}`);}

export type ProductIntegrationPreflight = (provider: "github" | "okta" | "stripe") => Promise<Record<string, unknown>>;
