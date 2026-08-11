import { verifyWebhook } from "./controlPlane.js";
export interface NystClientOptions{baseUrl:string;apiKey:string;fetch?:typeof fetch}
export interface ExecuteActionInput{effect:string;businessKey:string;input:unknown;approved?:boolean}
export type NystActionsGateway=((filters?:Record<string,string>)=>Promise<unknown>)&{execute(input:ExecuteActionInput):Promise<unknown>;get(actionId:string):Promise<unknown>;evidence(actionId:string):Promise<unknown>;resolutions(actionId:string):Promise<unknown>;receipt(actionId:string):Promise<unknown>;reconcile(actionId:string):Promise<unknown>};
export class NystClient{
  private readonly requestFetch:typeof fetch;readonly actions:NystActionsGateway;readonly shadow:{evaluate(input:{effect:string;businessKey:string;observation:{transport:"success"|"definitely_not_sent"|"ambiguous";authoritative_goal_observed:boolean|null;attempted_retry:boolean;attempted_continuation:boolean}}):Promise<unknown>};
  constructor(private readonly options:NystClientOptions){this.requestFetch=options.fetch??fetch;if(!/^https?:\/\//.test(options.baseUrl))throw new Error("Nyst SDK requires an HTTP(S) base URL");const list=(filters:Record<string,string>={})=>this.request("GET",`/v1/actions?${new URLSearchParams(filters)}`);this.actions=Object.assign(list,{execute:(input:ExecuteActionInput)=>this.request("POST","/v1/actions",input),get:(actionId:string)=>this.action(actionId),evidence:(actionId:string)=>this.evidence(actionId),resolutions:(actionId:string)=>this.resolutions(actionId),receipt:(actionId:string)=>this.receipt(actionId),reconcile:(actionId:string)=>this.reconcile(actionId)});this.shadow={evaluate:(input)=>this.request("POST","/v1/shadow/evaluations",input)}}
  commit(input:ExecuteActionInput):Promise<unknown>{return this.actions.execute(input)}
  action(actionId:string):Promise<unknown>{return this.request("GET",`/v1/actions/${id(actionId)}`)}
  listActions(filters:Record<string,string>={}):Promise<unknown>{return this.actions(filters)}
  evidence(actionId:string):Promise<unknown>{return this.request("GET",`/v1/actions/${id(actionId)}/evidence`)}
  resolutions(actionId:string):Promise<unknown>{return this.request("GET",`/v1/actions/${id(actionId)}/resolutions`)}
  receipt(actionId:string):Promise<unknown>{return this.request("GET",`/v1/actions/${id(actionId)}/receipt`)}
  reconcile(actionId:string):Promise<unknown>{return this.request("POST",`/v1/actions/${id(actionId)}/reconcile`,{})}
  static verifyDecisionWebhook(secret:string,timestamp:string,rawBody:string,signature:string,now?:number):boolean{return verifyWebhook(secret,timestamp,rawBody,signature,now)}
  private async request(method:string,path:string,body?:unknown):Promise<unknown>{const response=await this.requestFetch(new URL(path,this.options.baseUrl),{method,headers:{Accept:"application/json",Authorization:`Nyst ${this.options.apiKey}`,...(body===undefined?{}:{"Content-Type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:"error"});const value=await response.json() as unknown;if(!response.ok)throw new NystApiError(response.status,value);return value}
}
export class NystApiError extends Error{constructor(public readonly status:number,public readonly response:unknown){super(`Nyst API returned HTTP ${status}`)}}
function id(value:string):string{if(!/^[0-9a-f-]{36}$/i.test(value))throw new Error("Invalid action ID");return encodeURIComponent(value)}
