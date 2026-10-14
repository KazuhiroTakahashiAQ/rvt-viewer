import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: {
    ...minimal2023Preset,
    maskable: { ...minimal2023Preset.maskable, padding: 0.1, resizeOptions: { background: '#5f1f24' } },
    apple: { ...minimal2023Preset.apple, padding: 0.1, resizeOptions: { background: '#5f1f24' } },
  },
  images: ['public/favicon.svg'],
});
