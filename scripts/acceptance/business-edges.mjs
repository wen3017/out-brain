import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
const base='http://127.0.0.1:3001/api';let cookie='',user;
const report={date:new Date().toISOString(),cases:{}};
async function api(path,body){
 const response=await fetch(base+path,{method:body?'POST':'GET',headers:{cookie,...(body instanceof FormData?{}:{'content-type':'application/json'})},body:body instanceof FormData?body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(240000)});
 if(path==='/auth/register')cookie=response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
 if(!response.ok)throw Error(`${path}: HTTP ${response.status}`);
 return response.headers.get('content-type')?.includes('event-stream')?response.text():response.json();
}
async function poll(get,done,seconds=420){const end=Date.now()+seconds*1000;while(Date.now()<end){const value=await get();if(done(value))return value;await new Promise(r=>setTimeout(r,2000));}throw Error('Acceptance polling timeout');}
try {
 await mkdir('.local',{recursive:true});
 ({user}=await api('/auth/register',{username:`edges_${Date.now()}`,password:'Acceptance123!'}));
 if(!process.argv.includes('--ppt-only')) {
 const meeting=await api('/conversations',{mode:'MEETING',title:'长材料末段与否定承诺验收'});
 const header='2026年10月2日在南京召开松柏项目例会，周宁和王芳参加。明确澄清：王芳没有承诺交付验收方案，该事项没有分配给她，不应为她创建交付待办。以下附录是参考记录，不包含新的会议决定。\n';
 const tail='\n会议最后的唯一未决风险：周宁明确承诺交付松柏项目测试报告，但截至本次会议仍未确定交付截止日期，需要周宁会后确认该日期。';
 const content=header+'reference_only_no_decisions; '.repeat(4000)+tail;
 if(content.length>120000)throw Error('Fixture exceeds supported character limit');
 report.cases.longMeeting={characters:content.length,tailQuote:tail.trim(),negatedCommitment:header};
 const form=new FormData();form.append('files',new Blob([content],{type:'text/plain'}),'long-tail.txt');
 await api(`/conversations/${meeting.id}/files/batch`,form);
 const analyzed=await poll(()=>api(`/conversations/${meeting.id}`),v=>['READY','FAILED'].includes(v.meetingStatus));
 if(analyzed.meetingStatus!=='READY')throw Error('Long meeting failed: '+analyzed.meetingErrorMessage);
 const active=analyzed.meetings.filter(m=>!m.archived);report.cases.longMeeting.result=active;
 const todos=active.flatMap(m=>m.todos);
 if(!todos.some(t=>t.owner==='周宁'&&/日期|截止/.test(t.title+' '+t.description)&&!t.dueAt))throw Error('Tail deadline risk was missed or invented');
 if(todos.some(t=>t.owner==='王芳'))throw Error('Negated commitment created an assigned todo');
 if(!active.flatMap(m=>m.risks).some(r=>JSON.stringify(r.evidence).includes('周宁')))throw Error('Tail evidence missing');
 console.log('Real long-meeting tail and negated-commitment checks passed.');
 }
 const ppt=await api('/conversations',{mode:'CHAT',title:'PPT 表格信息验收'});
 const raw=await api(`/conversations/${ppt.id}/messages`,{content:'请生成三页 PPT，标题“设备采购测算”，依次为采购范围、采购明细、总计。采购明细请用三列对齐的表格式布局呈现，三列为品名、数量（台）、单价（元/台）。确切数据：甲型设备 3 台，单价 1200 元/台；乙型设备 5 台，单价 800 元/台。甲型金额 3600 元，乙型金额 4000 元，总计 7600 元。只呈现这些已给数据，不添加税费、折扣、供应商或预算结论。',webSearch:false});
 if(raw.includes('"type":"run.failed"'))throw Error('Table PPT request failed');
 const completed=await poll(()=>api(`/conversations/${ppt.id}`),v=>v.presentations.length&&v.presentations.every(p=>['READY','FAILED'].includes(p.status)));
 const presentation=completed.presentations[0];if(presentation.status!=='READY')throw Error('Table PPT failed: '+presentation.errorMessage);
 const deck=await api(`/presentations/${presentation.id}/versions`);report.cases.tablePpt=deck.versions[0].slideJson;
 const text=JSON.stringify(report.cases.tablePpt);
 for(const value of ['甲型','乙型','1200','800','3600','4000','7600'])if(!text.includes(value))throw Error('PPT lost table value '+value);
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:960}});
  await context.addCookies(cookie.split('; ').map(item=>{const i=item.indexOf('=');return{name:item.slice(0,i),value:item.slice(i+1),url:'http://localhost:3000'};}));
  await context.addInitScript(value=>localStorage.setItem('nbboss-user',JSON.stringify(value)),user);
  const page=await context.newPage();await page.goto(`http://localhost:3000/presentations/${presentation.id}`);await page.locator('.slide-canvas').waitFor();
  for(let i=0;i<3;i++){
   await page.locator('.slide-list > button').nth(i).click();
   if(await page.locator('.slide-element textarea').evaluateAll(nodes=>nodes.some(n=>n.scrollHeight>n.clientHeight+2||n.scrollWidth>n.clientWidth+2)))throw Error('PPT table text overflow');
   await page.locator('.slide-canvas').screenshot({path:`.local/table-ppt-${i+1}.png`});
  }
 }finally{await browser.close();}
 report.ok=true;console.log('Real table-data PPT generated; visual review still required.');
}catch(error){report.error=error.message;process.exitCode=1;console.error(error.message);}
finally{await writeFile('.local/business-edges-acceptance.json',JSON.stringify(report,null,2));if(user)execFileSync(process.execPath,['e2e/fixture.cjs','cleanup-user',Buffer.from(JSON.stringify({userId:user.id})).toString('base64url')]);}
