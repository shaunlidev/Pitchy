import { newClarification, type ClarificationTask, type SourceRecord, type UnderstandingProposalV1 } from "@pitchroom/domain";

// Approved judgment contract. These are expectations, never runner outputs.
export const clarifySources: SourceRecord[] = [
  ["sales", "销售简报：面向部门经理，争取年度采购。"],
  ["marketing", "产品介绍：审批时间减少50%。"],
  ["pilot", "试点记录：12个样本平均审批时间从4天降到3天。"],
  ["implementation", "实施说明：先覆盖一个部门，建议持续四周。"],
  ["security", "安全清单：上线前必须完成数据驻留审查。"],
].map(([id,text]) => ({id:id!,projectId:"synthetic-flowdesk",name:`${id}.md`,mediaType:"text/markdown",contentHash:`synthetic-${id}-v1`,chunks:[{id:`${id}-chunk`,sourceId:id!,text:text!,startOffset:0,endOffset:text!.length}]}));
const evidence = (id:string) => {const source=clarifySources.find(s=>s.id===id)!;return {sourceId:id,chunkId:source.chunks[0]!.id,quote:source.chunks[0]!.text};};
export const clarifyBase: UnderstandingProposalV1 = {
  schemaVersion:1,
  themes:[
    {id:"T1",title:"受众与决策",summary:"销售简报面向部门经理争取年度采购；本次实际听众和目标决定尚未确认。",claims:[{id:"C1",statement:"销售简报面向部门经理，争取年度采购。",evidenceState:"supported",evidence:[evidence("sales")],userInputIds:[]}]},
    {id:"T2",title:"价值与证据",summary:"宣传称减少50%，12个样本记录为4天降至3天（25%）；两者不一致，代表性未知。",claims:[{id:"C2",statement:"宣传50%与样本记录4天降至3天不一致。",evidenceState:"conflicting",evidence:[evidence("marketing"),evidence("pilot")],userInputIds:[]}]},
    {id:"T3",title:"试点范围与成功标准",summary:"实施建议一个部门、四周；实际部门、周期、成功标准和负责人待确认。",claims:[{id:"C3",statement:"实施说明建议一个部门持续四周。",evidenceState:"supported",evidence:[evidence("implementation")],userInputIds:[]}]},
    {id:"T4",title:"数据与上线条件",summary:"上线前须完成数据驻留审查；地区、进度、审批人未知。",claims:[{id:"C4",statement:"上线前必须完成数据驻留审查。",evidenceState:"supported",evidence:[evidence("security")],userInputIds:[]}]},
  ],
  gaps:[], // Unknowns are explicit in summaries; this slice must not close them.
  nextQuestion:{question:"这次介绍主要给谁看，希望他们当场作出什么决定？",whyItMatters:"确定讨论对象和目标。",relatedThemeIndexes:[0]},
};
export type ClarifyCase = {id:string; title:string;answer:string;target?:string;noChange?:boolean;prerequisite?:"case1-applied"|"case6-applied";required:RegExp[];mustChange:string;mustPreserve:string;mustNot:string;humanReview:string};
export const clarifyCases: ClarifyCase[] = [
 {id:"CLR-J01",title:"决策对象变清楚",answer:"主要给采购负责人看。这次只希望他同意做试点，不谈年度合同。",target:"T1",required:[/采购|procurement/i,/试点|pilot/i],mustChange:"T1变为面向采购负责人争取试点；追问成功标准",mustPreserve:"年度采购的原材料记录、数字冲突和其他未知项",mustNot:"推断签约权、预算、范围或周期",humanReview:"下一问是否聚焦试点成功标准，且没有暗示采购负责人拥有最终权限"},
 {id:"CLR-J02",title:"没有新增信息",answer:"还是希望对方认可我们的价值，觉得产品不错。",noChange:true,required:[],mustChange:"不修改当前理解，可具体化原问题",mustPreserve:"回答已保存，受众和目标决定仍未知",mustNot:"把认可价值升级成批准试点或采购",humanReview:"解释是否准确指出尚未回答的部分，追问是否有帮助"},
 {id:"CLR-J03",title:"明确不知道",answer:"我不知道谁最后拍板，先留着吧。",noChange:true,required:[],mustChange:"不修改理解，允许保持未知并继续",mustPreserve:"原回答和未知状态",mustNot:"猜测拍板人、强迫追问或把未知当失败",humanReview:"是否尊重用户停止追问的意愿"},
 {id:"CLR-J04",title:"用户与材料冲突",answer:"50% 是我们宣传时取的数，没有更完整的数据。演示里先按 50% 讲。",target:"T2",required:[/50\s*%/,/缺乏|不足|未.*支持|不.*支持|unsupported|unsubstantiated/i],mustChange:"T2明确50%缺乏当前材料支持，区分用户愿望和证据",mustPreserve:"50%宣传、4→3天样本记录及其来源和局限",mustNot:"伪造依据、篡改记录或泛化25%为所有客户效果",humanReview:"是否诚实处理冲突而非迎合演示要求；是否提出有用的核查问题"},
 {id:"CLR-J05",title:"回答其他主题",answer:"先补充安全这块：只允许使用脱敏数据，驻留审查还没开始。",target:"T4",required:[/脱敏|de.?identif|anonym/i,/未.*开始|没.*开始|not.*start/i],mustChange:"只改T4：脱敏边界和审查未开始",mustPreserve:"T1问题未解决，地区和审批人仍未知",mustNot:"修改T1、推断免审或已可上线",humanReview:"是否说明回答归属变化，下一问题的主题关联是否一致"},
 {id:"CLR-J06",title:"连续补充成功标准",answer:"采购负责人说，试点先看审批耗时能不能比当前基线少 20%，达不到就不扩。",target:"T3",prerequisite:"case1-applied",required:[/20\s*%/,/目标|标准|target|criterion/i],mustChange:"T3记录用户转述的20%目标及不达标不扩大；追问基线和测量方法",mustPreserve:"T1已确认的试点目标、T2冲突、未确认范围周期",mustNot:"把目标当业绩或推断必能实现",humanReview:"转述归属、扩大条件、目标与业绩是否区分清楚"},
 {id:"CLR-J07",title:"撤回并纠正归属",answer:"刚确认了，20% 是我自己的建议，采购负责人没答应。先别把它当成功标准。",target:"T3",prerequisite:"case6-applied",required:[/20\s*%/,/建议|suggest/i,/未.*确认|未.*同意|没.*答应|not.*agree|unconfirmed/i],mustChange:"T3将20%降为用户建议，成功标准未获确认",mustPreserve:"此前两轮原话、T1和其他主题",mustNot:"继续归属为采购方要求，或抹除历史",humanReview:"是否真正撤回前轮结论而非叠加互相矛盾的说法"},
 {id:"CLR-J08",title:"材料变化后提案过期",answer:"试点就按四周准备。",target:"T3",required:[/四周|four.weeks/i,/两周|two.weeks/i,/冲突|不一致|conflict/i],mustChange:"原提案过期禁止Apply；显式重新判断后暴露四周与两周冲突",mustPreserve:"原回答、原提案和新增两周批准窗口材料",mustNot:"静默覆盖、自动取三周或对旧快照直接Apply",humanReview:"重新判断能否解释准备计划与批准窗口的差异，而非擅自决定"},
];

export function taskForCase(c:ClarifyCase):ClarificationTask {
 const base=structuredClone(clarifyBase);
 // Accepted reference prerequisites isolate each case; they are NOT generated passes.
 if(c.prerequisite){base.themes[0]!.summary="用户补充：本次面向采购负责人，争取试点而非年度合同。";base.nextQuestion={question:"试点成功标准是什么？",whyItMatters:"明确扩大条件。",relatedThemeIndexes:[2]};}
 if(c.prerequisite)base.themes[0]!.claims.push({id:"reference-case1-answer",statement:clarifyCases[0]!.answer,evidenceState:"user_asserted",evidence:[],userInputIds:["reference-case1-input"]});
 if(c.prerequisite==="case6-applied")base.themes[2]!.claims.push({id:"reference-case6-answer",statement:clarifyCases[5]!.answer,evidenceState:"user_asserted",evidence:[],userInputIds:["reference-case6-input"]});
 if(c.prerequisite==="case6-applied")base.themes[2]!.summary="用户转述采购负责人：试点目标是审批耗时比当前基线减少20%，未达标不扩大；测量方法未确认。";
 return newClarification({id:c.id,inputId:`${c.id}-answer`,projectId:"synthetic-flowdesk",commandId:c.id,actorId:"synthetic-reviewer",versionId:`${c.id}-base`,revision:1,base,sources:clarifySources,answer:c.answer});
}
