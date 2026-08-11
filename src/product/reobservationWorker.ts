import type { ProductRepository } from "./productRepository.js";
export interface ObservationRuntime { reconcile(actionId:string):Promise<unknown>; }
export class NystReobservationWorker {
  constructor(private readonly repository:ProductRepository,private readonly runtime:ObservationRuntime){}
  async runOne():Promise<boolean>{const claim=await this.repository.claimReobservation();if(!claim)return false;const jobId=String(claim.reobservation_job_id),actionId=String(claim.action_id),token=String(claim.claim_token);try{const resolution=await this.runtime.reconcile(actionId);await this.repository.recordResolutionTransition(actionId,resolution,"human_review");await this.repository.completeReobservation(jobId,token,true);}catch{await this.repository.completeReobservation(jobId,token,false);}return true}
}
