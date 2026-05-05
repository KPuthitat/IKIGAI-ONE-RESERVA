"use client";

import { createContext, useCallback, useContext, useMemo } from "react";
import { useRouter } from "next/navigation";
import { type Lang, t as tFn, formatDate as fdFn, formatDateLong as fdlFn } from "./i18n";

type Ctx = {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  formatDate: (d: string | Date) => string;
  formatDateLong: (d: string | Date) => string;
};

const LangContext = createContext<Ctx>({
  lang: "th",
  setLang: () => {},
  t: (k) => k,
  formatDate: (d) => String(d),
  formatDateLong: (d) => String(d)
});

export function LangProvider({
  lang,
  children
}: { lang: Lang; children: React.ReactNode }) {
  const router = useRouter();

  const setLang = useCallback((l: Lang) => {
    document.cookie = `lang=${l}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    router.refresh();
  }, [router]);

  const value = useMemo<Ctx>(() => ({
    lang,
    setLang,
    t: (key, vars) => tFn(lang, key, vars),
    formatDate: (d) => fdFn(d, lang),
    formatDateLong: (d) => fdlFn(d, lang)
  }), [lang, setLang]);

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang() {
  return useContext(LangContext);
}
