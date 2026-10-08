import { expect, test, type Page } from '@playwright/test';

async function mockWorkspace(page:Page) {
  await page.addInitScript(() => localStorage.setItem('nbboss-user',JSON.stringify({id:'ui-test',username:'界面测试'})));
  const entities=[
    {id:'place',type:'LOCATION',canonicalName:'办公地点',facts:[
      {id:'place-current',attribute:'城市',value:'杭州',createdAt:'2026-10-01',sourceType:'USER',userEdited:true,evidence:'办公地点已迁至杭州'},
      {id:'place-old',attribute:'城市',value:'上海',createdAt:'2026-09-01',sourceType:'CONVERSATION',supersededById:'place-current',userEdited:false}
    ]},
    {id:'person',type:'PERSON',canonicalName:'项目负责人',facts:[{id:'person-current',attribute:'姓名',value:'王芳',createdAt:'2026-10-02',sourceType:'MEETING',userEdited:false,evidence:'由王芳跟进验收'}]}
  ];
  const todos=[
    {id:'late',title:'确认交付范围',description:'与客户确认',owner:'王芳',dueAt:'2000-01-01T09:00:00Z',status:'PENDING',meeting:{title:'项目周会'}},
    {id:'future',title:'准备验收资料',description:'准备文档',owner:'李明',dueAt:'2099-01-01T09:00:00Z',status:'IN_PROGRESS',meeting:{title:'验收讨论'}},
    {id:'done',title:'完成需求整理',description:'已归档',owner:'王芳',dueAt:'2000-01-01T09:00:00Z',status:'COMPLETED',meeting:{title:'需求讨论'}},
    {id:'undated',title:'补充项目说明',description:'等待确认时间',owner:'王芳',status:'PENDING',meeting:{title:'项目周会'}}
  ];
  await page.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/memories')return route.fulfill({json:entities});
    if(path==='/api/todos')return route.fulfill({json:todos});
    if(path==='/api/health/ready')return route.fulfill({json:{worker:'online'}});
    if(path==='/api/health/capabilities')return route.fulfill({json:{search:false}});
    if(path.startsWith('/api/conversations/')&&!path.endsWith('/messages'))return route.fulfill({json:{id:'test-chat',title:'项目讨论',mode:'CHAT',messages:[],files:[],meetings:[],presentations:[],runs:[]}});
    return route.fulfill({json:[]});
  });
}

test('knowledge filters search evidence, reveal history, and survive auxiliary endpoint failures',async({page})=>{
  await mockWorkspace(page);
  await page.route('**/api/memories/tasks',route=>route.fulfill({status:503,json:{message:'任务服务暂不可用'}}));
  await page.goto('/memories');
  await expect(page.locator('.fact')).toHaveCount(2);
  await expect(page.getByText('上海',{exact:true})).toHaveCount(0);
  await page.getByLabel('包含历史记录').check();
  await expect(page.locator('.fact')).toHaveCount(3);
  await page.getByLabel('搜索记忆').fill('验收');
  await expect(page.locator('.memory-card')).toHaveCount(1);
  await expect(page.locator('.memory-card')).toContainText('项目负责人');
  await page.getByLabel('记忆类型').selectOption('LOCATION');
  await expect(page.getByRole('heading',{name:'没有符合条件的记录'})).toBeVisible();
  await page.getByRole('button',{name:'重置筛选'}).click();
  await expect(page.locator('.fact')).toHaveCount(2);
  await page.getByLabel('记忆排序').selectOption('recent');
  await expect(page.locator('.memory-card').first()).toContainText('项目负责人');
});

test('todo filters exclude completed work from overdue and preserve failed form edits',async({page})=>{
  await mockWorkspace(page); await page.goto('/todos');
  await expect(page.locator('.todo-row')).toHaveCount(4);
  await page.getByLabel('仅看逾期').check();
  await expect(page.locator('.todo-row')).toHaveCount(1);
  await expect(page.locator('.todo-row')).toContainText('确认交付范围');
  await page.getByRole('button',{name:'重置筛选',exact:true}).click();
  await page.getByLabel('搜索待办').fill('项目周会');
  await expect(page.locator('.todo-row')).toHaveCount(2);
  await page.getByLabel('截止日期起').fill('2098-01-01');
  await expect(page.locator('.todo-row')).toHaveCount(0);
  await page.getByRole('button',{name:'重置条件',exact:true}).click();
  await page.route('**/api/todos/late',route=>route.fulfill({status:503,json:{message:'保存服务暂不可用'}}));
  const statusControl=page.getByLabel('确认交付范围的状态');
  await statusControl.selectOption('COMPLETED');
  await expect(page.getByRole('alert')).toContainText('修改失败');
  await expect(statusControl).toHaveValue('PENDING');
  await page.locator('.todo-row').filter({hasText:'确认交付范围'}).getByTitle('编辑',{exact:true}).click();
  await page.getByLabel('待办标题',{exact:true}).fill('修改后仍需保留的标题');
  await page.getByRole('button',{name:'保存修改'}).click();
  await expect(page.getByRole('dialog')).toContainText('输入内容已保留');
  await expect(page.getByLabel('待办标题',{exact:true})).toHaveValue('修改后仍需保留的标题');
  page.once('dialog',dialog=>dialog.dismiss());
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('Chinese composition Enter does not send a message; chat load failures can retry',async({page})=>{
  await mockWorkspace(page);
  await page.route('**/api/conversations/test-chat',route=>route.fulfill({status:503,json:{message:'稍后重试'}}));
  await page.goto('/chat/test-chat');
  await expect(page.getByText('暂时无法加载此会话')).toBeVisible();
  await page.unroute('**/api/conversations/test-chat');
  await page.getByRole('button',{name:'重试',exact:true}).click();
  const input=page.getByPlaceholder('输入消息，Shift + Enter 换行');
  await input.fill('正在输入中文');
  await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});
  await expect(input).toHaveValue('正在输入中文');
  await expect(page.locator('.message.user')).toHaveCount(0);
});

test('desktop and mobile pages keep controls within the viewport',async({page})=>{
  await mockWorkspace(page);
  for(const width of [1440,1050,768,390]){
    await page.setViewportSize({width,height:900});
    for(const path of ['/','/memories','/todos','/chat/test-chat']){
      await page.goto(path);
      await expect(page.locator('.main')).toBeVisible();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),`${path} at ${width}px`).toBe(true);
    }
  }
});
