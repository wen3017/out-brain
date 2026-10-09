import { BadRequestException } from "@nestjs/common";
import { Type } from "typebox";
import { z } from "zod";
import type { PresentationDocument } from "@nbboss/contracts";
import { tokenize } from "../files/retrieval-ranking.js";

export const groundingToolSchema = Type.Object({items:Type.Array(Type.Object({key:Type.String(),kind:Type.Union([Type.Literal("FACT"),Type.Literal("HEADING"),Type.Literal("SUGGESTION"),Type.Literal("UNKNOWN")]),text:Type.String(),evidence:Type.String()}))});
const reviewSchema=z.object({items:z.array(z.object({key:z.string(),kind:z.enum(["FACT","HEADING","SUGGESTION","UNKNOWN"]),text:z.string(),evidence:z.string()})).max(2000)});
export function presentationTextNodes(document:PresentationDocument){
  const nodes:Array<{key:string;text:string;set:(text:string)=>void;slide?:number}>=[];
  nodes.push({key:"title",text:document.title,set:text=>document.title=text});
  document.slides.forEach((slide,index)=>{
    nodes.push({key:`${index}/title`,text:slide.title,slide:index,set:text=>slide.title=text});
    nodes.push({key:`${index}/notes`,text:slide.notes,slide:index,set:text=>slide.notes=text});
    slide.elements.forEach((element,i)=>{if(element.type==="text")nodes.push({key:`${index}/element/${i}`,text:element.text,slide:index,set:text=>element.text=text});});
  });
  return nodes;
}
export function conservativeGroundingReview(document:PresentationDocument,source:string,output:unknown){
  const review=reviewSchema.parse(output),byKey=new Map(review.items.map(item=>[item.key,item]));
  return {items:presentationTextNodes(document).map(node=>{
    const item=byKey.get(node.key);
    if(!item||item.kind==="FACT"&&(!item.evidence.trim()||!source.includes(item.evidence.trim())))
      return {key:node.key,kind:"UNKNOWN" as const,text:"相关信息待确认（原始材料未提供依据）",evidence:""};
    return item;
  })};
}
export function extractiveGroundingReview(document:PresentationDocument,source:string,evidenceTexts:string[]){
  const segments=evidenceTexts.flatMap(text=>text.split(/(?<=[.!?。！？;；])\s+|\n+/u))
    .map(text=>text.trim()).filter(text=>text.length>=20&&text.length<=350&&source.includes(text));
  return {items:presentationTextNodes(document).map(node=>{
    if(!node.text.trim()||node.key==="title"||/\/title$/.test(node.key))
      return {key:node.key,kind:"HEADING" as const,text:node.text,evidence:""};
    const exact=node.text.trim();
    if(source.includes(exact))return {key:node.key,kind:"FACT" as const,text:exact,evidence:exact};
    const terms=[...new Set(tokenize(exact).filter(term=>term.length>=2))];
    const ranked=segments.map(segment=>({segment,score:terms.filter(term=>segment.toLowerCase().includes(term.toLowerCase())).length}))
      .sort((a,b)=>b.score-a.score);
    if(ranked[0]?.score>0)return {key:node.key,kind:"FACT" as const,text:ranked[0].segment,evidence:ranked[0].segment};
    return {key:node.key,kind:"UNKNOWN" as const,text:"相关信息待确认（原始材料未提供依据）",evidence:""};
  })};
}
export function applyGroundingReview(document:PresentationDocument,source:string,output:unknown){
  const review=reviewSchema.parse(output),nodes=presentationTextNodes(document),byKey=new Map(review.items.map(item=>[item.key,item]));
  if(byKey.size!==review.items.length||byKey.size!==nodes.length||nodes.some(node=>!byKey.has(node.key)))throw new BadRequestException("PPT 事实核对未覆盖全部文字，请重试生成");
  // Validate the whole review before changing any output.
  for(const item of review.items){if(item.kind==="FACT"&&(!item.evidence.trim()||!source.includes(item.evidence.trim())))throw new BadRequestException("PPT 事实缺少可核对的原文证据，请重试生成");}
  const evidence=new Map<number,Set<string>>();
  for(const node of nodes){
    const item=byKey.get(node.key)!;let text=item.text;
    // A real quote alone does not prove the model's paraphrase. Keep an
    // extractive fallback when it adds words beyond the supplied evidence.
    const compact=(value:string)=>value.replace(/[\s•·：:，,。；;（）()]/g,"");
    if(item.kind==="FACT" && !compact(item.evidence).includes(compact(text)))text=item.evidence.trim();
    if(item.kind==="HEADING" && text.trim() && !compact(source).includes(compact(text)) && (/\n|用于|负责|承诺|完成|已|预计|达到|审批/.test(text)||text.length>32))text="相关信息待确认（原始材料未提供依据）";
    if(item.kind==="SUGGESTION"&&!text.startsWith("建议（待确认）"))text=`建议（待确认）：${text}`;
    // A trailing qualifier on a multi-line block appears to qualify only its
    // last claim. Do not retain specific guesses without supporting evidence.
    if(item.kind==="UNKNOWN")text="相关信息待确认（原始材料未提供依据）";
    node.set(text);
    if(item.kind==="FACT"&&node.slide!==undefined){const quotes=evidence.get(node.slide)??new Set<string>();quotes.add(item.evidence.trim());evidence.set(node.slide,quotes);}
  }
  for(const [index,quotes] of evidence)document.slides[index].notes += `\n\n核对原文：\n${[...quotes].join("\n")}`;
}
