<script setup lang="ts">
import { RouterView, useRoute, useRouter } from "vue-router";
import { MessageSquarePlus, MessageSquare, CheckSquare, BookOpen, LogOut, PanelsTopLeft, FileClock, Settings } from "lucide-vue-next";
import { useAuthStore } from "./stores/auth";
import { confirmUnsavedChanges } from "./unsaved-changes";
const auth = useAuthStore(); const route = useRoute(); const router = useRouter();
async function logout() { if(!confirmUnsavedChanges())return;await auth.logout(); router.push("/login"); }
</script>

<template>
  <RouterView v-if="route.path === '/login'" />
  <div v-else class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark"><PanelsTopLeft :size="20"/></span><div><strong>NBBOSS</strong><small>个人工作空间</small></div></div>
      <button class="new-chat" @click="router.push('/')"><MessageSquarePlus :size="17"/> 新建会话</button>
      <div class="nav-label">工作空间</div>
      <nav aria-label="主导航">
        <button :class="{active: route.path.startsWith('/chat') || route.path === '/'}" @click="router.push('/')"><MessageSquare :size="17"/>对话</button>
        <button :class="{active: route.path === '/todos'}" @click="router.push('/todos')"><CheckSquare :size="17"/>待办中心</button>
        <button :class="{active: route.path === '/memories'}" @click="router.push('/memories')"><BookOpen :size="17"/>记忆管理</button>
        <button :class="{active: route.path === '/logs'}" @click="router.push('/logs')"><FileClock :size="17"/>日志中心</button>
        <button :class="{active: route.path === '/account'}" @click="router.push('/account')"><Settings :size="17"/>账号设置</button>
      </nav>
      <div class="sidebar-footer"><span class="avatar">{{ auth.user?.username?.slice(0, 1).toUpperCase() }}</span><span :title="auth.user?.username">{{ auth.user?.username }}<small>个人工作空间</small></span><button title="退出" @click="logout"><LogOut :size="16"/></button></div>
    </aside>
    <main class="main"><RouterView /></main>
  </div>
</template>
