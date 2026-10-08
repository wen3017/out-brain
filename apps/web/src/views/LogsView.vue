<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ChevronDown, ChevronLeft, ChevronRight, Copy, Download, FileClock, RefreshCw, Search } from "lucide-vue-next";
import { api } from "../api";

type Entry={id:string;createdAt:string;level:string;service:string;category:string;operation:string;status:string;traceId:string;resourceId?:string;errorCode?:string;durationMs?:number;attempt?:number;httpStatus?:number};
type Result={items:Entry[];total:number;counts:Record<string,number>;retentionDays:number;nextCursor:string|null};
const result=ref<Result|null>(null),loading=ref(false),error=ref(""),notice=ref("");
const level=ref(""),category=ref(""),query=ref(""),from=ref(""),to=ref("");
const cursors=ref<string[]>([""]),page=ref(0),expanded=ref("");
let applied=new URLSearchParams(),epoch=0;
const categories:Record<string,string>={OPERATION:"操作记录",TASK:"后台任务",CONVERSATION:"对话执行",SYSTEM:"系统事件"};
const levels:Record<string,string>={INFO:"正常",WARN:"提醒",ERROR:"错误"};
const statuses:Record<string,string>={COMPLETED:"已完成",FAILED:"失败",RETRYING:"重试中",ABORTED:"已停止",RUNNING:"运行中"};
const operations:Record<string,string>={"agent.run":"对话执行","file.parse":"文件解析","meeting.analyze":"会议分析","memory.extract":"记忆整理","presentation.generate":"生成演示文稿","auth.logout":"退出登录"};
function operationLabel(value:string){
 if(operations[value])return operations[value];
 const [method,path]=value.split(' ');
 const names:Record<string,string>={auth:"账号",conversations:"会话",files:"文件",todos:"待办",memories:"记忆",presentations:"演示文稿","presentation-versions":"演示版本"};
 const action:Record<string,string>={POST:"提交",PATCH:"修改",DELETE:"删除",GET:"读取",PUT:"更新"};
 if(path?.endsWith('/auth/login'))return '登录';if(path?.endsWith('/auth/register'))return '注册账号';
 const module=path?.replace(/^\/api\//,'').split('/')[0];
 return module&&names[module]?`${action[method??'']??method}${names[module]}`:value;
}
const visibleRange=computed(()=>result.value?.items.length?`${page.value*50+1}–${page.value*50+result.value.items.length}`:'0');
function localTime(date:Date){return new Date(date.valueOf()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);}
function quickRange(days:number){from.value=localTime(new Date(Date.now()-days*86400000));to.value="";void apply();}
async function apply(){
 error.value="";notice.value="";
 const start=from.value?new Date(from.value):null,end=to.value?new Date(to.value):null;
 if((start&&Number.isNaN(start.valueOf()))||(end&&Number.isNaN(end.valueOf()))){error.value="请选择有效时间";return;}
 if(start&&end&&start>end){error.value="开始时间不能晚于结束时间";return;}
 const params=new URLSearchParams({limit:'50'});
 if(level.value)params.set('level',level.value);if(category.value)params.set('category',category.value);
 if(query.value.trim())params.set('q',query.value.trim());
 if(start)params.set('from',start.toISOString());if(end)params.set('to',end.toISOString());
 applied=params;cursors.value=[''];page.value=0;await load();
}
async function load(){
 const request=++epoch;loading.value=true;error.value="";expanded.value="";result.value=null;
 const params=new URLSearchParams(applied);const cursor=cursors.value[page.value];if(cursor)params.set('cursor',cursor);
 try{const value=await api<Result>(`/logs?${params}`);if(request===epoch)result.value=value;}
 catch(e){if(request===epoch)error.value=`日志加载失败：${(e as Error).message}`;}
 finally{if(request===epoch)loading.value=false;}
}
function next(){if(!result.value?.nextCursor||loading.value)return;cursors.value[page.value+1]=result.value.nextCursor;page.value++;void load();}
function previous(){if(page.value===0||loading.value)return;page.value--;void load();}
function reset(){level.value="";category.value="";query.value="";quickRange(7);}
async function copy(value:string){try{await navigator.clipboard.writeText(value);notice.value="参考编号已复制";}catch{notice.value="未能访问剪贴板，请从详情中手动复制参考编号。";}}
function download(){
 if(!result.value?.items.length)return;
 const blob=new Blob([JSON.stringify({exportedAt:new Date().toISOString(),scope:'current-page',filters:Object.fromEntries(applied),items:result.value.items},null,2)],{type:'application/json;charset=utf-8'});
 const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`nbboss-logs-${new Date().toISOString().slice(0,10)}-page-${page.value+1}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
onMounted(()=>quickRange(7));
</script>

<template>
 <div class="page logs-page">
  <div class="breadcrumb">工作空间 <span>/</span> 日志中心</div>
  <header class="page-header"><div><h1>日志中心</h1><p>查看自己的操作和任务记录，按参考编号定位问题。</p></div><div class="header-actions"><button class="secondary" :disabled="loading || !result?.items.length" @click="download"><Download :size="15"/>导出当前页</button><button class="secondary" :disabled="loading" @click="apply"><RefreshCw :size="15"/>刷新</button></div></header>
  <div class="log-policy"><FileClock :size="16"/><span>仅当前账号可见<span v-if="result"> · 保留最近 {{result.retentionDays}} 天</span> · 从日志功能启用后开始记录，不包含对话正文和文件内容。</span></div>
  <div class="task-summary log-summary"><div><span>当前筛选结果</span><strong>{{result?.total ?? '—'}}</strong></div><div v-for="(label,key) in levels" :key="key"><span>{{label}}</span><strong :class="{overdue:key==='ERROR'&&(result?.counts.ERROR??0)>0}">{{result ? result.counts[key]??0 : '—'}}</strong></div></div>
  <form @submit.prevent="apply">
   <div class="data-toolbar"><label class="search-field"><Search :size="16"/><input v-model="query" aria-label="搜索日志" placeholder="搜索参考编号、操作或错误码" maxlength="120"/></label><select v-model="level" aria-label="日志级别" @change="apply"><option value="">全部级别</option><option v-for="(label,key) in levels" :key="key" :value="key">{{label}}</option></select><select v-model="category" aria-label="日志分类" @change="apply"><option value="">全部分类</option><option v-for="(label,key) in categories" :key="key" :value="key">{{label}}</option></select><button class="primary compact" :disabled="loading">查询</button><button type="button" class="text-button" @click="reset">重置</button></div>
   <div class="date-filters"><label>开始 <input v-model="from" type="datetime-local" aria-label="日志开始时间"/></label><label>结束 <input v-model="to" type="datetime-local" aria-label="日志结束时间"/></label><button type="button" class="text-button" @click="quickRange(1)">最近 24 小时</button><button type="button" class="text-button" @click="quickRange(7)">最近 7 天</button><button type="button" class="text-button" @click="quickRange(result?.retentionDays ?? 30)">保留期内全部</button></div>
  </form>
  <p v-if="error" class="error callout" role="alert">{{error}} <button class="text-button" @click="apply">重试</button></p><p v-if="notice" class="notice" role="status">{{notice}}</p>
  <div v-if="loading" class="empty-list" role="status">正在加载日志…</div>
  <div v-else-if="result && !result.items.length" class="big-empty"><FileClock/><h3>没有符合条件的日志</h3><p>可以调整时间和筛选条件。新操作及后台任务完成后，点击刷新查看。</p><button class="secondary" @click="reset">重置筛选</button></div>
  <div v-else-if="result" class="log-table-wrap">
   <table class="log-table"><thead><tr><th>时间</th><th>级别</th><th>操作 / 任务</th><th>状态</th><th>耗时</th><th>参考编号</th><th><span class="sr-only">详情</span></th></tr></thead><tbody>
    <template v-for="entry in result.items" :key="entry.id"><tr><td><time>{{new Date(entry.createdAt).toLocaleString('zh-CN',{hour12:false})}}</time></td><td><span class="log-level" :class="entry.level.toLowerCase()">{{levels[entry.level]??entry.level}}</span></td><td><strong>{{operationLabel(entry.operation)}}</strong><small>{{categories[entry.category]}} · {{entry.service==='worker'?'后台服务':'接口服务'}}</small></td><td>{{statuses[entry.status]??entry.status}}</td><td>{{entry.durationMs==null?'—':entry.durationMs<1000?entry.durationMs+' ms':(entry.durationMs/1000).toFixed(1)+' s'}}</td><td><div class="trace-cell"><code :title="entry.traceId">{{entry.traceId}}</code><button class="icon" title="复制参考编号" @click="copy(entry.traceId)"><Copy :size="14"/></button></div></td><td><button class="icon" :aria-label="`日志详情：${operationLabel(entry.operation)}`" :aria-expanded="expanded===entry.id" @click="expanded=expanded===entry.id?'':entry.id"><ChevronDown :size="16"/></button></td></tr>
    <tr v-if="expanded===entry.id" class="log-detail"><td colspan="7"><dl><div><dt>参考编号</dt><dd>{{entry.traceId}}</dd></div><div><dt>操作标识</dt><dd>{{entry.operation}}</dd></div><div v-if="entry.resourceId"><dt>关联资源</dt><dd>{{entry.resourceId}}</dd></div><div v-if="entry.errorCode"><dt>错误码</dt><dd>{{entry.errorCode}}</dd></div><div v-if="entry.httpStatus"><dt>HTTP 状态</dt><dd>{{entry.httpStatus}}</dd></div><div v-if="entry.attempt"><dt>执行次数</dt><dd>第 {{entry.attempt}} 次</dd></div><div><dt>日志编号</dt><dd>{{entry.id}}</dd></div></dl><p>反馈问题时可提供参考编号、发生时间和错误码。</p></td></tr></template>
   </tbody></table>
  </div>
  <div v-if="result" class="log-pagination"><span>第 {{page+1}} 页 · 显示 {{visibleRange}} 条 / 共 {{result.total}} 条</span><div><button class="secondary" :disabled="page===0 || loading" @click="previous"><ChevronLeft :size="15"/>上一页</button><button class="secondary" :disabled="!result.nextCursor || loading" @click="next">下一页<ChevronRight :size="15"/></button></div></div>
 </div>
</template>
