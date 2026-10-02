<script setup lang="ts">
import { onMounted, ref } from "vue"; import { api } from "../api"; import { CheckCircle2, Circle, Pencil, Trash2 } from "lucide-vue-next";
type Todo={id:string;title:string;description:string;owner:string;dueAt?:string;status:string;meeting:{title:string};editedFields?:string[];modelSuggestion?:{title:string;description:string;owner:string;dueAt?:string}};
const todos=ref<Todo[]>([]);const status=ref("");const owner=ref("");const dueFrom=ref("");const dueTo=ref("");const loading=ref(false);const error=ref("");const busy=ref(new Set<string>());let loadEpoch=0;
async function load(clearError=true){
 const epoch=++loadEpoch;loading.value=true;if(clearError)error.value="";
 try{if(dueFrom.value&&dueTo.value&&dueFrom.value>dueTo.value)throw new Error("开始日期不能晚于结束日期");const q=new URLSearchParams();if(status.value)q.set("status",status.value);if(owner.value)q.set("owner",owner.value);if(dueFrom.value)q.set("dueFrom",dueFrom.value);if(dueTo.value)q.set("dueTo",dueTo.value);const result=await api<Todo[]>(`/todos?${q}`);if(epoch===loadEpoch)todos.value=result;}
 catch(e){if(epoch===loadEpoch)error.value=(e as Error).message;}
 finally{if(epoch===loadEpoch)loading.value=false;}
}
async function update(todo:Todo,patch:any){if(busy.value.has(todo.id))return;busy.value.add(todo.id);error.value="";try{await api(`/todos/${todo.id}`,{method:"PATCH",body:JSON.stringify(patch)});await load();}catch(e){error.value=`修改失败：${(e as Error).message}`;await load(false);}finally{busy.value.delete(todo.id);}}
async function edit(todo:Todo){
 error.value="";
 const title=prompt("待办标题",todo.title);if(title===null)return;
 const description=prompt("事项说明",todo.description);if(description===null)return;
 const ownerValue=prompt("责任人",todo.owner);if(ownerValue===null)return;
 const due=prompt("截止时间（ISO 格式或留空表示待确认）",todo.dueAt??"");if(due===null)return;
 if(!title.trim()||!ownerValue.trim()){error.value="标题和责任人不能为空";return;}
 const parsed=due.trim()?new Date(due):null;if(parsed&&Number.isNaN(parsed.valueOf())){error.value="截止时间无效，请输入有效日期，例如 2026-10-15 18:00";return;}
 await update(todo,{title:title.trim(),description,owner:ownerValue.trim(),dueAt:parsed?.toISOString()??null});
}
async function remove(id:string){if(busy.value.has(id)||!confirm("确认删除该待办？"))return;busy.value.add(id);error.value="";try{await api(`/todos/${id}`,{method:"DELETE"});await load();}catch(e){error.value=`删除失败：${(e as Error).message}`;}finally{busy.value.delete(id);}}
onMounted(()=>void load());
</script>
<template><div class="page"><header class="page-header"><div><h1>待办中心</h1><p>集中处理会议中自动识别的承诺闭环事项</p></div></header><p v-if="error" class="error" role="alert">{{error}}</p><div class="filters"><select v-model="status" @change="load()"><option value="">全部状态</option><option value="PENDING">待处理</option><option value="IN_PROGRESS">进行中</option><option value="COMPLETED">已完成</option><option value="CANCELLED">已取消</option></select><input v-model="owner" placeholder="筛选责任人" @keyup.enter="load()"/><input v-model="dueFrom" type="date" title="截止日期起"/><input v-model="dueTo" type="date" title="截止日期止"/><button @click="load()">筛选</button></div><div class="list-card"><div v-if="loading" class="muted">加载中…</div><div v-else-if="!todos.length" class="empty-list">暂无待办</div><article v-for="todo in todos" :key="todo.id" class="todo-row"><button class="status-icon" :disabled="busy.has(todo.id)" @click="update(todo,{status:todo.status==='COMPLETED'?'PENDING':'COMPLETED'})"><CheckCircle2 v-if="todo.status==='COMPLETED'"/><Circle v-else/></button><div class="todo-main"><strong>{{todo.title}}</strong><p>{{todo.description}}</p><small>{{todo.meeting.title}} · 责任人：{{todo.owner}} · 截止：{{todo.dueAt?new Date(todo.dueAt).toLocaleString():'待确认'}}</small><details v-if="todo.modelSuggestion && todo.editedFields?.length"><summary>模型最新建议（人工字段保留）</summary><p>{{todo.modelSuggestion.title}} · {{todo.modelSuggestion.owner}} · {{todo.modelSuggestion.dueAt||"待确认"}}</p><p>{{todo.modelSuggestion.description}}</p><button @click="update(todo,todo.modelSuggestion)">采纳建议</button></details></div><select :disabled="busy.has(todo.id)" :value="todo.status" @change="update(todo,{status:($event.target as HTMLSelectElement).value})"><option value="PENDING">待处理</option><option value="IN_PROGRESS">进行中</option><option value="COMPLETED">已完成</option><option value="CANCELLED">已取消</option></select><button class="icon" :disabled="busy.has(todo.id)" title="编辑" @click="edit(todo)"><Pencil :size="17"/></button><button class="icon danger" :disabled="busy.has(todo.id)" @click="remove(todo.id)"><Trash2 :size="17"/></button></article></div></div></template>
