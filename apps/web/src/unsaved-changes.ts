let confirmDiscard: (() => boolean) | undefined;

export function registerUnsavedChangesGuard(guard: () => boolean) {
  confirmDiscard = guard;
  return () => { if (confirmDiscard === guard) confirmDiscard = undefined; };
}

export function confirmUnsavedChanges() { return confirmDiscard?.() ?? true; }
