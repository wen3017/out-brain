import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { PrismaClient } = require('@prisma/client');
const { Queue } = require('bullmq');
try { process.loadEnvFile('.env'); } catch { /* injected environment */ }
const prisma = new PrismaClient();
const queue = new Queue('nbboss', {connection:{url:process.env.REDIS_URL}});
const run = promisify(execFile);
// A Node child of PowerShell 7 can inherit module paths incompatible with
// Windows PowerShell 5.1, preventing its Security module from loading DPAPI.
const windowsShellEnvironment={...process.env};
for(const key of Object.keys(windowsShellEnvironment))if(key.toLowerCase()==='psmodulepath')delete windowsShellEnvironment[key];
const report = {date:new Date().toISOString(),cases:{}};
let cookie='', user, stopped=false;
async function api(path,body) {
  const response=await fetch('http://127.0.0.1:3001/api'+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(240000)});
  if(path==='/auth/register')cookie=response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  if(!response.ok)throw Error(`${path}: HTTP ${response.status}`);
  return response.headers.get('content-type')?.includes('event-stream')?response.text():response.json();
}
async function poll(get,done,seconds=240) {
  const end=Date.now()+seconds*1000;
  while(Date.now()<end){const value=await get();if(done(value))return value;await new Promise(resolve=>setTimeout(resolve,500));}
  throw Error('Acceptance polling timeout');
}
async function chat(id,content) {
  const raw=await api(`/conversations/${id}/messages`,{content,webSearch:false});
  if(raw.includes('"type":"run.failed"'))throw Error('Chat run failed');
  await poll(()=>api('/memories/tasks'),tasks=>tasks.length>0&&tasks.every(t=>['READY','FAILED'].includes(t.status)));
  const tasks=await api('/memories/tasks');
  if(tasks.some(t=>t.status==='FAILED'))throw Error('Memory extraction failed');
}
async function restart(){await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/windows/start.ps1','-NoOpen'],{windowsHide:true,env:windowsShellEnvironment,timeout:180000});stopped=false;}
try {
  ({user}=await api('/auth/register',{username:`recovery_${Date.now()}`,password:'Acceptance123!'}));
  const conversation=await api('/conversations',{mode:'CHAT',title:'明确采纳建议验收'});
  if(!process.argv.includes('--recovery-only')) {
  const proposal='建议由陈清于2026年11月6日在苏州主持青禾项目培训。这只是建议，尚未得到用户确认。';
  await prisma.message.create({data:{conversationId:conversation.id,role:'ASSISTANT',content:proposal}});
  await chat(conversation.id,'我知道了，先保留这个建议让我考虑，目前不确认也不执行。');
  if(JSON.stringify(await api('/memories')).includes('青禾'))throw Error('Unconfirmed proposal saved as a fact');
  // Seed the immediately preceding proposal to make the confirmation reference unambiguous.
  await prisma.message.create({data:{conversationId:conversation.id,role:'ASSISTANT',content:proposal}});
  await chat(conversation.id,'我明确确认采用你刚才的建议，请将其记录为已经确认的未来计划。');
  const facts=await api('/memories');report.cases.confirmedProposal=facts;
  const planFacts=facts.flatMap(entity=>entity.facts).filter(f=>/青禾|陈清|苏州/.test(f.value+' '+f.evidence));
  if(!planFacts.some(f=>/计划|拟|将/.test(f.value)))throw Error('Confirmed future plan not retained');
  if(planFacts.some(f=>/已主持|已完成|已经参加/.test(f.value)))throw Error('Future plan represented as completed');
  const ambiguous=await api('/conversations',{mode:'CHAT',title:'歧义指代验收'});
  await chat(ambiguous.id,'资料只说“他负责玄武项目”，这里的“他”没有指代信息，不能确定姓名，也不要猜测。');
  if(JSON.stringify(await api('/memories')).includes('玄武'))throw Error('Ambiguous owner stored as a fact');
  report.cases.ambiguousReferenceFiltered=true;
  console.log('Real confirmed-plan and ambiguous-reference checks passed.');
  }
  if(process.argv.includes('--interrupt-worker')) {
    const active=await queue.getJobs(['active','wait','delayed']);
    if(active.length)throw Error('Refusing to interrupt Worker while other jobs exist');
    const source=await prisma.agentRun.create({data:{userId:user.id,conversationId:conversation.id,model:'acceptance-source',status:'COMPLETED'}});
    const task=await prisma.memoryExtraction.create({data:{userId:user.id,sourceType:'CONVERSATION',sourceId:source.id,text:'请记住真实事实：恢复测试负责人周宁负责松柏项目，该项目的下一次会议计划于2026年11月8日在成都举行。',observedAt:new Date()}});
    const job=await queue.add('memory.extract',{taskId:task.id,userId:user.id},{jobId:`memory-${task.id}`,attempts:3,removeOnComplete:false});
    await poll(()=>prisma.memoryExtraction.findUnique({where:{id:task.id}}),value=>value.status==='PROCESSING',30);
    const soleActive=await queue.getJobs(['active']);
    if(soleActive.length!==1||soleActive[0].id!==job.id)throw Error('Worker is not exclusively processing this test task');
    await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',". ./scripts/windows/common.ps1; Stop-ManagedService 'worker'"],{windowsHide:true,timeout:30000});
    stopped=true;
    const redis=await queue.client;
    const lock=queue.toKey(`${job.id}:lock`);
    const ttl=await redis.pttl(lock);
    if(await job.getState()!=='active'||ttl<=0)throw Error('Test task was not active at interruption');
    // Accelerate only this now-abandoned test lease; do not change production lease settings.
    await redis.pexpire(lock,1);
    report.cases.workerInterruption={jobId:job.id,originalLeaseRemainingMs:ttl,acceleratedTestLease:true};
    console.log('Owned Worker stopped during real extraction; restarting after test lease expiry.');
    if(!process.argv.includes('--external-restart'))await restart();
    else console.log('Run scripts/windows/start.ps1 -NoOpen from the owning Windows shell now.');
    const recovered=await poll(()=>prisma.memoryExtraction.findUnique({where:{id:task.id}}),value=>['READY','FAILED'].includes(value.status),300);
    if(recovered.status!=='READY')throw Error('Interrupted extraction did not recover');
    stopped=false;
    const recoveredFacts=await api('/memories');
    if(!JSON.stringify(recoveredFacts).includes('松柏'))throw Error('Recovered task has no expected facts');
    report.cases.workerInterruption.status=recovered.status;
    report.cases.workerInterruption.queueStatus=await poll(()=>job.getState(),value=>value==='completed',30);
    await job.remove();
    console.log('Interrupted real Worker task recovered to READY and completed.');
  }
  report.ok=true;
} catch(error) { report.error=error.message;process.exitCode=1;console.error(error.message); }
finally {
  if(stopped&&!process.argv.includes('--external-restart'))try{await restart();}catch{report.restartFailed=true;process.exitCode=1;}
  await mkdir('.local',{recursive:true});await writeFile('.local/memory-recovery-acceptance.json',JSON.stringify(report,null,2));
  if(user)await prisma.user.deleteMany({where:{id:user.id}});
  await queue.close();await prisma.$disconnect();
}
