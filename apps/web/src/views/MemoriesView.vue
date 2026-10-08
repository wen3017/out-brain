<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { onBeforeRouteLeave, useRouter } from "vue-router";
import { BookOpen, Pencil, RefreshCw, Search, Trash2 } from "lucide-vue-next";
import { api } from "../api";
import EditDialog from "../components/EditDialog.vue";

type Fact = { id:string; attribute:string; value:string; createdAt:string; supersededById?:string; userEdited:boolean; kind?:string; evidence?:string; withdrawnAt?:string; sourceType?:string; sourceId?:string; effectiveAt?:string; observedAt?:string };
type Entity = { id:string; type:string; canonicalName:string; facts:Fact[] };
type Task = { id:string; sourceType:string; sourceId:string; status:string; errorMessage?:string };
const router = useRouter();
const memories = ref<Entity[]>([]), tasks = ref<Task[]>([]);
const worker = ref(""), error = ref(""), loadError = ref(""), notice = ref("");
const busy = ref(false), loading = ref(false), loaded = ref(false);
const query = ref(""), category = ref(""), sort = ref("name"), showHistory = ref(false);
const editing = ref<Fact|null>(null), editValue = ref(""), editError = ref("");
const types: Record<string,string> = { PERSON:"人物", TIME:"时间", LOCATION:"地点", TOPIC:"主题", RELATION:"关系" };
const sourceLabel = (source?:string) => ({USER:"手动修正", CONVERSATION:"会话", MEETING:"会议", FILE:"文件"}[source ?? ""] ?? source ?? "来源未记录");
const dateLabel = (value?:string) => value && !Number.isNaN(new Date(value).valueOf()) ? new Date(value).toLocaleDateString("zh-CN") : "—";
const isCurrent = (fact:Fact) => !fact.supersededById && !fact.withdrawnAt;
const activeCount = computed(() => memories.value.reduce((sum,entity) => sum + entity.facts.filter(isCurrent).length,0));
const filtered = computed(() => {
  const term = query.value.trim().toLowerCase();
  return memories.value.filter(entity => !category.value || entity.type === category.value).map(entity => ({...entity, facts:entity.facts.filter(fact => (showHistory.value || isCurrent(fact)) && (!term || `${entity.canonicalName} ${fact.attribute} ${fact.value} ${fact.evidence ?? ""}`.toLowerCase().includes(term)))})).filter(entity => entity.facts.length).sort((a,b) => sort.value === "name" ? a.canonicalName.localeCompare(b.canonicalName,"zh-CN") : Math.max(0,...b.facts.map(f=>Date.parse(f.observedAt ?? f.createdAt)||0)) - Math.max(0,...a.facts.map(f=>Date.parse(f.observedAt ?? f.createdAt)||0)));
});
const visibleCount = computed(() => filtered.value.reduce((sum,entity) => sum + entity.facts.length,0));
let timer: ReturnType<typeof setInterval> | undefined;
let disposed = false;
async function load() {
  if (loading.value || disposed) return;
  loading.value = true;
  try {
    // Auxiliary job/health failures must not hide the saved knowledge records.
    const [entities, jobs, health] = await Promise.allSettled([api<Entity[]>("/memories"), api<Task[]>("/memories/tasks"), api<{worker:string}>("/health/ready")]);
    if (disposed) return;
    if (entities.status === "fulfilled") { memories.value = entities.value; loaded.value = true; loadError.value = ""; }
    else loadError.value = "记录加载失败，请重试。";
    if (jobs.status === "fulfilled") tasks.value = jobs.value;
    worker.value = health.status === "fulfilled" ? health.value.worker : "unknown";
  } finally { loading.value = false; }
}
async function retry(id:string) {
  if (busy.value) return;
  busy.value = true; error.value = "";
  try { await api(`/memories/tasks/${id}/retry`,{method:"POST"}); notice.value="已重新提交整理任务"; await load(); }
  catch(e) { error.value=(e as Error).message; }
  finally { busy.value=false; }
}
function edit(fact:Fact) { editing.value=fact; editValue.value=fact.value; editError.value=""; }
function canClose() { return !busy.value && (!editing.value || editValue.value===editing.value.value || confirm("放弃未保存的修改？")); }
function closeEditor() { if(canClose()) editing.value=null; }
onBeforeRouteLeave(() => canClose());
async function save() {
  const fact = editing.value;
  if (!fact || busy.value) return;
  if (!editValue.value.trim()) { editError.value="记忆内容不能为空"; return; }
  busy.value=true; editError.value="";
  try { await api(`/memories/facts/${fact.id}`,{method:"PATCH",body:JSON.stringify({value:editValue.value.trim()})}); editing.value=null; notice.value="已保存修改，原内容可在历史记录中查看。"; await load(); }
  catch(e) { editError.value=`修改失败：${(e as Error).message}。输入内容已保留，可重试。`; }
  finally { busy.value=false; }
}
async function remove(entity:Entity) {
  if(busy.value || !confirm(`确认删除「${entity.canonicalName}」及其全部记录？删除后不会再从后台任务自动恢复。`)) return;
  busy.value=true; error.value="";
  try { await api(`/memories/${entity.id}`,{method:"DELETE"}); notice.value="记录已删除"; await load(); }
  catch(e) { error.value=`删除失败：${(e as Error).message}`; }
  finally { busy.value=false; }
}
function reset() { query.value=""; category.value=""; showHistory.value=false; sort.value="name"; }
onMounted(() => { void load(); timer=setInterval(() => { if(!editing.value && !document.hidden) void load(); },5000); });
onUnmounted(() => { disposed=true; if(timer) clearInterval(timer); });
</script>

<template>
  <div class="page records-page">
    <div class="breadcrumb">工作空间 <span>/</span> 记忆管理</div>
    <header class="page-header"><div><h1>记忆管理</h1><p>查看会话中保存的信息，核对来源或修正内容。</p></div><button class="secondary" :disabled="loading" @click="load"><RefreshCw :size="15"/>{{loading ? '刷新中…' : '刷新'}}</button></header>
    <p v-if="error || loadError" class="error callout" role="alert">{{error || loadError}} <button v-if="loadError" class="text-button" @click="load">重新加载</button></p>
    <p v-if="notice" class="notice" role="status">{{notice}}</p>
    <p v-if="worker==='offline'" class="warning-note">后台整理暂不可用，已保存的记录仍可查看和编辑。</p>
    <div class="section-tabs"><button class="active">全部记录 <span>{{memories.length}}</span></button><span class="section-caption">{{activeCount}} 条有效信息</span></div>
    <div class="data-toolbar">
      <label class="search-field"><Search :size="16"/><input v-model="query" aria-label="搜索记忆" placeholder="搜索名称、内容或来源证据"/><button v-if="query" class="text-button" aria-label="清除搜索" @click="query=''">×</button></label>
      <select v-model="category" aria-label="记忆类型"><option value="">全部类型</option><option v-for="(label,key) in types" :key="key" :value="key">{{label}}</option></select>
      <select v-model="sort" aria-label="记忆排序"><option value="name">按名称排序</option><option value="recent">最近更新优先</option></select>
      <label class="checkbox-label"><input v-model="showHistory" type="checkbox"/>包含历史记录</label>
    </div>
    <div v-if="!loaded && loading" class="empty-list" role="status">正在加载记录…</div>
    <div v-else-if="loaded && !filtered.length" class="big-empty"><BookOpen/><h3>{{query || category || memories.length ? '没有符合条件的记录' : '暂无保存的信息'}}</h3><p>{{query || category || memories.length ? '可以更换关键词、类型，或勾选历史记录。' : '完成对话或会议分析后，人物、地点等信息会整理到这里。'}}</p><button v-if="query || category || memories.length" class="secondary" @click="reset">重置筛选</button><button v-else class="secondary" @click="router.push('/')">前往会话</button></div>
    <div v-else-if="filtered.length" class="records-list">
      <div class="records-heading"><span>名称 / 内容</span><span>来源与更新时间</span><span>操作</span></div>
      <article v-for="entity in filtered" :key="entity.id" class="memory-card">
        <header><BookOpen :size="17"/><strong>{{entity.canonicalName}}</strong><span class="badge">{{types[entity.type] ?? entity.type}}</span><button class="icon danger" title="删除记忆" :disabled="busy" @click="remove(entity)"><Trash2 :size="16"/></button></header>
        <div v-for="fact in entity.facts" :key="fact.id" :class="['fact',{old:!isCurrent(fact)}]">
          <div class="fact-content"><small>{{fact.attribute}} <span v-if="!isCurrent(fact)" class="badge neutral">{{fact.withdrawnAt ? '已撤回' : '历史版本'}}</span><span v-else-if="fact.kind==='EVENT'" class="badge neutral">历史事件</span></small><p>{{fact.value}}</p><details><summary>查看来源证据</summary><p>{{fact.evidence || '此条记录未保存原文证据。'}}</p><small v-if="fact.sourceId">来源编号：{{fact.sourceId}}</small><small v-if="fact.effectiveAt">事件时间：{{dateLabel(fact.effectiveAt)}}</small></details></div>
          <div class="fact-meta"><span>{{sourceLabel(fact.sourceType)}}</span><time>{{dateLabel(fact.observedAt || fact.createdAt)}}</time></div>
          <button v-if="isCurrent(fact)" class="icon" title="编辑记忆" :disabled="busy" @click="edit(fact)"><Pencil :size="15"/></button><span v-else></span>
        </div>
      </article>
      <div class="list-footer">显示 {{filtered.length}} 个条目 · {{visibleCount}} 条信息</div>
    </div>
    <details v-if="tasks.length" class="processing-tasks"><summary>后台整理记录 <span>{{tasks.length}}</span></summary><div v-for="task in tasks" :key="task.id" class="task-log"><span>{{sourceLabel(task.sourceType)}}</span><span>{{task.status==='READY'?'整理完成':task.status==='FAILED'?'整理失败':'整理中'}}</span><small v-if="task.errorMessage">{{task.errorMessage}}</small><button v-if="task.status==='FAILED'" class="text-button" :disabled="busy" @click="retry(task.id)">重新整理</button></div></details>
    <EditDialog v-if="editing" title="编辑记忆" :busy="busy" :error="editError" @close="closeEditor" @save="save"><label>{{editing.attribute}}<textarea v-model="editValue" aria-label="记忆内容" rows="5" autofocus :disabled="busy"/></label><p class="field-help">保存后会保留旧版本，可勾选“包含历史记录”查看。</p></EditDialog>
  </div>
</template>
