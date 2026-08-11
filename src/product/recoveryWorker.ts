import type { ProductRepository } from "./productRepository.js";

export interface RecoveryClaim {
  recovery_execution_id:string;action_id:string;resolution_id:string;operation:"authorized_continuation"|"supported_compensation";claim_token:string;downstream_operation_key:string;
  resolution_sequence:number;evidence_sequence:number;environment_id:string;project_id:string;organization_id:string;effect_name:string;spec_version:string;
}
export interface RecoveryResult { outcome:"completed";provider_reference?:string;resolution?:unknown; }
export type RecoveryExecutor=(claim:Readonly<RecoveryClaim>)=>Promise<RecoveryResult>;

/** Explicit allowlist only: no arbitrary scripts, URLs, or callbacks from persisted data. */
export class RecoveryExecutorRegistry {
  private readonly handlers=new Map<string,RecoveryExecutor>();
  register(effectName:string,operation:RecoveryClaim["operation"],executor:RecoveryExecutor):void{const key=`${effectName}:${operation}`;if(this.handlers.has(key))throw new Error(`Duplicate recovery executor ${key}`);this.handlers.set(key,executor)}
  resolve(claim:RecoveryClaim):RecoveryExecutor|null{return this.handlers.get(`${claim.effect_name}:${claim.operation}`)??null}
}

export class NystRecoveryWorker {
  constructor(private readonly repository:ProductRepository,private readonly executors:RecoveryExecutorRegistry){}
  async runOne():Promise<boolean>{const value=await this.repository.claimRecovery();if(!value)return false;const claim=value as unknown as RecoveryClaim;const executor=this.executors.resolve(claim);if(!executor){await this.repository.completeRecovery(claim.recovery_execution_id,claim.claim_token,false,{error_code:"unsupported_recovery_executor"});return true}
    try{const result=await executor(Object.freeze({...claim}));if(result.resolution)await this.repository.recordResolutionTransition(claim.action_id,result.resolution,"recovery_worker");await this.repository.completeRecovery(claim.recovery_execution_id,claim.claim_token,true,{outcome:result.outcome,...(result.provider_reference?{provider_reference:result.provider_reference}:{})});}
    catch(error){await this.repository.completeRecovery(claim.recovery_execution_id,claim.claim_token,false,{error_code:safeError(error)});}return true}
}
function safeError(error:unknown):string{return (error instanceof Error?error.name:"recovery_failed").replace(/[^A-Za-z0-9_.-]/g,"").slice(0,80)||"recovery_failed"}
