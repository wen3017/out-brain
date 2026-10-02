<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute } from "vue-router";
import { api } from "../api";
import { registerUnsavedChangesGuard } from "../unsaved-changes";
import { Download, Plus, Save, Trash2, Type } from "lucide-vue-next";
type Element={id:string;type:"text"|"shape";text:string;x:number;y:number;w:number;h:number;fontSize:number;color:string;fill?:string;bold:boolean};
type Slide={id:string;title:string;notes:string;elements:Element[]};
type Version={id:string;version:number;slideJson:{title:string;slides:Slide[]};createdAt:string};
type Pres={id:string;title:string;versions:Version[]};
const route=useRoute();const data=ref<Pres|null>(null);const current=ref<Version|null>(null);
const slideIndex=ref(0);const selected=ref<string|null>(null);const saving=ref(false);const loading=ref(false);
const error=ref("");const notice=ref("");const baseline=ref("");let loadEpoch=0;
const dirty=computed(()=>!!current.value&&JSON.stringify(current.value.slideJson)!==baseline.value);
const slide=computed(()=>current.value?.slideJson.slides[slideIndex.value]);
function canLeave(){if(saving.value){error.value="正在保存，请稍候再离开。";return false;}return !dirty.value||window.confirm("有未保存的 PPT 修改，确认放弃这些修改？");}
function activateVersion(v:Version){current.value=structuredClone(v);baseline.value=JSON.stringify(v.slideJson);slideIndex.value=0;selected.value=null;}
async function load(){
 const epoch=++loadEpoch;loading.value=true;error.value="";notice.value="";data.value=null;current.value=null;
 try{const result=await api<Pres>(`/presentations/${route.params.id}/versions`);if(epoch!==loadEpoch)return;data.value=result;if(result.versions[0])activateVersion(result.versions[0]);}
 catch(e){if(epoch===loadEpoch)error.value=(e as Error).message;}
 finally{if(epoch===loadEpoch)loading.value=false;}
}
function selectVersion(v:Version){if(saving.value||!canLeave())return;activateVersion(JSON.parse(JSON.stringify(v)));error.value="";notice.value="";}
function addText(){if(!saving.value)slide.value?.elements.push({id:crypto.randomUUID(),type:"text",text:"新文本",x:1,y:1,w:4,h:.6,fontSize:20,color:"111827",bold:false});}
function removeElement(){if(saving.value||!slide.value||!selected.value)return;slide.value.elements=slide.value.elements.filter(e=>e.id!==selected.value);selected.value=null;}
async function save(){
 if(!current.value||!data.value||saving.value)return;saving.value=true;error.value="";notice.value="";
 try{const v=await api<Version>(`/presentations/${data.value.id}/versions`,{method:"POST",body:JSON.stringify({prompt:"网页编辑",document:current.value.slideJson})});data.value.versions.unshift(v);activateVersion(v);notice.value=`已保存为版本 ${v.version}`;}
 catch(e){error.value=`保存失败：${(e as Error).message}。当前修改仍保留，可修正后重试。`;}
 finally{saving.value=false;}
}
function download(){if(dirty.value){error.value="当前修改尚未保存，请先保存新版本再下载。";return;}if(current.value)window.open(`/api/presentation-versions/${current.value.id}/download`,"_blank");}
function beforeUnload(event:BeforeUnloadEvent){if(dirty.value||saving.value){event.preventDefault();event.returnValue="";}}
const unregisterGuard=registerUnsavedChangesGuard(canLeave);
onBeforeRouteLeave(to=>to.path==="/login"&&!localStorage.getItem("nbboss-user")?true:canLeave());onBeforeRouteUpdate(canLeave);
watch(()=>route.params.id,()=>void load(),{immediate:true});
onMounted(()=>window.addEventListener("beforeunload",beforeUnload));
onUnmounted(()=>{loadEpoch++;unregisterGuard();window.removeEventListener("beforeunload",beforeUnload);});
</script>
<template><div class="ppt-page" v-if="current&&data"><header class="ppt-toolbar"><div><h2>{{data.title}}</h2><span>版本 {{current.version}} {{dirty?"· 有未保存修改":""}}</span></div><div><button :disabled="saving" @click="addText"><Plus :size="16"/>文本</button><button :disabled="saving||!selected" @click="removeElement"><Trash2 :size="16"/>删除</button><button @click="download"><Download :size="16"/>下载</button><button class="primary compact" :disabled="saving" @click="save"><Save :size="16"/>保存新版本</button></div></header><p v-if="error" class="error callout" role="alert">{{error}}</p><p v-if="notice" role="status">{{notice}}</p><div class="ppt-workspace" :inert="saving||undefined"><aside class="slide-list"><button v-for="(s,i) in current.slideJson.slides" :key="s.id" :class="{selected:i===slideIndex}" @click="slideIndex=i;selected=null"><span>{{i+1}}</span><div class="mini-slide"><div v-for="el in s.elements" :key="el.id" class="mini-element" :style="{left:`${el.x/13.333*100}%`,top:`${el.y/7.5*100}%`,width:`${el.w/13.333*100}%`,height:`${el.h/7.5*100}%`,color:`#${el.color}`,background:el.type==='shape'?`#${el.fill??'EDE9FE'}`:'transparent'}">{{el.type==='text'?el.text:''}}</div></div></button></aside><main class="canvas-area"><div class="slide-canvas"><div v-for="el in slide?.elements" :key="el.id" :class="['slide-element',el.type,{selected:selected===el.id}]" :style="{left:`${el.x/13.333*100}%`,top:`${el.y/7.5*100}%`,width:`${el.w/13.333*100}%`,height:`${el.h/7.5*100}%`,fontSize:`${el.fontSize/9.59976}cqw`,color:`#${el.color}`,background:el.type==='shape'?`#${el.fill??'EDE9FE'}`:'transparent',fontWeight:el.bold?'700':'400'}" @click.stop="selected=el.id"><textarea v-if="el.type==='text'" v-model="el.text"/></div></div></main><aside class="property-panel"><template v-if="slide?.elements.find(e=>e.id===selected)"><h3><Type :size="16"/> 元素属性</h3><label>文字<textarea v-model="slide!.elements.find(e=>e.id===selected)!.text"/></label><label>字号<input v-model.number="slide!.elements.find(e=>e.id===selected)!.fontSize" type="number" min="8" max="72"/></label><label>颜色<input v-model="slide!.elements.find(e=>e.id===selected)!.color"/></label><div class="field-grid"><label>X<input v-model.number="slide!.elements.find(e=>e.id===selected)!.x" type="number" step=".1"/></label><label>Y<input v-model.number="slide!.elements.find(e=>e.id===selected)!.y" type="number" step=".1"/></label><label>宽<input v-model.number="slide!.elements.find(e=>e.id===selected)!.w" type="number" step=".1"/></label><label>高<input v-model.number="slide!.elements.find(e=>e.id===selected)!.h" type="number" step=".1"/></label></div></template><p v-else class="muted">选择画布元素后编辑属性</p><hr/><h3>历史版本</h3><button v-for="v in data.versions" :key="v.id" :class="['version',{active:v.id===current.id}]" @click="selectVersion(v)">版本 {{v.version}}<small>{{new Date(v.createdAt).toLocaleString()}}</small></button></aside></div></div><div v-else class="page"><p v-if="loading">正在加载演示文稿…</p><p v-else-if="error" class="error" role="alert">{{error}}</p><p v-else>暂无可编辑版本，请等待生成完成。</p><button v-if="!loading" @click="load">重新加载</button></div>
</template>
