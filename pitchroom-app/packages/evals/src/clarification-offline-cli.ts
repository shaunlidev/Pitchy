import { runClarificationOffline } from "./clarification-offline";
const report=await runClarificationOffline();
process.stdout.write(JSON.stringify(report,null,2)+"\n");
// A red acceptance run is intentional when product gaps exist; never bless them
// with expected-failure assertions or change the approved judgment contract.
if(report.cases.some(c=>c.checks.some(check=>!check.passed)))process.exitCode=1;
