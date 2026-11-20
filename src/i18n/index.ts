import en from './en.json';
import es from './es.json';
import pt from './pt.json';
import de from './de.json';
import fr from './fr.json';
import ja from './ja.json';
import zh from './zh.json';
import ru from './ru.json';

export const LANGUAGES = [
  { code: 'en', label: 'English', short: 'EN' },
  { code: 'es', label: 'Español', short: 'ES' },
  { code: 'pt', label: 'Português', short: 'PT' },
  { code: 'de', label: 'Deutsch', short: 'DE' },
  { code: 'fr', label: 'Français', short: 'FR' },
  { code: 'ja', label: '日本語', short: 'JA' },
  { code: 'zh', label: '简体中文', short: 'ZH' },
  { code: 'ru', label: 'Русский', short: 'RU' },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];
export type TranslationKey = keyof typeof en;
export type Dictionary = Record<TranslationKey, string>;

export const DEFAULT_LANG: LanguageCode = 'en';
export const LANG_STORAGE_KEY = 'phonewebcam-lang';
export const LANG_CHANGE_EVENT = 'phonewebcam:lang-change';

export const translations: Record<LanguageCode, Dictionary> = {
  en,
  es,
  pt,
  de,
  fr,
  ja,
  zh,
  ru,
};

export function isValidLang(value: string | null | undefined): value is LanguageCode {
  if (!value) return false;
  return LANGUAGES.some((lang) => lang.code === value);
}

export function getStoredLang(): LanguageCode {
  if (typeof window === 'undefined') return DEFAULT_LANG;
  try {
    const saved = window.localStorage.getItem(LANG_STORAGE_KEY);
    if (isValidLang(saved)) return saved;
  } catch {
    // Ignore storage access errors in private contexts
  }
  return DEFAULT_LANG;
}

export function translate(lang: LanguageCode, key: TranslationKey): string {
  const dict = translations[lang] ?? translations[DEFAULT_LANG];
  return dict[key] ?? translations[DEFAULT_LANG][key] ?? key;
}

export function applyTranslationsToDom(lang: LanguageCode): void {
  if (typeof document === 'undefined') return;
  const dict = translations[lang] ?? translations[DEFAULT_LANG];

  document.documentElement.lang = lang;

  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n as TranslationKey | undefined;
    if (key && dict[key]) {
      el.textContent = dict[key];
    }
  });

  document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => {
    const key = el.dataset.i18nAria as TranslationKey | undefined;
    if (key && dict[key]) {
      el.setAttribute('aria-label', dict[key]);
    }
  });

  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    const key = el.dataset.i18nTitle as TranslationKey | undefined;
    if (key && dict[key]) {
      el.setAttribute('title', dict[key]);
    }
  });

  document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]').forEach((el) => {
    const key = el.dataset.i18nPlaceholder as TranslationKey | undefined;
    if (key && dict[key]) {
      el.placeholder = dict[key];
    }
  });

  // Update page title only on the homepage where data-i18n-page="home" is marked
  if (document.documentElement.dataset.i18nPage === 'home' && dict['meta.title']) {
    document.title = dict['meta.title'];
  }
}

export function setAppLanguage(lang: LanguageCode): void {
  if (!isValidLang(lang)) return;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(LANG_STORAGE_KEY, lang);
    } catch {
      // Ignore storage errors
    }
    applyTranslationsToDom(lang);
    window.dispatchEvent(new CustomEvent<LanguageCode>(LANG_CHANGE_EVENT, { detail: lang }));
  }
}
