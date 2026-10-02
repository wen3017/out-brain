<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { marked } from "marked"; import DOMPurify from "dompurify";
import { api, streamMessage } from "../api";
import { Bot, Download, FileText, Globe2, Paperclip, Plus, Presentation, Send, Square, Trash2, Users } from "lucide-vue-next";

type Conversation = { id:string; title:string; mode:"CHAT"|"MEETING"; updatedAt:string };
type SearchSource = { title:string; url:string; snippet:string; retrievedAt:string };
type Message = { id:string; role:string; content:string; status:string; createdAt?:string; searchRuns?:Array<{id:string;query:string;searchedAt:string;sources:SearchSource[]}> };
type FileItem = { id:string; originalName:string; kind:string; status:string; errorMessage?:string; pages?:Array<{pageNo:number;extractionMethod:string;qualityStatus:string;qualityMessage?:string}> };
type Meeting = { archived?:boolean; id:string; title:string; analysis:any; risks:Array<{id:string;active?:boolean;severity:string;description:string;evidence:Array<{quote:string;fileName:string;page?:number}>}>; todos:Array<{id:string;title:string;owner:string;dueAt?:string}>; emails:Array<{id:string;status:string;errorCode?:string;sentAt?:string}> };
type PresentationItem = { id:string; title:string; status:"PENDING"|"PROCESSING"|"READY"|"FAILED"; progress:number; errorMessage?:string; versions:any[] };
type Detail = { id:string; title:string; mode:string; meetingStatus?:"PROCESSING"|"READY"|"FAILED"; meetingErrorMessage?:string; runs?:Array<{id:string;status:string;errorCode?:string}>; messages:Message[]; files:FileItem[]; meetings:Meeting[]; presentations:PresentationItem[] };

const route = useRoute(); const router = useRouter();
const conversations = ref<Conversation[]>([]); const detail = ref<Detail|null>(null); const content = ref(""); const webSearch = ref(false); const streaming = ref(false); const streamText = ref(""); const runId = ref(""); const error = ref(""); const fileInput = ref<HTMLInputElement>(); const scroll = ref<HTMLElement>(); const artifactOpen = ref(true); let aborter: AbortController | null = null; let streamEpoch = 0;
const draftKey = (id:string) => `nbboss-draft:${id}`;
function readDraft(id?:string) { return id ? sessionStorage.getItem(draftKey(id)) ?? "" : ""; }
const capabilities=ref({search:false,smtp:false,embedding:false,vision:false});

const currentId = computed(() => route.params.id as string | undefined);
const activeTools = ref<Array<{ id:string; name:string; status:"RUNNING"|"COMPLETED"|"FAILED" }>>([]);
function toolLabel(name:string) { return ({ read_meetings:"读取当前会议", retrieve_documents:"检索会话文件", retrieve_memory:"检索长期记忆", search_web:"联网搜索", analyze_meeting:"分析会议", create_todos:"创建待办", generate_presentation:"生成 PPT" } as Record<string,string>)[name] ?? name; }
async function loadList() { conversations.value = await api<Conversation[]>("/conversations"); }
async function loadDetail() { if (!currentId.value) { detail.value = null; return; } const id = currentId.value; const result = await api<Detail>(`/conversations/${id}`); if (id !== currentId.value || disposed) return; detail.value = result; const savedDraft=readDraft(id);const submittedAt=Number(sessionStorage.getItem(`${draftKey(id)}:submittedAt`));if(savedDraft && submittedAt && result.messages.some(m=>m.role==="USER" && m.content===savedDraft && m.createdAt && new Date(m.createdAt).valueOf()>=submittedAt-1000)){sessionStorage.removeItem(draftKey(id));sessionStorage.removeItem(`${draftKey(id)}:submittedAt`);if(content.value===savedDraft)content.value="";} if (!aborter) { const run = result.runs?.[0]; streaming.value = run?.status === "RUNNING"; runId.value = streaming.value ? run!.id : ""; } if (isBusy(result)) void pollPresentations(); await nextTick(); scroll.value?.scrollTo({ top: scroll.value.scrollHeight }); }
async function create(mode:"CHAT"|"MEETING") { const value = await api<Conversation>("/conversations", { method:"POST", body:JSON.stringify({ mode }) }); await loadList(); router.push(`/chat/${value.id}`); }
async function remove(id:string) { if (!confirm("删除后聊天、文件、索引、会议待办、PPT 及该会话来源的自动记忆均不可恢复；用户手工修正的记忆保留。确认删除？")) return; await api(`/conversations/${id}`, { method:"DELETE" }); await loadList(); if (currentId.value === id) router.push("/"); }
async function send() {
  if (!content.value.trim() || !currentId.value || streaming.value) return;
  const id = currentId.value; const text = content.value; const epoch = ++streamEpoch;
  sessionStorage.setItem(draftKey(id), text);sessionStorage.setItem(`${draftKey(id)}:submittedAt`,String(Date.now()));
  content.value = ""; streaming.value = true; streamText.value = ""; error.value = ""; runId.value = ""; activeTools.value = [];
  const controller = new AbortController(); aborter = controller;
  let accepted = false;
  const active = () => !disposed && epoch === streamEpoch && id === currentId.value;
  detail.value?.messages.push({ id:crypto.randomUUID(), role:"USER", content:text, status:"COMPLETED" });
  try {
    await streamMessage(id, text, webSearch.value, (event) => {
      if (event.type === "run.started" || event.type === "run.completed") { accepted = true; sessionStorage.removeItem(draftKey(id));sessionStorage.removeItem(`${draftKey(id)}:submittedAt`); }
      if (!active()) return;
      if (event.runId) runId.value = event.runId;
      if (event.type === "message.delta") streamText.value += event.delta;
      if (event.type === "message.completed") streamText.value = event.content;
      if (event.type === "tool.started") activeTools.value.push({id:event.toolCallId,name:event.toolName,status:"RUNNING"});
      if (event.type === "tool.completed") { const tool=activeTools.value.find(item=>item.id===event.toolCallId); if(tool)tool.status=event.isError?"FAILED":"COMPLETED"; }
      if (event.type === "run.failed") {error.value=event.message??"生成失败";if(!accepted)content.value=text;}
      nextTick(() => { if(active()) scroll.value?.scrollTo({top:scroll.value.scrollHeight,behavior:"smooth"}); });
    }, controller.signal);
  } catch(e) {
    if (active() && (e as Error).name !== "AbortError") { error.value=(e as Error).message; if(!accepted) content.value=text; }
  } finally {
    if (active()) { streaming.value=false; streamText.value=""; aborter=null; await loadDetail().catch(()=>{}); await loadList().catch(()=>{}); }
  }
}
async function stop() {
  const id=currentId.value; const epoch=streamEpoch;
  try { if(runId.value && id) await api(`/conversations/${id}/runs/${runId.value}/abort`,{method:"POST"}); }
  catch(e) { if(epoch===streamEpoch)error.value=(e as Error).message; return; }
  if(epoch===streamEpoch){aborter?.abort();streaming.value=false;await loadDetail();}
}
async function upload(event:Event) {
  const input=event.target as HTMLInputElement; const id=currentId.value; const files=[...(input.files??[])];
  if(!files.length || !id)return;
  input.value=""; error.value="";
  try { const form=new FormData();for(const file of files)form.append("files",file);await api(`/conversations/${id}/files/batch`,{method:"POST",body:form}); if(currentId.value===id)await loadDetail(); }
  catch(e){if(currentId.value===id){error.value=(e as Error).message;try{await loadDetail();}catch{/* Preserve the upload error if refreshing also fails. */}}}
}
async function removeFile(id:string) { if(!confirm("删除文件后将同步清理索引，会议文件变化还会触发重新分析。确认删除？"))return; await api(`/files/${id}`,{method:"DELETE"});await loadDetail(); }
async function reanalyze() { if (!currentId.value) return; error.value=""; try { await api(`/conversations/${currentId.value}/meetings/reanalyze`, { method:"POST" }); await loadDetail(); artifactOpen.value=true; void pollPresentations(); } catch(e) { error.value=e instanceof Error?e.message:"分析失败"; } }
async function generatePpt() { if (!currentId.value) return; const prompt=window.prompt("请输入 PPT 要求", "基于当前会话生成一份专业汇报 PPT"); if (!prompt) return; try { await api(`/conversations/${currentId.value}/presentations`, { method:"POST", body:JSON.stringify({prompt,idempotencyKey:crypto.randomUUID()}) }); await loadDetail(); artifactOpen.value=true; void pollPresentations(); } catch(e){error.value=e instanceof Error?e.message:"生成失败";} }
let pollEpoch = 0; let pollingId: string | undefined; let disposed = false;
function isBusy(value: Detail) { return value.runs?.some(r=>r.status==='RUNNING') || value.presentations.some(p=>p.status==='PENDING'||p.status==='PROCESSING') || value.files.some(f=>f.status==='PENDING'||f.status==='PROCESSING') || value.meetingStatus==='PROCESSING' || value.meetings.some(m=>m.emails.some(e=>e.status==='PENDING'||e.status==='SENDING')); }
async function pollPresentations() {
  const id = currentId.value;
  if (!id || pollingId === id || disposed) return;
  pollingId = id; const epoch = ++pollEpoch;
  try {
    while (!disposed && epoch === pollEpoch && id === currentId.value && detail.value && isBusy(detail.value)) {
      await new Promise(r=>setTimeout(r,2000));
      if (disposed || epoch !== pollEpoch || id !== currentId.value) return;
      await loadDetail();
    }
  } catch(e) { if(epoch===pollEpoch) error.value=e instanceof Error?e.message:'状态刷新失败，请刷新页面重试'; }
  finally { if(epoch===pollEpoch) pollingId=undefined; }
}
onUnmounted(()=>{disposed=true;streamEpoch++;pollEpoch++;aborter?.abort();});
async function retryFile(id:string) { try { await api('/files/'+id+'/retry',{method:'POST'}); await loadDetail(); } catch(e) { error.value=(e as Error).message; } }
async function retryPpt(id:string) { try { await api('/presentations/'+id+'/retry',{method:'POST'}); await loadDetail(); } catch(e) { error.value=(e as Error).message; } }
async function retryMail(id:string) { try { const result=await api<{queued:boolean;reason?:string}>('/conversations/'+currentId.value+'/meetings/emails/'+id+'/retry',{method:'POST'}); if(!result.queued) error.value=result.reason??'未提交'; await loadDetail(); } catch(e) { error.value=(e as Error).message; } }
function html(text:string) { return DOMPurify.sanitize(marked.parse(text) as string); }
function safeLink(value:string) { try { const url=new URL(value); return url.protocol==='http:'||url.protocol==='https:'?url.href:undefined; } catch { return undefined; } }
watch(currentId, async(id,oldId)=>{
  if(oldId && content.value)sessionStorage.setItem(draftKey(oldId),content.value);
  streamEpoch++;aborter?.abort();aborter=null;streaming.value=false;streamText.value="";runId.value="";activeTools.value=[];error.value="";detail.value=null;
  content.value=readDraft(id);pollEpoch++;pollingId=undefined;await loadDetail();
}); onMounted(async()=>{content.value=readDraft(currentId.value);if(window.innerWidth<=1100)artifactOpen.value=false;capabilities.value=await api("/health/capabilities");await loadList(); await loadDetail();if(detail.value?.presentations.some(p=>p.status==='PENDING'||p.status==='PROCESSING'))void pollPresentations();});
</script>

<template>
<div class="workspace">
  <section class="history-pane">
    <div class="pane-title">会话记录</div>
    <div class="history-list"><button v-for="item in conversations" :key="item.id" :class="['history-item',{selected:item.id===currentId}]" @click="router.push(`/chat/${item.id}`)"><span class="mode-dot" :class="item.mode.toLowerCase()"></span><span>{{ item.title }}</span><Trash2 :size="14" @click.stop="remove(item.id)"/></button></div>
  </section>
  <section class="chat-pane">
    <template v-if="!detail">
      <div class="empty-create"><span class="hero-icon"><Bot/></span><h1>今天想一起推进什么？</h1><p>选择一种固定会话模式开始。模式创建后不可切换。</p><div class="mode-cards"><button @click="create('CHAT')"><Plus/><strong>普通对话</strong><small>聊天、PDF 问答、联网搜索与 PPT</small></button><button @click="create('MEETING')"><Users/><strong>会议分析</strong><small>上传会议 TXT，识别风险并生成待办</small></button></div></div>
    </template>
    <template v-else>
      <header class="chat-header"><div><h2>{{ detail.title }}</h2><span class="badge">{{ detail.mode === 'MEETING' ? '会议分析' : '普通对话' }}</span></div><button class="ghost" @click="artifactOpen=!artifactOpen">{{ artifactOpen?'隐藏':'显示' }}产物</button></header>
      <div ref="scroll" class="messages">
        <div v-if="!detail.messages.length" class="conversation-empty"><Bot :size="30"/><h3>{{ detail.mode==='MEETING'?'上传会议原文开始分析':'开始你的第一个问题' }}</h3><p>{{ detail.mode==='MEETING'?'支持多个 UTF-8 TXT（每份最多 120,000 字符），也可以上传 PDF 作为背景。':'可以上传 PDF 作为本次会话的知识背景。' }}</p></div>
        <article v-for="message in detail.messages.filter(m=>m.role==='USER'||m.role==='ASSISTANT')" :key="message.id" :class="['message',message.role.toLowerCase()]">
          <div class="message-avatar">{{ message.role==='USER'?'你':'AI' }}</div><div class="message-body"><div v-html="html(message.content)"></div><div v-if="message.searchRuns?.length" class="search-sources"><b>联网来源</b><template v-for="run in message.searchRuns" :key="run.id"><small>{{new Date(run.searchedAt).toLocaleString()}} · {{run.query}}</small><a v-for="source in run.sources.filter(item=>safeLink(item.url))" :key="source.url" :href="safeLink(source.url)" target="_blank" rel="noopener noreferrer">{{source.title}}</a></template></div></div>
        </article>
        <article v-if="streaming && streamText" class="message assistant"><div class="message-avatar">AI</div><div class="message-body" v-html="html(streamText)"></div></article>
        <div v-if="activeTools.length" class="tool-activity" aria-live="polite"><div v-for="tool in activeTools" :key="tool.id" :class="['tool-state',tool.status.toLowerCase()]"><span class="tool-dot"></span><b>{{toolLabel(tool.name)}}</b><span>{{tool.status==='RUNNING'?'执行中…':tool.status==='COMPLETED'?'已完成':'执行失败'}}</span></div></div>
        <p v-if="error" class="error callout">{{ error }}</p>
      </div>
      <div class="composer-wrap">
        <div v-if="detail.files.length" class="attachment-row"><span v-for="file in detail.files" :key="file.id" :class="['file-chip',file.status.toLowerCase()]" :title="file.errorMessage"><FileText :size="14"/>{{ file.originalName }} · {{ file.status }}</span></div>
        <div class="composer"><textarea v-model="content" rows="2" placeholder="输入消息，Shift + Enter 换行" @keydown.enter.exact.prevent="send"></textarea><div class="composer-actions"><div><input ref="fileInput" hidden type="file" multiple :accept="detail.mode==='MEETING'?'.pdf,.txt':'.pdf'" @change="upload"/><button title="上传文件" @click="fileInput?.click()"><Paperclip :size="18"/></button><button :class="{enabled:webSearch}" :disabled="!capabilities.search" :title="capabilities.search?'联网搜索':'联网搜索未配置'" @click="webSearch=!webSearch"><Globe2 :size="18"/> {{capabilities.search?'联网':'联网未配置'}}</button><button title="生成 PPT" @click="generatePpt"><Presentation :size="18"/> PPT</button><button v-if="detail.mode==='MEETING'" :disabled="detail.meetingStatus==='PROCESSING'" @click="reanalyze"><Users :size="18"/> {{detail.meetingStatus==='PROCESSING'?'分析中':'重新分析'}}</button></div><button v-if="streaming" class="send" @click="stop"><Square :size="17"/></button><button v-else class="send" :disabled="!content.trim()" @click="send"><Send :size="17"/></button></div></div>
        <small>AI 可能犯错。文件引用和行动项请结合原文核对；对话与上传内容会发送至已配置的外部模型服务处理。</small>
      </div>
    </template>
  </section>
  <aside v-if="detail && artifactOpen" class="artifact-pane"><div class="pane-title">会话产物</div><div class="artifact-content">
    <section><h3>文件</h3><div v-if="!detail.files.length" class="muted">暂无文件</div><div v-for="file in detail.files" :key="file.id" class="artifact-card"><FileText :size="18"/><div><strong>{{file.originalName}}</strong><small>{{file.kind}} · {{file.status}}</small><small v-if="file.errorMessage">{{file.errorMessage}}</small><details v-if="file.pages?.length"><summary>逐页解析结果</summary><small v-if="file.pages.some(page=>page.extractionMethod.includes('OCR'))">含 OCR 识别结果，小字、图表和专有名词请对照原文件核对；解析完成不代表逐字无误。</small><small v-for="page in file.pages" :key="page.pageNo">第 {{page.pageNo}} 页 · {{page.extractionMethod}} · {{page.qualityMessage||page.qualityStatus}}</small></details><button v-if="file.status==='FAILED'||file.status==='PARTIAL'" @click="retryFile(file.id)">重试解析</button></div><a class="icon" :href="`/api/files/${file.id}`" target="_blank" title="下载"><Download :size="15"/></a><button class="icon danger" title="删除" @click="removeFile(file.id)"><Trash2 :size="15"/></button></div></section>
    <section v-if="detail.mode==='MEETING'"><h3>会议分析</h3><div v-if="detail.meetingStatus==='PROCESSING'" class="muted">会议材料正在后台分析…</div><div v-else-if="detail.meetingStatus==='FAILED'" class="error callout">{{detail.meetingErrorMessage}}</div><div v-for="meeting in detail.meetings" :key="meeting.id" class="analysis-card"><strong>{{meeting.title}} {{meeting.archived?'（历史版本，待办保留）':''}}</strong><p>{{meeting.analysis.summary}}</p><details><summary>结构化纪要</summary><small>参与人：{{meeting.analysis.participants?.join('、')||'待确认'}}</small><small>时间：{{meeting.analysis.time||'待确认'}} · 地点：{{meeting.analysis.location||'待确认'}}</small><p><b>主题：</b>{{meeting.analysis.topics?.join('；')||'无'}}</p><p><b>结论：</b>{{meeting.analysis.decisions?.join('；')||'无'}}</p><p><b>承诺：</b>{{meeting.analysis.commitments?.join('；')||'无'}}</p><p><b>AI 洞察：</b>{{meeting.analysis.insights?.join('；')||'无'}}</p></details><div v-for="risk in meeting.risks" :key="risk.id" class="risk"><span>{{risk.active===false?'待复核（本次未检出）':risk.severity}}</span>{{risk.description}}<small v-for="e in risk.evidence" :key="e.quote">证据：{{e.quote}}（{{e.fileName}}{{e.page?` 第${e.page}页`:''}}）</small></div><div v-for="todo in meeting.todos" :key="todo.id" class="meeting-todo">待办：{{todo.title}} · {{todo.owner||'待确认'}} · {{todo.dueAt?new Date(todo.dueAt).toLocaleString():'待确认'}}</div><small v-for="mail in meeting.emails" :key="mail.id" class="mail-state">邮件：{{mail.status==='DISABLED'?'未发送（SMTP 未配置）':mail.status==='SENT'?'已提交 SMTP（请核对收件箱）':mail.status==='FAILED'?'发送失败':mail.status==='CANCELLED'?'已取消（内容已更新或风险已撤回）':'等待投递'}}<span v-if="mail.errorCode"> · {{mail.errorCode}}</span><button v-if="mail.status==='FAILED'||mail.status==='DISABLED'" @click="retryMail(mail.id)">重试投递</button></small></div></section>
    <section v-if="detail.presentations?.length"><h3>PPT</h3><button v-for="ppt in detail.presentations" :key="ppt.id" :class="['artifact-card',{clickable:ppt.status==='READY'}]" :disabled="ppt.status==='PENDING'||ppt.status==='PROCESSING'" @click="ppt.status==='FAILED'?retryPpt(ppt.id):ppt.status==='READY'&&router.push(`/presentations/${ppt.id}`)"><Presentation :size="18"/><div><strong>{{ppt.title}}</strong><small v-if="ppt.status==='READY'">{{ppt.versions.length}} 个版本 · 可预览编辑</small><small v-else-if="ppt.status==='FAILED'" class="error">生成失败：{{ppt.errorMessage}} · 点击重试</small><small v-else>后台生成中 · {{ppt.progress}}%</small></div></button></section>
  </div></aside>
</div>
</template>
