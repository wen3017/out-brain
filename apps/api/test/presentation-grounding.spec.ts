import { describe,it,expect } from "vitest";
import { applyGroundingReview,conservativeGroundingReview,extractiveGroundingReview,presentationTextNodes } from "../src/modules/presentations/presentation-grounding.js";
const fixture=()=>({title:"项目汇报",slides:[{id:"s",title:"计划",notes:"",elements:[{id:"e",type:"text" as const,text:"张总审批客户排期",x:1,y:1,w:5,h:1,fontSize:20,color:"111111",bold:false}]}]});
describe("PPT grounding gate",()=>{
 it("rejects incomplete coverage and fabricated source evidence",()=>{
  const doc=fixture();expect(()=>applyGroundingReview(doc,"张总负责项目",{items:[]})).toThrow("未覆盖");
  const items=presentationTextNodes(doc).map(({key,text})=>({key,text,kind:"HEADING",evidence:""}));
  items[3]={...items[3],kind:"FACT",evidence:"张总审批客户排期"};
  expect(()=>applyGroundingReview(doc,"张总负责项目",{items})).toThrow("原文证据");expect(doc.slides[0].elements[0].text).toBe("张总审批客户排期");
 });
 it("labels unsupported proposed actions and preserves traceable confirmed facts",()=>{
  const doc=fixture();const items=presentationTextNodes(doc).map(({key,text})=>({key,text,kind:"HEADING",evidence:""}));
  items[3]={...items[3],text:"明确客户排期的审批人",kind:"SUGGESTION",evidence:""};applyGroundingReview(doc,"张总负责项目",{items});
  expect(doc.slides[0].elements[0].text).toBe("建议（待确认）：明确客户排期的审批人");
  items[3]={...items[3],text:"项目负责人：张总",kind:"FACT",evidence:"张总负责项目"};applyGroundingReview(doc,"张总负责项目",{items});
  expect(doc.slides[0].notes).toContain("核对原文：\n张总负责项目");
 });
 it("removes unsupported specifics across every line instead of qualifying only the last claim",()=>{
  const doc=fixture();const items=presentationTextNodes(doc).map(({key,text})=>({key,text,kind:"HEADING",evidence:""}));
  items[3]={...items[3],text:"甲型用于生产\n乙型用于检测（待确认）",kind:"UNKNOWN"};
  applyGroundingReview(doc,"甲型设备3台；乙型设备5台",{items});
  expect(doc.slides[0].elements[0].text).toBe("相关信息待确认（原始材料未提供依据）");
 });
 it("uses the source quote when a factual paraphrase invents an unsupported purpose",()=>{
  const doc=fixture();const source="甲型设备 3 台，单价 1200 元/台。";
  const items=presentationTextNodes(doc).map(({key,text})=>({key,text,kind:"HEADING",evidence:""}));
  items[3]={...items[3],text:"甲型设备用于核心生产",kind:"FACT",evidence:source};
  applyGroundingReview(doc,source,{items});
  expect(doc.slides[0].elements[0].text).toBe(source);
 });
 it("downgrades only invalid evidence and fills omitted fields before publication",()=>{
  const doc=fixture();
  const review=conservativeGroundingReview(doc,"张总负责项目",{items:[{key:"0/element/0",text:"张总审批客户排期",kind:"FACT",evidence:"张总审批客户排期"}]});
  expect(review.items.find(item=>item.key==="0/element/0")?.kind).toBe("UNKNOWN");
  expect(review.items).toHaveLength(presentationTextNodes(doc).length);
  expect(()=>applyGroundingReview(doc,"张总负责项目",review)).not.toThrow();
  expect(doc.slides[0].elements[0].text).toContain("待确认");
 });
 it("uses only exact source excerpts when structured review is unavailable",()=>{
  const doc=fixture();
  doc.slides[0].elements[0].text="张总负责项目，审批排期";
  const source="张总负责项目整体协调与进度跟踪，并负责周会信息汇总。客户排期尚未确定，需要进一步核对。";
  const review=extractiveGroundingReview(doc,source,[source]);
  expect(()=>applyGroundingReview(doc,source,review)).not.toThrow();
  expect(doc.slides[0].elements[0].text).not.toContain("审批排期");
  expect(doc.slides[0].notes).toContain("张总负责项目整体协调与进度跟踪");
 });
});
