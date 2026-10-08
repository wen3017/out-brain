<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { CheckCircle2, Circle, Pencil, RefreshCw, Search, Trash2 } from "lucide-vue-next";
import { api } from "../api";
import EditDialog from "../components/EditDialog.vue";

type Todo = {id:string; title:string; description:string; owner:string; dueAt?:string; status:string; meeting:{title:string}; editedFields?:string[]; modelSuggestion?:{title:string;description:string;owner:string;dueAt?:string}};
const todos=ref<Todo[]>([]), status=ref(""), owner=ref(""), dueFrom=ref(""), dueTo=ref("");
const query=ref(""), overdueOnly=ref(false), sort=ref("due");
const loading=ref(false), loaded=ref(false), error=ref(""), notice=ref("");
const busy=ref(new Set<string>()), editing=ref<Todo|null>(null), editError=ref("");
const form=ref({title:"",description:"",owner:"",dueAt:""});
let originalForm="", loadEpoch=0;
const now=ref(Date.now());
let clock:ReturnType<typeof setInterval>|undefined;
const labels:Record<string,string>={PENDING:"待处理",IN_PROGRESS:"进行中",COMPLETED:"已完成",CANCELLED:"已取消"};
const isOpen=(todo:Todo)=>todo.status==='PENDING'||todo.status==='IN_PROGRESS';
const isOverdue=(todo:Todo)=>isOpen(todo)&&!!todo.dueAt&&Date.parse(todo.dueAt)<now.value;
const counts=computed(()=>({all:todos.value.length,open:todos.value.filter(isOpen).length,overdue:todos.value.filter(isOverdue).length,done:todos.value.filter(t=>t.status==='COMPLETED').length}));
const filtered=computed(()=>{
  const term=query.value.trim().toLowerCase(), person=owner.value.trim().toLowerCase();
  return todos.value.filter(todo=>(!status.value||todo.status===status.value)&&(!person||todo.owner.toLowerCase().includes(person))&&(!term||`${todo.title} ${todo.description} ${todo.meeting.title}`.toLowerCase().includes(term))&&(!overdueOnly.value||isOverdue(todo))&&(!dueFrom.value||(!!todo.dueAt&&Date.parse(todo.dueAt)>=new Date(`${dueFrom.value}T00:00:00`).valueOf()))&&(!dueTo.value||(!!todo.dueAt&&Date.parse(todo.dueAt)<=new Date(`${dueTo.value}T23:59:59.999`).valueOf()))).sort((a,b)=>sort.value==='title'?a.title.localeCompare(b.title,'zh-CN'):(a.dueAt?Date.parse(a.dueAt):Infinity)-(b.dueAt?Date.parse(b.dueAt):Infinity));
});
const invalidRange=computed(()=>!!dueFrom.value&&!!dueTo.value&&dueFrom.value>dueTo.value);
const hasFilters=computed(()=>!!(status.value||owner.value||query.value||dueFrom.value||dueTo.value||overdueOnly.value));
async function load(){
 const epoch=++loadEpoch; loading.value=true; error.value="";
 try {const result=await api<Todo[]>("/todos");if(epoch===loadEpoch){todos.value=result;loaded.value=true;}}
 catch(e){if(epoch===loadEpoch)error.value=`加载失败：${(e as Error).message}`;}
 finally{if(epoch===loadEpoch)loading.value=false;}
}
async function update(todo:Todo,patch:Record<string,unknown>){
 if(busy.value.has(todo.id))return false;busy.value.add(todo.id);error.value="";
 try{await api(`/todos/${todo.id}`,{method:"PATCH",body:JSON.stringify(patch)});await load();notice.value="待办已更新";return true;}
 catch(e){error.value=`修改失败：${(e as Error).message}`;return false;}
 finally{busy.value.delete(todo.id);}
}
function localDate(value?:string) { if(!value)return "";const date=new Date(value);return new Date(date.valueOf()-date.getTimezoneOffset()*60000).toISOString().slice(0,16); }
async function changeStatus(todo:Todo,event:Event) {
 const input=event.target as HTMLSelectElement;
 const previous=todo.status;
 if(!await update(todo,{status:input.value})) input.value=previous;
}
function edit(todo:Todo){editing.value=todo;form.value={title:todo.title,description:todo.description,owner:todo.owner,dueAt:localDate(todo.dueAt)};originalForm=JSON.stringify(form.value);editError.value="";}
function canClose(){return !editing.value || (!busy.value.has(editing.value.id)&&(JSON.stringify(form.value)===originalForm||confirm("放弃未保存的修改？")));}
function closeEditor(){if(canClose())editing.value=null;}
onBeforeRouteLeave(()=>canClose());
async function save(){
 if(!editing.value)return;
 if(!form.value.title.trim()||!form.value.owner.trim()){editError.value="标题和责任人不能为空";return;}
 const date=form.value.dueAt?new Date(form.value.dueAt):null;
 if(date&&Number.isNaN(date.valueOf())){editError.value="截止时间无效，请重新选择。";return;}
 if(await update(editing.value,{title:form.value.title.trim(),description:form.value.description,owner:form.value.owner.trim(),dueAt:date?.toISOString()??null})){editing.value=null;}
 else{editError.value=`${error.value}。输入内容已保留，可重试。`;error.value="";}
}
async function remove(todo:Todo){
 if(busy.value.has(todo.id)||!confirm(`确认删除「${todo.title}」？`))return;
 busy.value.add(todo.id);error.value="";
 try{await api(`/todos/${todo.id}`,{method:"DELETE"});await load();notice.value="待办已删除";}
 catch(e){error.value=`删除失败：${(e as Error).message}`;}
 finally{busy.value.delete(todo.id);}
}
function reset(){status.value="";owner.value="";dueFrom.value="";dueTo.value="";query.value="";overdueOnly.value=false;sort.value="due";}
onMounted(()=>{void load();clock=setInterval(()=>now.value=Date.now(),60000);});
onUnmounted(()=>{loadEpoch++;if(clock)clearInterval(clock);});
</script>

<template>
 <div class="page">
  <div class="breadcrumb">工作空间 <span>/</span> 待办中心</div>
  <header class="page-header"><div><h1>待办中心</h1><p>跟进会议行动项，确认责任人和截止时间。</p></div><button class="secondary" :disabled="loading" @click="load"><RefreshCw :size="15"/>{{loading?'刷新中…':'刷新'}}</button></header>
  <p v-if="error" class="error callout" role="alert">{{error}}</p><p v-if="notice" class="notice" role="status">{{notice}}</p>
  <div class="task-summary"><div><span>全部待办</span><strong>{{loaded?counts.all:'—'}}</strong></div><div><span>未完成</span><strong>{{loaded?counts.open:'—'}}</strong></div><div><span>已逾期</span><strong :class="{overdue:counts.overdue}">{{loaded?counts.overdue:'—'}}</strong></div><div><span>已完成</span><strong>{{loaded?counts.done:'—'}}</strong></div></div>
  <div class="section-tabs"><button v-for="(label,key) in {'':'全部',...labels}" :key="key" :class="{active:status===key}" :aria-pressed="status===key" @click="status=key">{{label}}</button></div>
  <div class="data-toolbar"><label class="search-field"><Search :size="16"/><input v-model="query" aria-label="搜索待办" placeholder="搜索待办或会议名称"/></label><input v-model="owner" aria-label="筛选责任人" placeholder="筛选责任人"/><select v-model="sort" aria-label="待办排序"><option value="due">截止时间优先</option><option value="title">按标题排序</option></select><label class="checkbox-label"><input v-model="overdueOnly" type="checkbox"/>仅看逾期</label></div>
  <div class="date-filters"><span>截止日期</span><input v-model="dueFrom" type="date" aria-label="截止日期起"/><span>至</span><input v-model="dueTo" type="date" aria-label="截止日期止"/><button v-if="hasFilters" class="text-button" @click="reset">重置筛选</button><span class="result-count">{{invalidRange?0:filtered.length}} 项结果</span></div>
  <p v-if="invalidRange" class="error callout" role="alert">开始日期不能晚于结束日期。</p>
  <div class="list-card">
   <div v-if="loading && !loaded" class="empty-list" role="status">正在加载待办…</div>
   <div v-else-if="loaded && (!filtered.length || invalidRange)" class="empty-list"><CheckCircle2/><h3>{{hasFilters?'没有符合条件的待办':'暂无待办'}}</h3><p>{{hasFilters?'调整筛选条件，或重置后查看全部待办。':'会议分析中的行动项会显示在这里。'}}</p><button v-if="hasFilters" class="secondary" @click="reset">重置条件</button></div>
   <template v-else-if="!invalidRange"><article v-for="todo in filtered" :key="todo.id" class="todo-row" :class="{completed:todo.status==='COMPLETED'}">
    <button class="status-icon" :aria-label="todo.status==='COMPLETED'?'标记为待处理':'标记为已完成'" :disabled="busy.has(todo.id)" @click="update(todo,{status:todo.status==='COMPLETED'?'PENDING':'COMPLETED'})"><CheckCircle2 v-if="todo.status==='COMPLETED'"/><Circle v-else/></button>
    <div class="todo-main"><strong>{{todo.title}}</strong><p v-if="todo.description">{{todo.description}}</p><small>{{todo.meeting.title}} · 责任人：{{todo.owner}} · <span :class="{overdue:isOverdue(todo)}">截止：{{todo.dueAt?new Date(todo.dueAt).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'待确认'}}{{isOverdue(todo)?' · 已逾期':''}}</span></small><details v-if="todo.modelSuggestion && todo.editedFields?.length"><summary>查看重新分析的建议</summary><p>{{todo.modelSuggestion.title}} · {{todo.modelSuggestion.owner}} · {{todo.modelSuggestion.dueAt||'待确认'}}</p><p>{{todo.modelSuggestion.description}}</p><button class="text-button" :disabled="busy.has(todo.id)" @click="update(todo,todo.modelSuggestion)">采纳建议</button></details></div>
    <select :aria-label="`${todo.title}的状态`" :disabled="busy.has(todo.id)" :value="todo.status" @change="changeStatus(todo,$event)"><option v-for="(label,key) in labels" :key="key" :value="key">{{label}}</option></select><button class="icon" :disabled="busy.has(todo.id)" title="编辑" @click="edit(todo)"><Pencil :size="16"/></button><button class="icon danger" title="删除待办" :disabled="busy.has(todo.id)" @click="remove(todo)"><Trash2 :size="16"/></button>
   </article></template>
  </div>
  <EditDialog v-if="editing" title="编辑待办" :busy="busy.has(editing.id)" :error="editError" @close="closeEditor" @save="save"><fieldset :disabled="busy.has(editing.id)"><label>待办标题<input v-model="form.title" autofocus/></label><label>事项说明<textarea v-model="form.description" rows="3"/></label><div class="form-columns"><label>责任人<input v-model="form.owner"/></label><label>截止时间<input v-model="form.dueAt" type="datetime-local"/></label></div><p class="field-help">截止时间可留空。保存后会保留你的人工修改。</p></fieldset></EditDialog>
 </div>
</template>
