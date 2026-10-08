import { afterEach, describe, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";
import { MailService } from "../src/modules/mail/mail.service.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("SMTP delivery semantics (no external mail)", () => {
  function fixture(send = vi.fn(async () => ({accepted:["review@example.test"],rejected:[]}))) {
    for (const [key,value] of Object.entries({SMTP_ENABLED:"true",SMTP_PROVIDER:"smtp",SMTP_HOST:"smtp.example.test",SMTP_TO:"review@example.test",SMTP_FROM:"sender@example.test"})) vi.stubEnv(key,value);
    const close = vi.fn();
    vi.spyOn(nodemailer,"createTransport").mockReturnValue({sendMail:send,close} as any);
    const update = vi.fn(async ({data}:any)=>data);
    const service = new MailService({emailDelivery:{update}} as any);
    const deliver = () => service.sendMeetingSummary("meeting","测试会议",[{description:"截止日期未确认",evidence:[{quote:"日期待定"}]}],[{title:"确认日期",owner:"王芳"}],"delivery");
    return {send,close,update,service,deliver};
  }
  it("records server acceptance separately from inbox verification and escapes source HTML", async () => {
    const f=fixture();
    expect(await f.deliver()).toMatchObject({status:"SENT",attempts:1,errorCode:null});
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
  });
  it.each([
    {code:"ETIMEDOUT",command:"DATA"},
    {code:"ESOCKET",command:"DATA"},
    {},
  ])("does not automatically resend uncertain delivery: %j", async metadata => {
    const send=vi.fn(async()=>{throw Object.assign(new Error("private diagnostic"),metadata);});
    const f=fixture(send);
    expect(await f.deliver()).toMatchObject({status:"FAILED",attempts:1,errorCode:"DELIVERY_UNCERTAIN_CHECK_INBOX"});
    expect(send).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.update.mock.calls)).not.toContain("private diagnostic");
  });
  it("does not resend after SMTP acceptance followed by a database failure", async () => {
    const f=fixture(); f.update.mockRejectedValue(new Error("database unavailable"));
    await expect(f.deliver()).rejects.toThrow("database unavailable");
    expect(f.send).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce();
  });
  it("does not retry permanent authentication errors", async () => {
    const f=fixture(vi.fn(async()=>{throw Object.assign(new Error("secret"),{code:"EAUTH",responseCode:535});}));
    expect(await f.deliver()).toMatchObject({status:"FAILED",attempts:1,errorCode:"SMTP_AUTH_FAILED"});
    expect(f.send).toHaveBeenCalledOnce();
  });
  it("reports partial acceptance without resending to already accepted recipients", async () => {
    const f=fixture(vi.fn(async()=>({accepted:["a@example.test"],rejected:["b@example.test"]})));
    expect(await f.deliver()).toMatchObject({status:"FAILED",errorCode:"DELIVERY_PARTIAL_CHECK_INBOX"});
    expect(f.send).toHaveBeenCalledOnce();
  });
  it("requires inbox verification before retrying an uncertain delivery", async () => {
    const updateMany=vi.fn(async()=>({count:1}));
    const service=new MailService({emailDelivery:{findFirst:async()=>({meetingId:"m"}),updateMany}} as any);
    vi.spyOn(service,"available").mockReturnValue(true);
    vi.spyOn(service,"enqueueSummary").mockResolvedValue({id:"d",status:"FAILED",errorCode:"DELIVERY_UNCERTAIN_CHECK_INBOX"} as any);
    expect(await service.retry("u","c","d")).toMatchObject({queued:false,requiresInboxCheck:true});
    expect(updateMany).not.toHaveBeenCalled();
    expect(await service.retry("u","c","d",true)).toEqual({queued:true});
  });
  it("suppresses duplicate sent summaries and sends no message for risk-free meetings", async () => {
    const updateMany=vi.fn();
    const service=new MailService({meeting:{findUnique:async()=>({risks:[],todos:[],archived:false})},emailDelivery:{findFirst:async()=>({meetingId:"m"}),updateMany}} as any);
    expect(await service.enqueueSummary("m")).toBeUndefined();
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({data:{status:"CANCELLED",errorCode:"NO_CURRENT_RISKS"}}));
    updateMany.mockClear();
    vi.spyOn(service,"available").mockReturnValue(true);
    vi.spyOn(service,"enqueueSummary").mockResolvedValue({status:"SENT"} as any);
    expect(await service.retry("u","c","d")).toMatchObject({queued:false});
    expect(updateMany).not.toHaveBeenCalled();
  });
});
