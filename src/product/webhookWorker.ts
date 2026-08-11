import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { privateAddress, signWebhook, validateWebhookTarget } from "./controlPlane.js";
import type { ProductDb } from "./productRepository.js";

export interface WebhookSecretSource { resolve(reference: string): Promise<string>; }
export class EnvironmentWebhookSecretSource implements WebhookSecretSource {
  async resolve(reference: string): Promise<string> {
    if (!/^env:[A-Z][A-Z0-9_]{2,100}$/.test(reference)) throw new Error("Unsupported webhook secret reference");
    const value=process.env[reference.slice(4)]; if(!value||value.length<32)throw new Error("Webhook signing secret is unavailable"); return value;
  }
}

export class NystDecisionWebhookWorker {
  constructor(private readonly db:ProductDb,private readonly secrets:WebhookSecretSource=new EnvironmentWebhookSecretSource(),private readonly requestFetch:typeof fetch=fetch,private readonly leaseMs=30_000,private readonly resolveAddresses:(host:string)=>Promise<Array<{address:string}>>=async host=>lookup(host,{all:true,verbatim:true})){}
  async runOne():Promise<boolean>{
    const token=randomUUID();
    const claim=await this.db.query(`WITH candidate AS (
      SELECT e.webhook_event_id FROM nyst_webhook_events e WHERE e.delivered_at IS NULL AND e.terminal_at IS NULL AND e.next_attempt_at<=now() AND (e.claimed_until IS NULL OR e.claimed_until<now()) ORDER BY e.next_attempt_at,e.webhook_event_id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE nyst_webhook_events e SET claim_token=$1,claimed_until=now()+($2::text||' milliseconds')::interval FROM candidate c WHERE e.webhook_event_id=c.webhook_event_id
      RETURNING e.webhook_event_id,e.payload,e.occurred_at,e.event_type,e.action_id,e.resolution_id,(SELECT target_url FROM nyst_webhook_endpoints WHERE webhook_endpoint_id=e.webhook_endpoint_id) target_url,(SELECT signing_secret_ref FROM nyst_webhook_endpoints WHERE webhook_endpoint_id=e.webhook_endpoint_id) signing_secret_ref,(SELECT count(*)::int+1 FROM nyst_webhook_attempts WHERE webhook_event_id=e.webhook_event_id) attempt_number`,[token,this.leaseMs]);
    const row=claim.rows[0];if(!row)return false;
    const eventId=String(row.webhook_event_id);const attempt=Math.max(1,Number(row.attempt_number));let responseStatus:number|null=null;let errorCode:string|null=null;
    try{
      const target=validateWebhookTarget(String(row.target_url));
      const addresses=await this.resolveAddresses(target.hostname);if(!addresses.length||addresses.some(item=>privateAddress(item.address)))throw new Error("webhook_target_not_public");
      const timestamp=new Date().toISOString();const payload={...(row.payload as Record<string,unknown>),event_id:eventId,event_type:String(row.event_type),occurred_at:new Date(String(row.occurred_at)).toISOString()};const body=JSON.stringify(payload);const secret=await this.secrets.resolve(String(row.signing_secret_ref));
      const headers={"content-type":"application/json","content-length":String(Buffer.byteLength(body)),"user-agent":"Nyst-Decision-Webhook/0.2.1","x-nyst-event-id":eventId,"x-nyst-timestamp":timestamp,"x-nyst-signature":signWebhook(secret,timestamp,body,eventId)};
      if(this.requestFetch===fetch)responseStatus=await pinnedHttpsPost(target,headers,body,addresses);else{const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),10_000);try{const response=await this.requestFetch(target,{method:"POST",headers,body,redirect:"error",signal:controller.signal});responseStatus=response.status;}finally{clearTimeout(timer);}}
      if(responseStatus<200||responseStatus>=300)throw new Error(`webhook_http_${responseStatus}`);
      await this.db.query(`WITH recorded AS (INSERT INTO nyst_webhook_attempts(webhook_attempt_id,webhook_event_id,attempt_number,response_status) VALUES($1,$2,$3,$4) RETURNING webhook_event_id) UPDATE nyst_webhook_events SET delivered_at=now(),claim_token=NULL,claimed_until=NULL FROM recorded WHERE nyst_webhook_events.webhook_event_id=recorded.webhook_event_id AND nyst_webhook_events.claim_token=$5`,[randomUUID(),eventId,attempt,responseStatus,token]);
    }catch(error){errorCode=error instanceof Error?error.message.slice(0,100):"webhook_failed";const terminal=attempt>=6;await this.db.query(`WITH recorded AS (INSERT INTO nyst_webhook_attempts(webhook_attempt_id,webhook_event_id,attempt_number,response_status,error_code) VALUES($1,$2,$3,$4,$5) RETURNING webhook_event_id) UPDATE nyst_webhook_events SET next_attempt_at=now()+(LEAST(300,power(2,$3))::text||' seconds')::interval,terminal_at=CASE WHEN $6 THEN now() ELSE NULL END,claim_token=NULL,claimed_until=NULL FROM recorded WHERE nyst_webhook_events.webhook_event_id=recorded.webhook_event_id AND nyst_webhook_events.claim_token=$7`,[randomUUID(),eventId,attempt,responseStatus,errorCode,terminal,token]);}
    return true;
  }
}

function pinnedHttpsPost(target:URL,headers:Record<string,string>,body:string,addresses:Array<{address:string}>):Promise<number>{const address=addresses[0]!.address;return new Promise((resolve,reject)=>{const request=httpsRequest({protocol:"https:",hostname:target.hostname,servername:target.hostname,port:target.port?Number(target.port):443,path:`${target.pathname}${target.search}`,method:"POST",headers:{...headers,host:target.host},timeout:10_000,maxHeaderSize:16*1024,lookup:(_hostname,_options,callback)=>callback(null,address,address.includes(":")?6:4)},response=>{let size=0;response.on("data",chunk=>{size+=Buffer.byteLength(chunk);if(size>64*1024)request.destroy(new Error("webhook_response_too_large"))});response.on("end",()=>resolve(response.statusCode??0))});request.on("timeout",()=>request.destroy(new Error("webhook_timeout")));request.on("error",reject);request.end(body)})}
