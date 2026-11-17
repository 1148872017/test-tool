let holder: any = null;

export function bindMessage(messageApi: any) {
  holder = messageApi;
}

export function toast(content: string, type: 'success' | 'error' | 'info' | 'warning' = 'success') {
  if (holder) holder.open({ type, content, duration: 1.8 });
}