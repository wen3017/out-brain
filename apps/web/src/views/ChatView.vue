<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { marked } from "marked"; import DOMPurify from "dompurify";
import { UPLOAD_LIMITS } from "@nbboss/contracts";
import { api, streamMessage } from "../api";
import { ArrowUpRight, ChevronRight, Download, FileText, Globe2, MessageSquare, PanelRight, Paperclip, Plus, Presentation, Search, Send, Square, Trash2, Users, X } from "lucide-vue-next";

type Conversation = { id:string; title:string; mode:"CHAT"|"MEETING"; updatedAt:string };
type SearchSource = { title:string; url:string; snippet:string; retrievedAt:string; mock?:boolean };
type Message = { id:string; role:string; content:string; status:string; createdAt?:string; searchRuns?:Array<{id:string;query:string;searchedAt:string;sources:SearchSource[]}> };
type FileItem = { id:string; originalName:string; kind:string; status:string; errorMessage?:string; pages?:Array<{pageNo:number;extractionMethod:string;qualityStatus:string;qualityMessage?:string}> };
type Meeting = { archived?:boolean; id:string; title:string; analysis:any; risks:Array<{id:string;active?:boolean;severity:string;description:string;evidence:Array<{quote:string;fileName:string;page?:number}>}>; todos:Array<{id:string;title:string;owner:string;dueAt?:string}>; emails:Array<{id:string;status:string;errorCode?:string;sentAt?:string}> };
type PresentationItem = { id:string; title:string; status:"PENDING"|"PROCESSING"|"READY"|"FAILED"; progress:number; errorMessage?:string; versions:any[] };
type Detail = { id:string; title:string; mode:string; meetingStatus?:"PROCESSING"|"READY"|"FAILED"; meetingErrorMessage?:string; runs?:Array<{id:string;status:string;errorCode?:string}>; messages:Message[]; files:FileItem[]; meetings:Meeting[]; presentations:PresentationItem[] };

const route = useRoute(); const router = useRouter();
const conversations = ref<Conversation[]>([]); const detail = ref<Detail|null>(null); const content = ref(""); const webSearch = ref<"auto"|"on"|"off">("auto"); const streaming = ref(false); const streamText = ref(""); const runId = ref(""); const error = ref(""); const fileInput = ref<HTMLInputElement>(); const scroll = ref<HTMLElement>(); const artifactOpen = ref(true); let aborter: AbortController | null = null; let streamEpoch = 0; let detailRequestSeq = 0;
const draftKey = (id:string) => `nbboss-draft:${id}`;
function readDraft(id?:string) { return id ? sessionStorage.getItem(draftKey(id)) ?? "" : ""; }
const capabilities=ref({search:false,smtp:false,embedding:false,vision:false});

const currentId = computed(() => route.params.id as string | undefined);
const historySearch = ref("");
const creating = ref(false);
const listLoading = ref(true);
const listError = ref("");
const detailLoading = ref(false);
const recentConversations = computed(() => [...conversations.value].sort((a,b) => Date.parse(b.updatedAt)-Date.parse(a.updatedAt)).slice(0,6));
const filteredConversations = computed(() => conversations.value.filter(item => item.title.toLowerCase().includes(historySearch.value.trim().toLowerCase())));
const activeTools = ref<Array<{ id:string; name:string; status:"RUNNING"|"COMPLETED"|"FAILED" }>>([]);
function toolLabel(name:string) { return ({ read_meetings:"读取当前会议", retrieve_documents:"检索会话文件", retrieve_memory:"检索长期记忆", search_web:"联网搜索", analyze_meeting:"分析会议", create_todos:"创建待办", generate_presentation:"生成 PPT" } as Record<string,string>)[name] ?? name; }
async function loadList() { listLoading.value=true; listError.value=""; try { conversations.value=await api<Conversation[]>("/conversations"); } catch(e) { listError.value=(e as Error).message; } finally { listLoading.value=false; } }
async function loadDetail() { const requestSeq = ++detailRequestSeq; if (!currentId.value) { detail.value = null; return; } const id = currentId.value; const result = await api<Detail>(`/conversations/${id}`); if (requestSeq !== detailRequestSeq || id !== currentId.value || disposed) return; detail.value = result; const savedDraft=readDraft(id);const submittedAt=Number(sessionStorage.getItem(`${draftKey(id)}:submittedAt`));if(savedDraft && submittedAt && result.messages.some(m=>m.role==="USER" && m.content===savedDraft && m.createdAt && new Date(m.createdAt).valueOf()>=submittedAt-1000)){sessionStorage.removeItem(draftKey(id));sessionStorage.removeItem(`${draftKey(id)}:submittedAt`);if(content.value===savedDraft)content.value="";} if (!aborter) { const run = result.runs?.[0]; streaming.value = run?.status === "RUNNING"; runId.value = streaming.value ? run!.id : ""; } if (isBusy(result)) void pollPresentations(); await nextTick(); scroll.value?.scrollTo({ top: scroll.value.scrollHeight }); }
async function create(mode:"CHAT"|"MEETING") {
  if (creating.value) return;
  creating.value = true; error.value = "";
  try { const value = await api<Conversation>("/conversations", { method:"POST", body:JSON.stringify({ mode }) }); await loadList(); await router.push(`/chat/${value.id}`); }
  catch (e) { error.value = e instanceof Error ? e.message : "创建会话失败，请重试"; }
  finally { creating.value = false; }
}
async function remove(id:string) { if (!confirm("删除后聊天、文件、索引、会议待办、PPT 及该会话来源的自动记忆均不可恢复；用户手工修正的记忆保留。确认删除？")) return; try { await api(`/conversations/${id}`, { method:"DELETE" }); await loadList(); if (currentId.value === id) router.push("/"); } catch(e) { error.value=`删除失败：${(e as Error).message}`; } }
function handleEnter(event:KeyboardEvent) { if(event.isComposing || event.keyCode===229)return; event.preventDefault(); void send(); }
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
  if(files.length > UPLOAD_LIMITS.files || files.reduce((sum,file)=>sum+file.size,0)>UPLOAD_LIMITS.batchBytes){ error.value="每批最多 20 个文件，总大小不能超过 50 MB"; input.value=""; return; }
  if(files.some(file=>file.size > (file.name.toLowerCase().endsWith(".txt")?UPLOAD_LIMITS.txtBytes:UPLOAD_LIMITS.pdfBytes))){error.value="单文件大小限制：PDF 20 MB，TXT 5 MB";input.value="";return;}
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
function refreshOnReturn() { if (document.visibilityState === "visible" && currentId.value && !streaming.value && !aborter) { void refreshDetail(); void loadList(); } }
onUnmounted(()=>{disposed=true;streamEpoch++;pollEpoch++;detailRequestSeq++;aborter?.abort();window.removeEventListener("focus",refreshOnReturn);document.removeEventListener("visibilitychange",refreshOnReturn);});
async function retryFile(id:string) { try { await api('/files/'+id+'/retry',{method:'POST'}); await loadDetail(); } catch(e) { error.value=(e as Error).message; } }
async function retryPpt(id:string) { try { await api('/presentations/'+id+'/retry',{method:'POST'}); await loadDetail(); } catch(e) { error.value=(e as Error).message; } }
async function retryMail(id:string, inboxChecked=false) { try { const result=await api<{queued:boolean;reason?:string;requiresInboxCheck?:boolean}>('/conversations/'+currentId.value+'/meetings/emails/'+id+'/retry',{method:'POST',body:JSON.stringify({inboxChecked})}); if(result.requiresInboxCheck && confirm("邮件可能已被接收。请先核对收件箱；确认仍需再次投递？")) return retryMail(id,true); if(!result.queued) error.value=result.reason??'未提交'; await loadDetail(); } catch(e) { error.value=(e as Error).message; } }
function html(text:string) { return DOMPurify.sanitize(marked.parse(text) as string); }
function safeLink(value:string) { try { const url=new URL(value); return url.protocol==='http:'||url.protocol==='https:'?url.href:undefined; } catch { return undefined; } }
watch(currentId, async(id,oldId)=>{
  if(oldId && content.value)sessionStorage.setItem(draftKey(oldId),content.value);
  streamEpoch++;aborter?.abort();aborter=null;streaming.value=false;streamText.value="";runId.value="";activeTools.value=[];error.value="";detail.value=null;
  content.value=readDraft(id);pollEpoch++;pollingId=undefined;await refreshDetail();
});
async function refreshDetail() { detailLoading.value=true; const id=currentId.value; try { await loadDetail(); if(id===currentId.value)error.value=""; } catch(e) { if(id===currentId.value)error.value=(e as Error).message; } finally { if(id===currentId.value)detailLoading.value=false; } }
onMounted(async()=>{content.value=readDraft(currentId.value);if(window.innerWidth<=1100)artifactOpen.value=false;window.addEventListener("focus",refreshOnReturn);document.addEventListener("visibilitychange",refreshOnReturn);await Promise.all([loadList(),refreshDetail(),api<typeof capabilities.value>("/health/capabilities").then(value=>capabilities.value=value).catch(()=>{})]);});
</script>

<template>
<div class="workspace" :class="{ 'with-artifacts': detail && artifactOpen }" @keydown.esc="artifactOpen=false">
  <section class="history-pane">
    <div class="pane-title">会话记录 <span class="count-pill">{{ conversations.length }}</span><button class="ghost" title="新建普通对话" aria-label="新建普通对话" :disabled="creating" @click="create('CHAT')"><Plus :size="16"/></button></div>
    <label class="history-search"><Search :size="15"/><input v-model="historySearch" placeholder="搜索会话" aria-label="搜索会话"/></label>
    <div class="history-list"><div v-for="item in filteredConversations" :key="item.id" :class="['history-row',{selected:item.id===currentId}]"><button class="history-item" :title="item.title" @click="router.push(`/chat/${item.id}`)"><MessageSquare v-if="item.mode==='CHAT'" :size="15"/><Users v-else :size="15"/><span>{{ item.title }}</span></button><button class="history-delete" :aria-label="`删除会话：${item.title}`" @click="remove(item.id)"><Trash2 :size="14"/></button></div></div>
    <div v-if="!listLoading && !listError && !filteredConversations.length" class="history-empty"><MessageSquare :size="22"/><p>{{ historySearch ? '没有找到相关会话' : '暂无会话记录' }}</p><small>{{ historySearch ? '试试其他关键词' : '新建会话后，记录会保存在这里' }}</small></div>
    <p v-if="listLoading" class="history-empty" role="status">正在加载…</p><p v-if="listError" class="error callout" role="alert">会话列表加载失败 <button class="text-button" @click="loadList">重试</button></p>
  </section>
  <section class="chat-pane">
    <template v-if="!detail">
      <header class="home-header"><span>工作空间 <ChevronRight :size="14"/> <b>{{currentId ? '会话' : '会话首页'}}</b></span></header>
      <div v-if="currentId" class="big-empty"><p role="status">{{detailLoading ? '正在加载会话…' : '暂时无法加载此会话'}}</p><p v-if="error" class="error" role="alert">{{error}}</p><button v-if="!detailLoading" class="secondary" @click="refreshDetail">重试</button></div>
      <div v-else class="home-content">
        <header class="home-title"><h1>会话</h1><p>开始新的讨论，或继续上次的工作。</p></header>
        <div class="mode-cards"><button :disabled="creating" @click="create('CHAT')"><span class="mode-icon"><MessageSquare :size="22"/></span><div><strong>普通对话</strong><small>讨论问题、查阅 PDF，也可以生成演示文稿。</small></div><Plus :size="18"/></button><button :disabled="creating" @click="create('MEETING')"><span class="mode-icon"><Users :size="22"/></span><div><strong>会议分析</strong><small>上传会议 TXT，整理纪要、风险和行动项。</small></div><Plus :size="18"/></button></div>
        <p class="field-help">会话模式创建后不可切换；文件保存在所属会话中。</p><p v-if="error" class="error callout" role="alert">{{error}}</p>
        <section class="recent-section"><header><h2>最近会话</h2><span>{{conversations.length}} 个会话</span></header><p v-if="listLoading" class="empty-list">正在加载…</p><div v-else-if="!recentConversations.length" class="home-empty"><MessageSquare :size="24"/><div><strong>{{listError ? '会话列表加载失败' : '还没有会话'}}</strong><p>{{listError ? '请点击左侧重试，重新加载记录。' : '选择上方的会话类型开始，记录会保存在这里。'}}</p></div></div><button v-for="item in recentConversations" :key="item.id" class="recent-row" @click="router.push('/chat/'+item.id)"><MessageSquare v-if="item.mode==='CHAT'" :size="18"/><Users v-else :size="18"/><span>{{item.title}}</span><small>{{item.mode==='MEETING'?'会议':'对话'}}</small><time>{{new Date(item.updatedAt).toLocaleDateString('zh-CN')}}</time><ChevronRight :size="15"/></button></section>
        <div class="home-shortcuts"><button @click="router.push('/todos')">查看待办 <ArrowUpRight :size="15"/></button><button @click="router.push('/memories')">查看保存的信息 <ArrowUpRight :size="15"/></button></div>
      </div>
    </template>
    <template v-else>
      <header class="chat-header"><div><h2>{{ detail.title }}</h2><span class="badge">{{ detail.mode === 'MEETING' ? '会议分析' : '普通对话' }}</span></div><div class="chat-header-actions"><button class="ghost" title="刷新当前会话" @click="refreshDetail"><span>刷新</span></button><button class="ghost" :disabled="creating" @click="create('CHAT')"><Plus :size="16"/> 新对话</button><button class="ghost artifact-toggle" :aria-expanded="artifactOpen" @click="artifactOpen=!artifactOpen"><PanelRight :size="16"/>{{ artifactOpen?'隐藏':'显示' }}产物{{ detail.files.length ? ` (${detail.files.length})` : '' }}</button></div></header>
      <div ref="scroll" class="messages">
        <div v-if="!detail.messages.length" class="conversation-empty"><MessageSquare :size="30"/><h3>{{ detail.mode==='MEETING'?'上传会议原文开始分析':'开始你的第一个问题' }}</h3><p>{{ detail.mode==='MEETING'?'支持多个 UTF-8 TXT（每份最多 120,000 字符），也可以上传 PDF 作为背景。':'可以上传 PDF 作为本次会话的知识背景。' }}</p></div>
        <article v-for="message in detail.messages.filter(m=>m.role==='USER'||m.role==='ASSISTANT')" :key="message.id" :class="['message',message.role.toLowerCase()]">
          <div class="message-avatar">{{ message.role==='USER'?'你':'AI' }}</div><div class="message-body"><div v-html="html(message.content)"></div><div v-if="message.searchRuns?.length" class="search-sources"><b>联网来源</b><small v-if="message.searchRuns.some(run=>run.sources.some(source=>source.mock))">模拟搜索结果，未验证实时信息</small><template v-for="run in message.searchRuns" :key="run.id"><small>{{new Date(run.searchedAt).toLocaleString()}} · {{run.query}}</small><a v-for="source in run.sources.filter(item=>safeLink(item.url))" :key="source.url" :href="safeLink(source.url)" target="_blank" rel="noopener noreferrer">{{source.title}}</a></template></div></div>
        </article>
        <article v-if="streaming && streamText" class="message assistant"><div class="message-avatar">AI</div><div class="message-body" v-html="html(streamText)"></div></article>
        <div v-if="activeTools.length" class="tool-activity" aria-live="polite"><div v-for="tool in activeTools" :key="tool.id" :class="['tool-state',tool.status.toLowerCase()]"><span class="tool-dot"></span><b>{{toolLabel(tool.name)}}</b><span>{{tool.status==='RUNNING'?'执行中…':tool.status==='COMPLETED'?'已完成':'执行失败'}}</span></div></div>
        <p v-if="error" class="error callout">{{ error }}</p>
      </div>
      <div class="composer-wrap">
        <div class="composer"><textarea v-model="content" rows="2" placeholder="输入消息，Shift + Enter 换行" @keydown.enter.exact="handleEnter"></textarea><div class="composer-actions"><div><input ref="fileInput" hidden type="file" multiple :accept="detail.mode==='MEETING'?'.pdf,.txt':'.pdf'" @change="upload"/><button title="上传文件" @click="fileInput?.click()"><Paperclip :size="18"/></button><label class="search-mode" :title="capabilities.search?'自动模式会检索时效性问题；关闭模式不联网':'联网未配置：时效性问题会提示配置，不会伪造实时结果'"><Globe2 :size="18"/><select v-model="webSearch" aria-label="联网模式"><option value="auto">自动联网</option><option value="on">开启联网</option><option value="off">关闭联网</option></select><small v-if="!capabilities.search">未配置</small></label><button title="生成 PPT" @click="generatePpt"><Presentation :size="18"/> PPT</button><button v-if="detail.mode==='MEETING'" :disabled="detail.meetingStatus==='PROCESSING'" @click="reanalyze"><Users :size="18"/> {{detail.meetingStatus==='PROCESSING'?'分析中':'重新分析'}}</button></div><button v-if="streaming" class="send" aria-label="停止生成" @click="stop"><Square :size="17"/></button><button v-else class="send" aria-label="发送消息" :disabled="!content.trim()" @click="send"><Send :size="17"/></button></div></div>
        <small>AI 可能犯错。文件引用和行动项请结合原文核对；对话与上传内容会发送至已配置的外部模型服务处理。</small>
      </div>
    </template>
  </section>
  <button v-if="detail && artifactOpen" class="artifact-backdrop" aria-label="关闭产物面板" @click="artifactOpen=false"></button>
  <aside v-if="detail && artifactOpen" class="artifact-pane"><div class="pane-title"><PanelRight :size="16"/>会话产物<button class="ghost" title="关闭产物" @click="artifactOpen=false"><X :size="17"/></button></div><div class="artifact-content">
    <section><h3>会话文件 <span>{{detail.files.length}}</span></h3><div v-if="!detail.files.length" class="artifact-empty"><FileText :size="27"/><strong>暂无文件</strong><p>上传 PDF 后可在会话中提问，<br/>也可以随时查看和下载原文。</p><button class="ghost" @click="fileInput?.click()"><Plus :size="14"/> 上传文件</button></div><div v-for="file in detail.files" :key="file.id" class="artifact-card"><FileText :size="18"/><div><strong>{{file.originalName}}</strong><small>{{file.kind}} · {{file.status}}</small><small v-if="file.errorMessage">{{file.errorMessage}}</small><details v-if="file.pages?.length"><summary>逐页解析结果</summary><small v-if="file.pages.some(page=>page.extractionMethod.includes('OCR'))">含 OCR 识别结果，小字、图表和专有名词请对照原文件核对；解析完成不代表逐字无误。</small><small v-for="page in file.pages" :key="page.pageNo">第 {{page.pageNo}} 页 · {{page.extractionMethod}} · {{page.qualityMessage||page.qualityStatus}}</small></details><button v-if="file.status==='FAILED'||file.status==='PARTIAL'" @click="retryFile(file.id)">重试解析</button></div><a class="icon" :href="`/api/files/${file.id}`" target="_blank" title="下载"><Download :size="15"/></a><button class="icon danger" title="删除" @click="removeFile(file.id)"><Trash2 :size="15"/></button></div></section>
    <section v-if="detail.mode==='MEETING'"><h3>会议分析</h3><div v-if="detail.meetingStatus==='PROCESSING'" class="muted">会议材料正在后台分析…</div><div v-else-if="detail.meetingStatus==='FAILED'" class="error callout">{{detail.meetingErrorMessage}}</div><div v-for="meeting in detail.meetings" :key="meeting.id" class="analysis-card"><strong>{{meeting.title}} {{meeting.archived?'（历史版本，待办保留）':''}}</strong><p>{{meeting.analysis.summary}}</p><details><summary>结构化纪要</summary><small>参与人：{{meeting.analysis.participants?.join('、')||'待确认'}}</small><small>时间：{{meeting.analysis.time||'待确认'}} · 地点：{{meeting.analysis.location||'待确认'}}</small><p><b>主题：</b>{{meeting.analysis.topics?.join('；')||'无'}}</p><p><b>结论：</b>{{meeting.analysis.decisions?.join('；')||'无'}}</p><p><b>承诺：</b>{{meeting.analysis.commitments?.join('；')||'无'}}</p><p><b>补充建议：</b>{{meeting.analysis.insights?.join('；')||'无'}}</p></details><div v-for="risk in meeting.risks" :key="risk.id" class="risk"><span>{{risk.active===false?'待复核（本次未检出）':risk.severity}}</span>{{risk.description}}<small v-for="e in risk.evidence" :key="e.quote">证据：{{e.quote}}（{{e.fileName}}{{e.page?` 第${e.page}页`:''}}）</small></div><div v-for="todo in meeting.todos" :key="todo.id" class="meeting-todo">待办：{{todo.title}} · {{todo.owner||'待确认'}} · {{todo.dueAt?new Date(todo.dueAt).toLocaleString():'待确认'}}</div><small v-for="mail in meeting.emails" :key="mail.id" class="mail-state">邮件：{{mail.status==='DISABLED'?'未发送（SMTP 未配置）':mail.status==='SENT'?(mail.errorCode==='MOCK_DELIVERY'?'模拟投递完成（未发送真实邮件）':'已提交 SMTP（请核对收件箱）'):mail.status==='FAILED'?'发送失败':mail.status==='CANCELLED'?'已取消（内容已更新或风险已撤回）':'等待投递'}}<span v-if="mail.errorCode"> · {{mail.errorCode}}</span><button v-if="mail.status==='FAILED'||mail.status==='DISABLED'" @click="retryMail(mail.id)">重试投递</button></small></div></section>
    <section v-if="detail.presentations?.length"><h3>PPT</h3><button v-for="ppt in detail.presentations" :key="ppt.id" :class="['artifact-card',{clickable:ppt.status==='READY'}]" :disabled="ppt.status==='PENDING'||ppt.status==='PROCESSING'" @click="ppt.status==='FAILED'?retryPpt(ppt.id):ppt.status==='READY'&&router.push(`/presentations/${ppt.id}`)"><Presentation :size="18"/><div><strong>{{ppt.title}}</strong><small v-if="ppt.status==='READY'">{{ppt.versions.length}} 个版本 · 可预览编辑</small><small v-else-if="ppt.status==='FAILED'" class="error">生成失败：{{ppt.errorMessage}} · 点击重试</small><small v-else>后台生成中 · {{ppt.progress}}%</small></div></button></section>
  </div></aside>
</div>
</template>
