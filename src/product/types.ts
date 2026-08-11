export interface TenantScope {
  organization_id: string;
  project_id: string;
  environment_id: string;
}

export interface ProductPrincipal extends TenantScope {
  kind: "session" | "api_key";
  user_id: string | null;
  api_key_id: string | null;
  scopes: readonly string[];
  csrf_hash: string | null;
}

export interface ActionFilters {
  provider?: string;
  effect?: string;
  state?: string;
  decision?: string;
  since?: string;
  limit?: number;
}

export interface ProductCommitRequest {
  effect: string;
  businessKey: string;
  displayBusinessKey: string;
  input: unknown;
  credential_ref: string | null;
  policy_version_id: string;
  environment_mode: "enforced";
}

export interface ProductCommitResult {
  action: { action_id: string };
  resolution: unknown;
}

export type ProductCommitter = (
  request: ProductCommitRequest,
  principal: ProductPrincipal
) => Promise<ProductCommitResult>;

export interface EffectSpecDescriptor {
  effect_name: string;
  spec_version: string;
  provider: string;
  supported_topology: string;
}

export interface ProductProjectContext {
  project_id: string;
  project_name: string;
  project_slug: string;
  environments: Array<{ environment_id: string; environment_name: string; environment_slug: string; mode: "shadow" | "enforced"; is_demo: boolean }>;
}

export interface ProductContext {
  organization_id: string;
  selected_project_id: string;
  selected_environment_id: string;
  projects: ProductProjectContext[];
}
