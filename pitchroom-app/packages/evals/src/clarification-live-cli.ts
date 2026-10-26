import { readFileSync } from "node:fs";
import { clarifyLiveConfigSchema, ClarifyStop } from "./clarification-budget";
import { availableEvidenceBytes, checkedSessionPath, createSessionDirectory, LocalClarifyRecords } from "./clarification-records";
import { initializeClarifySession, runClarifyPhase, writeSummary } from "./clarification-live";
const args=process.argv.slice(2);
const value=(key:string)=>{const i=args.indexOf(key);return i<0?undefined:args[i+1];};
const byteCap=2_000_000;
async function main(){
 const mode=["--prepare","--run","--continue-chain","--status"].filter(flag=>args.includes(flag));
 if(mode.length!==1){process.stdout.write("Clarify acceptance: --prepare --config FILE | --run --session DIR --authorize-synthetic-transfer | --continue-chain --session DIR --authorize-synthetic-transfer | --status --session DIR\nDefault: no model calls. No .env files are loaded.\n");return;}
 const action=mode[0];
 if(action==="--prepare"){
  const file=value("--config");if(!file)throw new ClarifyStop("CONFIG_REQUIRED");
  const config=clarifyLiveConfigSchema.parse(JSON.parse(readFileSync(file,"utf8")));
  const root=createSessionDirectory();if(availableEvidenceBytes()<byteCap)throw new ClarifyStop("WORKSPACE_EVIDENCE_BUDGET");
  const records=new LocalClarifyRecords(root,byteCap);
  try{initializeClarifySession(records,config,"live-model");process.stdout.write(JSON.stringify({phase:"prepared",root,networkRequests:0})+"\n");}finally{records.close();}
  return;
 }
 const path=value("--session");if(!path)throw new ClarifyStop("SESSION_REQUIRED");
 const root=checkedSessionPath(path);
 if(action!=="--status" && (!args.includes("--authorize-synthetic-transfer") || process.env.PITCHROOM_LIVE_TRANSFER_ACK!=="authorized"))throw new ClarifyStop("EXPLICIT_LIVE_AUTHORIZATION_REQUIRED");
 if(action!=="--status"&&availableEvidenceBytes()<byteCap)throw new ClarifyStop("WORKSPACE_EVIDENCE_BUDGET");
 const key=action==="--status"?"":process.env.OPENAI_API_KEY;
 if(action!=="--status"&&!key)throw new ClarifyStop("API_KEY_REQUIRED");
 const records=new LocalClarifyRecords(root,byteCap,key?[key]:[]);
 try{
  const session=records.read<{phase:string;mode:string}>("session.json");
  if(session.mode!=="live-model")throw new ClarifyStop("NOT_A_LIVE_SESSION");
  if(action==="--run"&&session.phase!=="prepared")throw new ClarifyStop("USE_EXPLICIT_CONTINUATION");
  if(action==="--continue-chain"&&!["awaiting_case1_review","awaiting_chain6_review"].includes(session.phase))throw new ClarifyStop("NO_CHAIN_CONTINUATION");
  const report=action==="--status"?writeSummary(records,undefined,undefined,false):await runClarifyPhase(records,fetch,key!);
  process.stdout.write(JSON.stringify(report,null,2)+"\n");if(!report.acceptedFirstRun)process.exitCode=1;
 }catch(error){records.abort(error instanceof ClarifyStop?error.code:"LOCAL_FAILURE");throw error;}finally{records.close();}
}
main().catch(error=>{process.stderr.write(`${error instanceof ClarifyStop?error.code:"CONFIGURATION_OR_LOCAL_IO_ERROR"}\n`);process.exitCode=1;});
