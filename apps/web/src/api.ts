const API = import.meta.env.VITE_API_URL ?? "/api";
let refreshRequest: Promise<boolean> | undefined;

async function authenticatedFetch(path: string, options: RequestInit): Promise<Response> {
  const request = () => fetch(`${API}${path}`, { ...options, credentials: "include", headers: { ...(options.body instanceof FormData ? {} : { "content-type": "application/json" }), ...options.headers } });
  let response = await request();
  if (response.status === 401 && !path.startsWith("/auth/")) {
    refreshRequest ??= fetch(`${API}/auth/refresh`, { method: "POST", credentials: "include" })
      .then(result => result.ok).finally(() => { refreshRequest = undefined; });
    if (await refreshRequest) response = await request();
    if (response.status === 401) {
      localStorage.removeItem("nbboss-user");
      if (location.pathname !== "/login") location.assign("/login");
    }
  }
  return response;
}

async function checkResponse(response: Response) {
  if (response.ok) return;
  const error = await response.json().catch(() => ({ message: response.statusText }));
  const message = Array.isArray(error.message) ? error.message.join("，") : error.message ?? "请求失败";
  throw new Error(error.traceId ? `${message}（参考编号：${error.traceId}）` : message);
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await authenticatedFetch(path, options);
  await checkResponse(response);
  return response.status === 204 ? undefined as T : response.json();
}

export async function streamMessage(conversationId: string, content: string, webSearch: boolean, onEvent: (event: any) => void, signal: AbortSignal) {
  const response = await authenticatedFetch(`/conversations/${conversationId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, webSearch }), signal });
  await checkResponse(response);
  if (!response.body) throw new Error("无法建立对话流");
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; let terminal = false;
  function dispatch(frame: string) {
    const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    const event = JSON.parse(data);
    if (["run.completed", "run.failed", "run.aborted"].includes(event.type)) terminal = true;
    onEvent(event);
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let separator: number;
      while ((separator = buffer.indexOf("\n\n")) >= 0) { dispatch(buffer.slice(0, separator)); buffer = buffer.slice(separator + 2); }
      if (done) break;
    }
    if (buffer.trim()) dispatch(buffer);
    if (!terminal) throw new Error("对话连接中断，正在核对后台状态，请勿重复发送");
  } finally { reader.releaseLock(); }
}
