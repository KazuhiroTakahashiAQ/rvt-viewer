import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ja from './locales/ja.json';

/**
 * Supported UI languages. Adding one = add `locales/<lng>.json` with the
 * same keys as `ja.json` and list it here.
 */
export const SUPPORTED_LANGUAGES = ['ja'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'ja';

export const resources = {
  ja: { translation: ja },
} as const;

void i18n.use(initReactI18next).init({
  resources,
  lng: DEFAULT_LANGUAGE,
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: [...SUPPORTED_LANGUAGES],
  interpolation: { escapeValue: false },
  returnNull: false,
});

const syncHtmlLang = (lng: string) => {
  document.documentElement.lang = lng;
};
syncHtmlLang(i18n.language);
i18n.on('languageChanged', syncHtmlLang);

/** Current locale for Intl formatting. */
export const currentLocale = (): string => i18n.language || DEFAULT_LANGUAGE;

export default i18n;
