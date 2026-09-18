'use client';

export type { Locale, HomeFeatureIcon } from './i18n/types.ts';
export { LANGUAGE_STORAGE_KEY } from './i18n/types.ts';
import type { Locale } from './i18n/types.ts';
import { zh } from './i18n/zh.ts';
import { en } from './i18n/en.ts';

export const TRANSLATIONS = { zh, en } as const;

export type UiCopy = (typeof TRANSLATIONS)[Locale];
export type FileCopy = UiCopy['files'];
export type SessionCopy = UiCopy['session'];
