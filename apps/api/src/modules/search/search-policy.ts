export type SearchMode = boolean | "auto" | "on" | "off";

export function searchPolicy(text: string, mode: SearchMode = "auto") {
  const explicitlyOffline = /(?:不要|不用|禁止|不允许|别)(?:再|去|进行)?(?:联网|上网|搜索网络)|(?:do not|don't|never)\s+(?:browse|search the web)/i.test(text);
  const requested = /联网|上网|网上(?:查|搜)|搜索(?:网络|互联网)|查(?:一下)?(?:官网|新闻)|\b(?:search the web|browse|look up online)\b/i.test(text);
  const timely = /今天|今日|最新|近期|最近|目前|现在|今年|本周|这周|上周|新闻|实时|现任|现价|股价|汇率|天气|\b(?:current|latest|today|recent|news|weather|this year|this week)\b/i.test(text);
  // Relative dates in personal plans do not imply permission to search private facts.
  const localOnly = /(?:只|仅)(?:根据|依据|按|用).{0,12}(?:文件|资料|会议|原文|记忆)|请记住|记住以下|我叫|我住|我(?:现在|目前)?在.{0,12}工作/.test(text);
  const privateContext = /(?:本次|这次|我们|我的|当前会话|刚才).{0,16}(?:会议|项目|待办|计划|安排|记忆)|(?:今天|明天|本周|下周).{0,6}(?:我|我们|他|她)(?:要|将|会|在|去)|(?:今天|明天)(?:是几号|星期几)/.test(text);
  const disabled = mode === false || mode === "off" || explicitlyOffline;
  const required = !disabled && !localOnly && (mode === true || mode === "on" || requested || (timely && !privateContext));
  return { required, disabled, timely };
}
