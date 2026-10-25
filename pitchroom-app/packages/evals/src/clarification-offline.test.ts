import { expect,it } from "vitest";
import { buildClarificationCandidate,understandingProposalV1Schema } from "@pitchroom/domain";
import { clarifyCases,taskForCase } from "./clarification-cases";
import { gradeClarification } from "./clarification-offline";
it("defines eight approved cases with valid multi-theme contradictory source snapshots",()=>{
 expect(clarifyCases).toHaveLength(8);
 for(const c of clarifyCases){const t=taskForCase(c);expect(understandingProposalV1Schema.safeParse(t.base).success).toBe(true);expect(t.base.themes).toHaveLength(4);expect(t.base.themes[1]!.claims[0]!.evidenceState).toBe("conflicting");expect(c.mustPreserve).toBeTruthy();expect(c.mustNot).toBeTruthy();}
});
it("detects wrong-theme changes and rejects empty proposals for required changes",()=>{
 const c=clarifyCases[4]!,t=taskForCase(c);
 const wrong={reason:"Synthetic negative control",operations:[{type:"update_summary" as const,themeId:"T1",text:"只允许脱敏数据，审查未开始。"}]};
 expect(gradeClarification(c,t,wrong,buildClarificationCandidate(t,wrong))).toContainEqual({name:"only_relevant_theme_targeted",passed:false});
 const empty={reason:"No operations",operations:[]};
 expect(gradeClarification(c,t,empty,buildClarificationCandidate(t,empty))).toContainEqual({name:"relevant_summary_changed",passed:false});
});
it("accepts a bounded reference shape but catches source mutation and unrelated changes",()=>{
 const c=clarifyCases[4]!,t=taskForCase(c);const result={reason:"用户补充安全边界",operations:[{type:"update_summary" as const,themeId:"T4",text:"用户补充只允许脱敏数据，驻留审查未开始；地区和审批人仍未知。"},{type:"add_answer" as const,themeId:"T4"}]};
 const candidate=buildClarificationCandidate(t,result);expect(gradeClarification(c,t,result,candidate).every(x=>x.passed)).toBe(true);
 candidate.themes[1]!.claims[0]!.statement="已证明所有客户减少50%";
 expect(gradeClarification(c,t,result,candidate)).toContainEqual({name:"original_claims_preserved",passed:false});
});
