<script setup lang="ts">
import { onMounted, ref } from "vue"; import { useRoute, useRouter } from "vue-router"; import { ArrowRight, BookOpen, Check, FileText, PanelsTopLeft } from "lucide-vue-next"; import { useAuthStore } from "../stores/auth";
import { api } from "../api";
const route = useRoute(); const registrationEnabled = ref(false);
onMounted(async () => { try { registrationEnabled.value = (await api<{registrationEnabled:boolean}>("/auth/options")).registrationEnabled; } catch { /* Login remains available if the status request fails. */ } });
const username = ref(""); const password = ref(""); const register = ref(false); const loading = ref(false); const error = ref(""); const auth = useAuthStore(); const router = useRouter();
async function submit() { loading.value = true; error.value = ""; try { await auth.login(username.value, password.value, register.value); router.push("/"); } catch (e) { error.value = e instanceof Error ? e.message : "登录失败"; } finally { loading.value = false; } }
</script>
<template>
  <div class="login-page">
    <section class="login-story">
      <div class="login-logo"><span class="brand-mark"><PanelsTopLeft :size="21"/></span> NBBOSS</div>
      <div class="login-story-content"><h2>会话、会议和待办，<br/>集中在一个工作空间。</h2><p>查阅文档、整理会议记录，<br/>跟进事项并保存常用信息。</p>
        <div class="story-preview"><div class="story-preview-heading"><span class="mode-icon"><FileText :size="21"/></span><div><strong>在这里可以做什么</strong><small>常用功能</small></div><FileText :size="19"/></div><div class="story-line"><Check :size="16"/> 上传 PDF，查找和讨论文档内容</div><div class="story-line"><Check :size="16"/> 整理会议记录，查看纪要和待办</div><div class="story-line"><Check :size="16"/> 保存人物、地点等信息并随时修正</div><div class="story-preview-footer"><BookOpen :size="15"/> 已有账号？在右侧登录 <ArrowRight :size="15"/></div></div>
      </div><small class="login-story-footer">NBBOSS · 工作空间</small>
    </section>
    <section class="login-form-side"><div class="login-card"><h1>{{ register ? '创建账号' : '欢迎回来' }}</h1><p>{{ register ? '注册后即可使用个人工作空间' : '登录你的工作空间' }}</p><p v-if="route.query.passwordChanged" role="status">密码已修改，请重新登录。</p><form @submit.prevent="submit"><label>用户名<input v-model="username" autocomplete="username" placeholder="3-32 个字符" required minlength="3" maxlength="32"/></label><label>密码<input v-model="password" type="password" :autocomplete="register ? 'new-password' : 'current-password'" placeholder="至少 8 位" required minlength="8" maxlength="128"/></label><p v-if="error" class="error" role="alert">{{ error }}</p><button class="primary" :disabled="loading">{{ loading ? '请稍候…' : register ? '注册并登录' : '登录' }}<ArrowRight :size="17"/></button></form><button v-if="registrationEnabled" class="link" :disabled="loading" @click="register = !register; error = ''">{{ register ? '已有账号？登录' : '没有账号？立即注册' }}</button><div class="login-form-note"><BookOpen :size="14"/> 会话 · 文件 · 待办 · 记录</div></div></section>
  </div>
</template>
