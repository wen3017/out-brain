import {test,expect,type Page} from '@playwright/test';
import {execFileSync} from 'node:child_process';
function fixture(action:string,input:unknown){return JSON.parse(execFileSync(process.execPath,['e2e/fixture.cjs',action,Buffer.from(JSON.stringify(input)).toString('base64url')],{encoding:'utf8'}));}
async function setup(page:Page){
 const suffix=`${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
 const {user}=await (await page.request.post('/api/auth/register',{data:{username:`edit_${suffix}`,password:'Edit12345!'}})).json();
 await page.addInitScript(value=>localStorage.setItem('nbboss-user',JSON.stringify(value)),user);
 const conversation=await (await page.request.post('/api/conversations',{data:{mode:'MEETING',title:'编辑恢复'}})).json();
 return {user,...fixture('seed-artifacts',{userId:user.id,conversationId:conversation.id,suffix})};
}
test('PPT keeps edits after save failure and prevents silent version loss or stale downloads',async({page})=>{
 const seeded=await setup(page);
 try{
  await page.goto(`/presentations/${seeded.presentationId}`);
  const text=page.locator('.slide-canvas textarea');await text.fill('必须保留的修改');
  await expect(page.getByText('· 有未保存修改',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'下载',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('先保存新版本');
  page.once('dialog',dialog=>dialog.dismiss());
  await page.locator('.version').first().click();await expect(text).toHaveValue('必须保留的修改');
  page.once('dialog',dialog=>dialog.dismiss());
  await page.getByRole('button',{name:'待办中心',exact:true}).click();await expect(page).toHaveURL(new RegExp(`/presentations/${seeded.presentationId}$`));
  page.once('dialog',dialog=>dialog.dismiss());
  await page.getByTitle('退出',{exact:true}).click();
  await expect(text).toHaveValue('必须保留的修改');
  expect((await page.request.get('/api/memories')).status()).toBe(200);
  const path=`**/api/presentations/${seeded.presentationId}/versions`;
  await page.route(path,route=>route.request().method()==='POST'?route.fulfill({status:503,json:{message:'暂时无法保存'}}):route.continue());
  await page.getByRole('button',{name:'保存新版本'}).click();
  await expect(page.getByRole('alert')).toContainText('当前修改仍保留');await expect(text).toHaveValue('必须保留的修改');
  await page.unroute(path);await page.getByRole('button',{name:'保存新版本'}).click();
  await expect(page.getByRole('status')).toHaveText('已保存为版本 2');
  await page.getByRole('button',{name:'待办中心',exact:true}).click();await expect(page).toHaveURL(/\/todos$/);
 }finally{fixture('cleanup-user',{userId:seeded.user.id});}
});
test('todo invalid dates and failed memory edits display actionable errors without changing data',async({page})=>{
 const seeded=await setup(page);
 try{
  await page.goto('/todos');
  await page.getByLabel('截止日期起').fill('2026-10-20');
  await page.getByLabel('截止日期止').fill('2026-10-01');
  await expect(page.getByRole('alert')).toContainText('开始日期不能晚于结束日期');
  await page.getByRole('button',{name:'重置条件',exact:true}).click();
  await expect(page.locator('.todo-row')).toContainText('截止：待确认');
  await page.getByRole('button',{name:'记忆管理',exact:true}).click();
  await page.route('**/api/memories/facts/*',route=>route.fulfill({status:503,json:{message:'暂时无法更新'}}));
  await page.getByTitle('编辑记忆').click();
  await page.getByLabel('记忆内容').fill('苏州');
  await page.getByRole('button',{name:'保存修改'}).click();
  await expect(page.getByRole('alert')).toContainText('修改失败');await expect(page.getByLabel('记忆内容')).toHaveValue('苏州');
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await expect(page.locator('.fact').filter({hasText:'杭州'})).toBeVisible();
 }finally{fixture('cleanup-user',{userId:seeded.user.id});}
});
