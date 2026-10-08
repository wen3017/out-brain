import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';

function fixture(action:string,input:unknown) {
 return JSON.parse(execFileSync(process.execPath,['e2e/fixture.cjs',action,Buffer.from(JSON.stringify(input)).toString('base64url')],{encoding:'utf8'}));
}

test('real logs enforce account isolation, bounded pagination, retention and safe metadata',async({page,playwright})=>{
 const suffix=Date.now().toString(36),password='LogTest123!';
 const response=await page.request.post('/api/auth/register',{data:{username:`logs_${suffix}`,password}});
 const {user}=await response.json();
 const other=await playwright.request.newContext({baseURL:'http://localhost:3000'});
 let otherUser:any;
 try {
  const registered=await other.post('/api/auth/register',{data:{username:`logs_b_${suffix}`,password}});otherUser=(await registered.json()).user;
  const conversation=await page.request.post('/api/conversations',{data:{mode:'CHAT',title:'private-document-title-should-not-be-logged'}});
  const traceId=conversation.headers()['x-request-id'];expect(traceId).toBeTruthy();
  await expect.poll(async()=>((await (await page.request.get(`/api/logs?q=${traceId}`)).json()).items.length)).toBe(1);
  const own=(await (await page.request.get(`/api/logs?q=${traceId}`)).json()).items[0];
  expect(own.operation).toBe('POST /api/conversations');
  expect(JSON.stringify(own)).not.toContain('private-document-title');expect(JSON.stringify(own)).not.toContain(password);
  expect((await other.get(`/api/logs/${own.id}`)).status()).toBe(404);
  expect((await (await other.get(`/api/logs?q=${traceId}&userId=${user.id}`)).json()).items).toHaveLength(0);
  for(const query of ['limit=1000','cursor=invalid','level=DEBUG','from=invalid','from=2026-10-03T00:00:00Z&to=2026-10-01T00:00:00Z'])expect((await page.request.get(`/api/logs?${query}`)).status()).toBe(400);
  const retentionDays=(await (await page.request.get('/api/logs')).json()).retentionDays;
  fixture('seed-logs',{userId:user.id,retentionDays});
  const first=await (await page.request.get('/api/logs?q=test.log_page')).json();
  expect(first.total).toBe(52);expect(first.items).toHaveLength(50);expect(first.counts.ERROR).toBe(1);
  const second=await (await page.request.get(`/api/logs?q=test.log_page&cursor=${first.nextCursor}`)).json();
  expect(second.items).toHaveLength(2);expect(second.nextCursor).toBeNull();
  expect(new Set([...first.items,...second.items].map((entry:any)=>entry.id)).size).toBe(52);
  expect((await (await page.request.get('/api/logs?q=test.expired_log')).json()).items).toHaveLength(0);
 } finally {await other.dispose();fixture('cleanup-user',{userId:user.id});if(otherUser)fixture('cleanup-user',{userId:otherUser.id});}
});

test('log page filters, expands, paginates and exports only the displayed page',async({page})=>{
 const response=await page.request.post('/api/auth/register',{data:{username:`logui_${Date.now().toString(36)}`,password:'LogTest123!'}});
 const {user}=await response.json();
 try {
  await page.addInitScript(value=>localStorage.setItem('nbboss-user',JSON.stringify(value)),user);
  const retentionDays=(await (await page.request.get('/api/logs')).json()).retentionDays;
  fixture('seed-logs',{userId:user.id,retentionDays});
  await page.goto('/logs');await page.getByLabel('搜索日志').fill('test.log_page');await page.getByRole('button',{name:'查询',exact:true}).click();
  await expect(page.locator('.log-table tbody>tr')).toHaveCount(50);
  await page.getByRole('button',{name:'下一页'}).click();await expect(page.locator('.log-table tbody>tr')).toHaveCount(2);
  await expect(page.getByRole('button',{name:'下一页'})).toBeDisabled();
  await page.getByRole('button',{name:'上一页'}).click();await expect(page.locator('.log-table tbody>tr')).toHaveCount(50);
  await page.getByLabel('日志级别').selectOption('ERROR');await expect(page.locator('.log-table tbody>tr')).toHaveCount(1);
  await page.getByRole('button',{name:/日志详情/}).click();await expect(page.locator('.log-detail')).toContainText('TIMEOUT');
  const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'导出当前页'}).click();
  const download=await downloadPromise;expect(download.suggestedFilename()).toMatch(/nbboss-logs-.*page-1.json/);
  const stream=await download.createReadStream();const chunks:Buffer[]=[];for await(const chunk of stream!)chunks.push(Buffer.from(chunk));
  const exported=JSON.parse(Buffer.concat(chunks).toString());expect(exported.items).toHaveLength(1);expect(exported.scope).toBe('current-page');
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByLabel('日志开始时间').fill('2026-10-20T00:00');await page.getByLabel('日志结束时间').fill('2026-10-01T00:00');await page.getByRole('button',{name:'查询',exact:true}).click();await expect(page.getByRole('alert')).toContainText('开始时间不能晚于结束时间');
 } finally {fixture('cleanup-user',{userId:user.id});}
});
