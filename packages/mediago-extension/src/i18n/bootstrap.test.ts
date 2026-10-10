import { describe, expect, test } from "vitest";

import * as bootstrap from "./bootstrap";

interface LanguageTarget {
  lang: string;
}

interface LanguageEmitter {
  language: string;
  resolvedLanguage?: string;
  on(event: "languageChanged", listener: (language: string) => void): unknown;
  off(event: "languageChanged", listener: (language: string) => void): unknown;
}

type BindDocumentLanguage = (
  instance: LanguageEmitter,
  target: LanguageTarget,
) => () => void;

function languageBinder(): BindDocumentLanguage {
  const bind = (
    bootstrap as typeof bootstrap & {
      bindDocumentLanguage?: BindDocumentLanguage;
    }
  ).bindDocumentLanguage;
  expect(bind).toBeTypeOf("function");
  if (!bind) throw new Error("Document language binder is unavailable");
  return bind;
}

function languageEmitter(initial: string, resolved?: string) {
  const listeners = new Set<(language: string) => void>();
  const emitter: LanguageEmitter = {
    language: initial,
    resolvedLanguage: resolved,
    on(_event, listener) {
      listeners.add(listener);
      return emitter;
    },
    off(_event, listener) {
      listeners.delete(listener);
      return emitter;
    },
  };
  return {
    emitter,
    emit(language: string) {
      emitter.language = language;
      for (const listener of listeners) listener(language);
    },
    listenerCount: () => listeners.size,
  };
}

describe("bindDocumentLanguage", () => {
  test("sets the initial concrete language and tracks language changes", () => {
    const bind = languageBinder();
    const source = languageEmitter("zh-CN", "zh");
    const target = { lang: "en" };

    const unbind = bind(source.emitter, target);

    expect(target.lang).toBe("zh");
    source.emit("it-IT");
    expect(target.lang).toBe("it");
    expect(source.listenerCount()).toBe(1);

    unbind();
    source.emit("en-US");
    expect(target.lang).toBe("it");
    expect(source.listenerCount()).toBe(0);
  });
});
