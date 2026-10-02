import { afterEach, describe, expect, it, vi } from "vitest";
import { api, streamMessage } from "./api";

afterEach(() => vi.unstubAllGlobals());
const response = (status=200) => new Response(JSON.stringify({ok:true}), {status,headers:{"content-type":"application/json"}});
const stream = (data:string) => new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(data));controller.close();}}));
describe("authenticated requests and stream completion",()=>{
  it("coalesces simultaneous 401 refreshes and retries each request once",async()=>{
    let calls=0,refreshes=0;
    vi.stubGlobal("fetch",vi.fn(async(url:string)=>{
      if(url.endsWith("/auth/refresh")){refreshes++;await new Promise(r=>setTimeout(r,10));return response();}
      return response(++calls<=2?401:200);
    }));
    await Promise.all([api("/conversations"),api("/todos")]);
    expect(refreshes).toBe(1);expect(calls).toBe(4);
  });
  it("bounds refresh retries and redirects without erasing session drafts",async()=>{
    const assign=vi.fn();vi.stubGlobal("location",{pathname:"/chat/a",assign});vi.stubGlobal("localStorage",{removeItem:vi.fn()});
    let calls=0;vi.stubGlobal("fetch",vi.fn(async(url:string)=>{calls++;return response(url.endsWith("/auth/refresh")?200:401);}));
    await expect(api("/conversations")).rejects.toThrow();expect(calls).toBe(3);expect(assign).toHaveBeenCalledWith("/login");
  });
  it("refreshes before opening a stream and processes terminal events",async()=>{
    let calls=0;const events:any[]=[];
    vi.stubGlobal("fetch",vi.fn(async(url:string)=>url.endsWith("/auth/refresh")?response():++calls===1?response(401):stream('data: {"type":"run.started"}\r\n\r\ndata: {"type":"run.completed"}\r\n\r\n')));
    await streamMessage("a","hello",false,e=>events.push(e),new AbortController().signal);
    expect(calls).toBe(2);expect(events.map(e=>e.type)).toEqual(["run.started","run.completed"]);
  });
  it("does not resubmit a stream that closes before a terminal event",async()=>{
    const fetch=vi.fn(async()=>stream('data: {"type":"message.delta","delta":"部分回复"}\n\n'));vi.stubGlobal("fetch",fetch);
    await expect(streamMessage("a","hello",false,()=>{},new AbortController().signal)).rejects.toThrow("连接中断");expect(fetch).toHaveBeenCalledTimes(1);
  });
});
