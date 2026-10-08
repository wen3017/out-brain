<script setup lang="ts">
import { onMounted, ref } from "vue";
import { X } from "lucide-vue-next";

const props = defineProps<{ title: string; busy: boolean; error?: string }>();
const emit = defineEmits<{ close: []; save: [] }>();
const dialog = ref<HTMLDialogElement>();
onMounted(() => dialog.value?.showModal());
function close() { if (!props.busy) emit("close"); }
</script>

<template>
  <dialog ref="dialog" class="edit-dialog" aria-labelledby="edit-dialog-title" @cancel.prevent="close">
    <form @submit.prevent="emit('save')">
      <header><h2 id="edit-dialog-title">{{ title }}</h2><button type="button" class="icon" aria-label="关闭编辑" :disabled="busy" @click="close"><X :size="18"/></button></header>
      <div class="dialog-fields"><slot/></div>
      <p v-if="error" class="error callout" role="alert">{{ error }}</p>
      <footer><button type="button" class="secondary" :disabled="busy" @click="close">取消</button><button class="primary compact" :disabled="busy">{{ busy ? '保存中…' : '保存修改' }}</button></footer>
    </form>
  </dialog>
</template>
