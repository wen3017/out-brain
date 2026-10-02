import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";

test("oversized TXT is rejected visibly before a partial asset is created",async({page})=>{
  const response=await page.request.post('/api/auth/register',{data:{username:`limit_${Date.now()}`,password:'Limit123!'}});
  const {user}=await response.json();
  await page.addInitScript(value=>localStorage.setItem('nbboss-user',JSON.stringify(value)),user);
  const conversation=await (await page.request.post('/api/conversations',{data:{mode:'MEETING',title:'材料长度边界'}})).json();
  try{
    await page.goto(`/chat/${conversation.id}`);
    await page.locator('input[type=file]').setInputFiles({name:'too-long.txt',mimeType:'text/plain',buffer:Buffer.from('字'.repeat(120001))});
    await expect(page.locator('.error').filter({hasText:/120[,.]?000/}).first()).toBeVisible();
    const detail=await (await page.request.get(`/api/conversations/${conversation.id}`)).json();
    expect(detail.files).toHaveLength(0);
  }finally{execFileSync(process.execPath,['e2e/fixture.cjs','cleanup-user',Buffer.from(JSON.stringify({userId:user.id})).toString('base64url')]);}
});

test("streams, drafts and upload batches remain bound to their original conversation",async({page})=>{
  const response=await page.request.post('/api/auth/register',{data:{username:`scope_${Date.now()}`,password:'Scope123!'}});
  const {user}=await response.json();await page.addInitScript(value=>localStorage.setItem('nbboss-user',JSON.stringify(value)),user);
  const a=await (await page.request.post('/api/conversations',{data:{mode:'MEETING',title:'会话 A'}})).json();
  const b=await (await page.request.post('/api/conversations',{data:{mode:'CHAT',title:'会话 B'}})).json();
  let releaseStream!:()=>void,releaseUpload!:()=>void;const streamWait=new Promise<void>(r=>releaseStream=r),uploadWait=new Promise<void>(r=>releaseUpload=r);
  let started=false,uploaded=false,completed=false;const uploads:string[]=[];
  try{
    await page.route(`**/api/conversations/${a.id}`,route=>route.fulfill({json:{...a,messages:completed?[{id:'a-result',role:'ASSISTANT',content:'只属于 A 的最终结果',status:'COMPLETED'}]:[],files:[],meetings:[],presentations:[],runs:started?[{id:'run-a',status:completed?'COMPLETED':'RUNNING'}]:[]}}));
    await page.route(`**/api/conversations/${b.id}`,route=>route.fulfill({json:{...b,messages:[],files:[],meetings:[],presentations:[],runs:[]}}));
    await page.route(`**/api/conversations/${a.id}/messages`,async route=>{started=true;await streamWait;completed=true;await route.fulfill({contentType:'text/event-stream',body:'data: {"type":"run.started","runId":"run-a"}\n\ndata: {"type":"message.delta","delta":"只属于 A 的流"}\n\ndata: {"type":"run.completed"}\n\n'}).catch(()=>{});});
    await page.route('**/api/conversations/*/files/batch',async route=>{uploads.push(route.request().url());const body=route.request().postDataBuffer()?.toString()??'';expect(body).toContain('one.txt');expect(body).toContain('two.txt');expect(body).toContain('three.txt');uploaded=true;await uploadWait;await route.fulfill({json:[]}).catch(()=>{});});
    await page.goto(`/chat/${a.id}`);
    await page.locator('input[type=file]').setInputFiles(['one','two','three'].map(name=>({name:`${name}.txt`,mimeType:'text/plain',buffer:Buffer.from('会议原文')})));
    await expect.poll(()=>uploaded).toBe(true);
    const input=page.getByPlaceholder('输入消息，Shift + Enter 换行');await input.fill('分析 A');await input.press('Enter');await expect.poll(()=>started).toBe(true);
    await page.getByRole('button',{name:'会话 B',exact:true}).click();await input.fill('B 的未发送草稿');
    releaseStream();releaseUpload();await expect(page.locator('.chat-header h2')).toHaveText('会话 B');
    await expect(page.getByText('只属于 A 的流')).toHaveCount(0);expect(uploads).toEqual([expect.stringContaining(`/conversations/${a.id}/files/batch`)]);
    await page.getByRole('button',{name:'会话 A',exact:true}).click();await expect(page.getByText('只属于 A 的最终结果')).toBeVisible();
    await page.getByRole('button',{name:'会话 B',exact:true}).click();await expect(input).toHaveValue('B 的未发送草稿');
  }finally{releaseStream?.();releaseUpload?.();execFileSync(process.execPath,['e2e/fixture.cjs','cleanup-user',Buffer.from(JSON.stringify({userId:user.id})).toString('base64url')]);}
});

test("chat renews a missing access cookie through real refresh and keeps the message",async({page,context})=>{
  const response=await page.request.post('/api/auth/register',{data:{username:`renew_${Date.now()}`,password:'Renew123!'}});const {user}=await response.json();
  await page.addInitScript(value=>localStorage.setItem('nbboss-user',JSON.stringify(value)),user);
  const conversation=await (await page.request.post('/api/conversations',{data:{mode:'CHAT',title:'续期测试'}})).json();let attempts=0,refreshed=false;
  try{
    page.on('response',r=>{if(r.url().endsWith('/api/auth/refresh')&&r.status()>=200&&r.status()<300)refreshed=true;});
    await page.goto(`/chat/${conversation.id}`);const input=page.getByPlaceholder('输入消息，Shift + Enter 换行');await expect(input).toBeVisible();
    await context.clearCookies({name:'nbboss_access'});
    await page.route(`**/api/conversations/${conversation.id}/messages`,async route=>{
      attempts++;if(attempts===1){const r=await route.fetch();expect(r.status()).toBe(401);await route.fulfill({response:r});}
      else{expect(route.request().postDataJSON().content).toBe('闲置后仍能发送');await route.fulfill({contentType:'text/event-stream',body:'data: {"type":"run.started","runId":"renew-run"}\n\ndata: {"type":"run.completed"}\n\n'});}
    });
    await input.fill('闲置后仍能发送');await input.press('Enter');await expect.poll(()=>attempts).toBe(2);expect(refreshed).toBe(true);
    await expect(input).toHaveValue('');expect((await context.cookies()).some(c=>c.name==='nbboss_access')).toBe(true);
  }finally{execFileSync(process.execPath,['e2e/fixture.cjs','cleanup-user',Buffer.from(JSON.stringify({userId:user.id})).toString('base64url')]);}
});

test("expired refresh redirects to login with the unsent draft saved",async({page,context})=>{
  const response=await page.request.post('/api/auth/register',{data:{username:`draft_${Date.now()}`,password:'Draft123!'}});const {user}=await response.json();
  await page.addInitScript(value=>{if(!sessionStorage.getItem('acceptance-auth-seeded')){localStorage.setItem('nbboss-user',JSON.stringify(value));sessionStorage.setItem('acceptance-auth-seeded','true');}},user);
  const conversation=await (await page.request.post('/api/conversations',{data:{mode:'CHAT',title:'草稿测试'}})).json();
  try{
    await page.goto(`/chat/${conversation.id}`);const input=page.getByPlaceholder('输入消息，Shift + Enter 换行');await expect(input).toBeVisible();
    await context.clearCookies();await input.fill('登录失效也不能丢失的草稿');await input.press('Enter');await expect(page).toHaveURL(/\/login/);
    expect(await page.evaluate(id=>sessionStorage.getItem(`nbboss-draft:${id}`),conversation.id)).toBe('登录失效也不能丢失的草稿');
  }finally{execFileSync(process.execPath,['e2e/fixture.cjs','cleanup-user',Buffer.from(JSON.stringify({userId:user.id})).toString('base64url')]);}
});
