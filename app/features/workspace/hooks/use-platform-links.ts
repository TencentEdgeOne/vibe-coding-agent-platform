'use client';

import { useEffect, useState } from 'react';
import {
  TENCENT_CLOUD_CONTACT_URL,
  extractProjectName,
  getContactUrl,
  getMakersModelsDocsUrl,
  getTemplateDeployUrl,
} from '@/app/lib/conversation';
import { LANGUAGE_STORAGE_KEY, type Locale } from '@/app/i18n';

export function usePlatformLinks(language: Locale, setLanguage: (locale: Locale) => void) {
  const [contactUrl, setContactUrl] = useState(TENCENT_CLOUD_CONTACT_URL);
  const [templateDeployUrl, setTemplateDeployUrl] = useState(() => getTemplateDeployUrl(''));
  const [makersModelsDocsUrl, setMakersModelsDocsUrl] = useState(() => getMakersModelsDocsUrl(''));

  useEffect(() => {
    const { domain } = extractProjectName();
    setContactUrl(getContactUrl(domain));
    setTemplateDeployUrl(getTemplateDeployUrl(domain));
    setMakersModelsDocsUrl(getMakersModelsDocsUrl(domain));
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored === 'zh' || stored === 'en') {
      setLanguage(stored);
    }
  }, [setLanguage]);

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  }, [language]);

  return {
    contactUrl,
    templateDeployUrl,
    makersModelsDocsUrl,
  };
}
