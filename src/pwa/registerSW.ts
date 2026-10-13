import { registerSW } from 'virtual:pwa-register';
import i18n from '../i18n';
import { useStore } from '../state/store';

let update: ((reload?: boolean) => Promise<void>) | null = null;

export function setupServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  update = registerSW({
    onNeedRefresh() {
      useStore.getState().pushToast('update', i18n.t('pwa.updateAvailable'));
    },
    onOfflineReady() {
      useStore.getState().pushToast('info', i18n.t('pwa.offlineReady'));
    },
  });
}

export async function updateApp(): Promise<void> {
  await update?.(true);
}
