<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api";
import { useAuthStore } from "../stores/auth";
const current = ref(""); const password = ref(""); const confirmation = ref("");
const busy = ref(false); const error = ref(""); const router = useRouter(); const auth = useAuthStore();
async function save() {
  error.value = "";
  if (password.value !== confirmation.value) { error.value = "两次输入的新密码不一致"; return; }
  busy.value = true;
  try {
    await api("/auth/password", { method: "POST", body: JSON.stringify({ currentPassword: current.value, newPassword: password.value }) });
    auth.user = null; localStorage.removeItem("nbboss-user");
    await router.replace({ path: "/login", query: { passwordChanged: "1" } });
  } catch (e) { error.value = e instanceof Error ? e.message : "修改失败"; }
  finally { busy.value = false; }
}
</script>
<template>
  <section class="account-page">
    <h1>账号设置</h1><p>当前账号：{{ auth.user?.username }}</p>
    <form @submit.prevent="save">
      <h2>修改密码</h2><p>修改后所有设备上的登录都会失效，请使用新密码重新登录。</p>
      <label>当前密码<input v-model="current" type="password" autocomplete="current-password" required maxlength="128" :disabled="busy"/></label>
      <label>新密码<input v-model="password" type="password" autocomplete="new-password" required minlength="8" maxlength="128" :disabled="busy"/></label>
      <label>确认新密码<input v-model="confirmation" type="password" autocomplete="new-password" required minlength="8" maxlength="128" :disabled="busy"/></label>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button class="primary" :disabled="busy">{{ busy ? '正在保存…' : '修改密码' }}</button>
    </form>
  </section>
</template>
<style scoped>
.account-page{padding:32px;max-width:640px;margin:auto}.account-page form{margin-top:28px;display:grid;gap:18px}.account-page label{display:grid;gap:8px}.account-page p{color:var(--text-muted,#64748b);line-height:1.6}.account-page input{width:100%}.account-page h2{font-size:20px;margin:0}
</style>
