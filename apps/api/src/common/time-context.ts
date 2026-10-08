/** Use the event timestamp, not the worker's execution time, for relative dates. */
export function timeContext(at = new Date()) {
  const requested = process.env.APP_TIME_ZONE || "Asia/Shanghai";
  let timeZone = requested;
  try { new Intl.DateTimeFormat("en", { timeZone }).format(at); }
  catch { timeZone = "Asia/Shanghai"; }
  const local = new Intl.DateTimeFormat("zh-CN", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "long",
  }).format(at);
  return `时间基准：${local}；时区 ${timeZone}；UTC ${at.toISOString()}。今天、明天、本周、下周按此基准解释；历史会议中的相对日期优先使用会议明确日期，没有可靠基准时标为待确认，禁止猜测。`;
}
