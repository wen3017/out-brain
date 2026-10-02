/** Only an explicit adoption of the prior proposal can promote assistant text
 * into a user-confirmed plan. Acknowledgements and questions stay unconfirmed. */
export function explicitlyAdoptsProposal(text:string){
  return !/(?:不|暂不|不要|尚未)(?:予以)?确认|是否|要不要|假如|假设/.test(text)
    && /(?:我|我们)?(?:明确)?确认(?:采用|执行|接受|落实|实施)/.test(text)
    && /(?:你|刚才|上述|上面|这个|该).*(?:建议|方案|安排)/.test(text);
}
export function confirmedMemoryInput(userText:string,proposal?:string){
  if(!proposal||!explicitlyAdoptsProposal(userText))return userText;
  return `用户本轮原话：${userText}\n以下是用户明确采用的前一轮建议，应作为已确认的未来计划，不代表已经发生或完成：\n${proposal}`;
}

export function isConfirmedPlanInput(text:string){
  return text.startsWith("用户本轮原话：") && explicitlyAdoptsProposal(text.split("\n")[0])
    && text.includes("以下是用户明确采用的前一轮建议，应作为已确认的未来计划，不代表已经发生或完成：");
}
