import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";

test("a PPT queued from chat becomes ready without refreshing the page", async ({ page }) => {
  const response = await page.request.post('/api/auth/register', { data: { username: `poll_${Date.now()}`, password: 'Polling123!' } });
  const { user } = await response.json();
  await page.addInitScript(value => localStorage.setItem('nbboss-user', JSON.stringify(value)), user);
  const created = await page.request.post('/api/conversations', { data: { mode: 'CHAT', title: 'PPT 状态回归' } });
  const conversation = await created.json();
  let queued = false; let reads = 0;
  try {
    await page.route(`**/api/conversations/${conversation.id}`, async route => {
      if (queued) reads++;
      await route.fulfill({ json: { ...conversation, messages: [], files: [], meetings: [], presentations: queued ? [{ id:'test-ppt', title:'聊天生成的演示稿', status: reads < 3 ? 'PROCESSING' : 'READY', progress: reads < 3 ? 20 : 100, versions: reads < 3 ? [] : [{id:'version-1'}] }] : [] } });
    });
    await page.route(`**/api/conversations/${conversation.id}/messages`, async route => {
      queued = true;
      const events = [{ type:'tool.completed', toolName:'generate_presentation', toolCallId:'ppt-call' },{type:'message.completed', content:'PPT 已提交后台生成'}, {type:'run.completed'}];
      await route.fulfill({ contentType:'text/event-stream', body:events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join('') });
    });
    await page.goto(`/chat/${conversation.id}`);
    await page.getByPlaceholder('输入消息，Shift + Enter 换行').fill('根据当前对话生成 PPT');
    await page.getByPlaceholder('输入消息，Shift + Enter 换行').press('Enter');
    await expect(page.getByText('后台生成中 · 20%')).toBeVisible();
    await expect(page.getByText('1 个版本 · 可预览编辑')).toBeVisible({ timeout:12000 });
    expect(reads).toBeGreaterThanOrEqual(3);
  } finally {
    execFileSync(process.execPath,['e2e/fixture.cjs','cleanup-user',Buffer.from(JSON.stringify({userId:user.id})).toString('base64url')]);
  }
});
