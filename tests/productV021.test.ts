import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { actionPage } from "../src/product/dashboard.js";
import { currentExplanation, latestResolution, resolutionHistory } from "../src/product/actionPresentation.js";
import { APP_JS } from "../src/product/assets.js";
import type { EffectState } from "../src/model/effectState.js";
import type { OutcomeResolution } from "../src/model/resolution.js";

function resolution(state:EffectState,primary:OutcomeResolution["control"]["primary"],sequence:number,evidenceRefs:string[]=[]):OutcomeResolution{return {
  resolution_version:1,resolution_id:randomUUID(),action_id:randomUUID(),effect_name:"github.repository_permission_change",business_key:"permission:alice",input_hash:`sha256:${"a".repeat(64)}`,
  effect:{state,provider_object_refs:[],evidence_refs:evidenceRefs,verification_methods:[],evidence_strength:evidenceRefs.length?"authoritative":"none"},
  control:{decision_version:1,primary,retry:"forbidden",continuation:state==="verified"||state==="satisfied_unattributed"?"allowed":"blocked",recovery:state==="compensated"?"escalate":"none",reason_code:`TEST.${state.toUpperCase()}`,explanation:`Truthful ${state} decision`,policy_version:"test",spec_version:"1.0.0"},
  context:{value_minor_units:null,value_currency:null,risk_magnitude:null,workload_id:null,workload_version:null,model_identity:null,model_config_hash:null,credential_ref:null,approval:{required:false,fired:false,reference:null}},runtime:{resolution_sequence:sequence,evidence_sequence:10},
  trust:{created_at:"2026-08-09T00:00:00.000Z",resolved_at:`2026-08-09T00:00:0${sequence}.000Z`,clock:{source:"local_system_clock",trusted:false,timestamp:"2026-08-09T00:00:00.000Z"},signature:null},
}}

describe("v0.2.1 canonical action presentation",()=>{
  it("selects the greatest durable resolution sequence, not array order",()=>{const newest=resolution("satisfied_unattributed","do_not_retry",2);const oldest=resolution("pending","hold",1);assert.equal(latestResolution([newest,oldest])?.resolution_id,newest.resolution_id);assert.deepEqual(resolutionHistory([oldest,newest]).map(item=>item.resolution_sequence),[2,1])});
  for(const [state,primary] of [["verified","continue"],["not_applied","do_not_retry"],["pending","hold"],["compensated","escalate"],["satisfied_unattributed","do_not_retry"],["unprovable","escalate"]] as const){it(`renders canonical nested ${state} and ${primary}`,()=>{const html=actionPage({action_id:randomUUID(),effect_name:"fake",business_key:"case",environment_mode:"enforced"},[],[resolution(state,primary,1) as unknown as Record<string,unknown>]);assert.match(html,new RegExp(`>${state}<`));assert.match(html,new RegExp(`>${primary.replaceAll("_"," ").toUpperCase()}<`));assert.doesNotMatch(html,/INVESTIGATE/)})}
  it("shows only active evidence cited by the current resolution",()=>{const cited=randomUUID(),uncited=randomUUID(),superseded=randomUUID(),correction=randomUUID();const current=latestResolution([resolution("satisfied_unattributed","do_not_retry",2,[cited,superseded])])!;const evidence=[{evidence_id:cited,seq:1,source:"provider.read",observed_disposition:"effect_present",strength:"authoritative",attribution:"unattributed"},{evidence_id:uncited,seq:2,source:"unrelated",observed_disposition:"effect_present",strength:"authoritative",attribution:"attributed"},{evidence_id:superseded,seq:3,source:"old.read",observed_disposition:"effect_present",strength:"authoritative",attribution:"attributed"},{evidence_id:correction,seq:4,source:"correction",observed_disposition:"indeterminate",strength:"corroborative",attribution:"indeterminate",supersedes_evidence_id:superseded}];const explanation=currentExplanation({effect_name:"fake"},evidence,current);assert.deepEqual(explanation.facts.map(fact=>fact.evidence_id),[cited]);assert.match(explanation.attribution_note??"",/not attributable/);const html=actionPage({action_id:randomUUID(),effect_name:"fake",business_key:"case"},evidence,[current.document as unknown as Record<string,unknown>]);const proof=html.slice(html.indexOf('<ul class="because">'),html.indexOf('</ul>',html.indexOf('<ul class="because">')));assert.match(proof,/provider\.read/);assert.doesNotMatch(proof,/unrelated|old\.read|correction/);assert.match(html,/old\.read/,'historical evidence remains visible in the timeline')});
});

describe("v0.2.1 browser control safety",()=>{
  it("browser controls capture their element before awaiting, and hold no authoritative safety logic", () => {
    // The v0.2.1 bug: reading `event.currentTarget` AFTER an await, by which
    // point the browser has cleared it. The fix is to capture the element into
    // a local first. Assert the property, not one historical line of source.
    const handlers = APP_JS.split("addEventListener").slice(1);
    assert.ok(handlers.length > 0, "the client script installs handlers");
    for (const handler of handlers) {
      const firstAwait = handler.indexOf("await");
      if (firstAwait < 0) continue;
      const beforeAwait = handler.slice(0, firstAwait);
      const afterAwait = handler.slice(firstAwait);
      assert.doesNotMatch(afterAwait, /currentTarget/,
        "currentTarget must never be read after an await; capture the element first");
      if (/currentTarget/.test(beforeAwait)) {
        assert.match(beforeAwait, /const\s+\w+\s*=\s*event\.currentTarget/,
          "currentTarget must be captured into a local before any await");
      }
    }
    // Mutating calls must carry CSRF and an idempotency key, and must lock the
    // control while in flight so a double click cannot issue two commands.
    assert.match(APP_JS, /x-nyst-csrf/);
    assert.match(APP_JS, /idempotency-key/);
    assert.match(APP_JS, /button\.disabled\s*=\s*true/);
    // No authoritative safety decision may live in the browser.
    for (const forbidden of [/effect_state\s*=/, /retry\s*=\s*["']allowed/, /force[_ ]continue/i]) {
      assert.doesNotMatch(APP_JS, forbidden, "the browser never decides safety");
    }
  });
});
