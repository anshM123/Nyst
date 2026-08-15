-- Nyst v0.3.2 — Phases 10 and 11.
--
-- TWO THINGS THE PRODUCT CLAIMED AND DID NOT DO.

/* ==================================================================
 * PHASE 10 — COMMERCIAL ENTITLEMENT
 *
 * `commercialEntitlement.ts` is a complete, well-tested model: four states,
 * nine gated features, a `mayEnable` decision function. It is also a PURE
 * FUNCTION WITH NO PERSISTENCE AND NO CALLER -- the same shape of defect as the
 * Authority layer. Nothing stored an organization's plan, so nothing could
 * enforce it, so "Shadow Trial does not include Enforced" was true only of the
 * pricing page.
 *
 * A trial user could POST straight to the mode transition and get Enforced.
 * Hiding the button is not enforcement.
 *
 * THE LINE THIS MUST NOT CROSS.
 *
 * Entitlement gates a COMMERCIAL feature. It can never grant safety authority
 * and it can never substitute for one. A PROTECT plan permits a customer to
 * REQUEST Enforced; whether Enforced actually happens still depends on
 * EffectSpec readiness, integration capability, policy, the Autonomy Line,
 * Freeze, Blast Radius and Authority -- every one of which is evaluated
 * independently and none of which consults the plan.
 *
 * Money decides what you may ask for. It never decides what is safe.
 * ================================================================== */

CREATE TABLE nyst_organization_entitlements (
  organization_id uuid PRIMARY KEY REFERENCES nyst_organizations(organization_id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('trial','protect','scale','enterprise')),
  -- Design-partner overrides, applied by configuration rather than by code.
  -- A named list, never a boolean "unlocked" flag.
  feature_overrides text[] NOT NULL DEFAULT ARRAY[]::text[],
  -- Null for paid plans. A date for a trial.
  expires_at timestamptz,
  grandfathered boolean NOT NULL DEFAULT false,
  -- Who changed it and why. A plan change is a commercial act with an owner.
  updated_by uuid REFERENCES nyst_users(user_id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  CHECK (state <> 'trial' OR expires_at IS NOT NULL)
);

COMMENT ON TABLE nyst_organization_entitlements IS
  'What an organization has PAID for. Gates commercial features only. It never grants safety '
  'authority: Enforced still requires readiness, policy, Autonomy Line, Freeze and Blast Radius, '
  'none of which consult this table.';

-- Every organization that exists today started as a trial, which is what
-- public signup creates. Thirty days from now, so nothing expires on upgrade.
INSERT INTO nyst_organization_entitlements(organization_id, state, expires_at)
SELECT organization_id, 'trial', now() + interval '30 days'
FROM nyst_organizations
ON CONFLICT (organization_id) DO NOTHING;

-- A plan change is worth an audit trail of its own: it is the boundary between
-- what a customer may ask for and what they may not.
CREATE TABLE nyst_entitlement_audit (
  entitlement_audit_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES nyst_organizations(organization_id) ON DELETE CASCADE,
  previous_state text,
  new_state text NOT NULL,
  changed_by uuid REFERENCES nyst_users(user_id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 5 AND 1000),
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX nyst_entitlement_audit_organization
  ON nyst_entitlement_audit (organization_id, changed_at DESC);

/* ==================================================================
 * PHASE 11 — INTEGRATION DISCONNECT
 *
 * There was no way to stop Nyst using a provider connection. `configureIntegration`
 * was upsert-only; no DELETE, no `configured=false` path, no route.
 *
 * v0.3.1 documented that gap rather than half-building it, for a good reason:
 * removing the row would NOT stop in-flight work, because the integration is
 * consulted at ADMISSION only and the workers read the environment directly. A
 * control that looks like a kill switch and is not one is worse than none.
 *
 * So disconnect is built as what it honestly is: it stops NEW work, it
 * invalidates readiness, and it says plainly that it is not a kill switch for
 * work already admitted. Emergency Freeze remains the thing that stops that.
 *
 * HISTORY IS NEVER DELETED. Evidence, receipts, WorldFacts and audit rows all
 * survive -- they are the record of what was true, and disconnecting a provider
 * today does not make yesterday's observations untrue. What it does is make
 * them STALE, so an outcome depending on fresh evidence correctly becomes
 * INDETERMINATE rather than silently keeping its old verdict.
 * ================================================================== */

ALTER TABLE nyst_integrations
  ADD COLUMN IF NOT EXISTS disconnected_at timestamptz,
  ADD COLUMN IF NOT EXISTS disconnected_by uuid REFERENCES nyst_users(user_id),
  ADD COLUMN IF NOT EXISTS disconnect_reason text
    CHECK (disconnect_reason IS NULL OR length(disconnect_reason) BETWEEN 5 AND 1000);

-- Disconnected implies not configured. Reconnecting is a deliberate act that
-- clears all three columns, so the two can never disagree.
ALTER TABLE nyst_integrations
  ADD CONSTRAINT nyst_integrations_disconnect_consistent
  CHECK ((disconnected_at IS NULL) = (disconnected_by IS NULL));

CREATE INDEX nyst_integrations_live
  ON nyst_integrations (environment_id, provider) WHERE disconnected_at IS NULL;

COMMENT ON COLUMN nyst_integrations.disconnected_at IS
  'When the customer stopped Nyst using this connection. Blocks NEW provider work and invalidates '
  'readiness. It is NOT a kill switch for already-admitted actions -- Emergency Freeze is. '
  'Historical evidence, receipts and audit are retained: disconnecting today does not make '
  'yesterday''s observations untrue, only stale.';
