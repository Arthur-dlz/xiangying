<script setup lang="ts">
import { computed } from "vue";
import { useData, withBase } from "vitepress";
import { useLayout } from "vitepress/theme";

const messages = {
  en: {
    slogan: "Easy to use, fast download",
    help: "Quick start",
    blog: "Blog",
    privacy: "Privacy",
    repository: "GitHub",
    navigation: "Footer navigation",
  },
  jp: {
    slogan: "使いやすく、ダウンロードも速い",
    help: "クイックスタート",
    blog: "ブログ",
    privacy: "プライバシー",
    repository: "GitHub",
    navigation: "フッターナビゲーション",
  },
  zh: {
    slogan: "简单易用，快速下载",
    help: "快速开始",
    blog: "博客",
    privacy: "隐私",
    repository: "GitHub",
    navigation: "页脚导航",
  },
  it: {
    slogan: "Facile da usare, download veloce",
    help: "Avvio rapido",
    blog: "Blog",
    privacy: "Privacy",
    repository: "GitHub",
    navigation: "Navigazione nel piè di pagina",
  },
} as const;

type MessageKey = keyof (typeof messages)["zh"];
type SupportedLocale = keyof typeof messages;

function isSupportedLocale(locale: string): locale is SupportedLocale {
  return (
    locale === "en" || locale === "jp" || locale === "zh" || locale === "it"
  );
}

const { frontmatter, lang } = useData();
const { hasSidebar } = useLayout();
const isHome = computed(() => frontmatter.value.layout === "home");
const currentYear = new Date().getFullYear();
const locale = computed<SupportedLocale>(() =>
  isSupportedLocale(lang.value) ? lang.value : "zh",
);
const localizedMessages = computed(() => messages[locale.value]);
const localePrefix = computed(() =>
  locale.value === "zh" ? "" : `/${locale.value}`,
);
const homeLink = computed(() => withBase(`${localePrefix.value}/`));
const guideLink = computed(() => withBase(`${localePrefix.value}/guides`));
const privacyLink = computed(() => withBase(`${localePrefix.value}/privacy`));
const blogLink = computed(() =>
  withBase(locale.value === "en" ? "/en/blog/" : "/blog/"),
);

function t(key: MessageKey) {
  return localizedMessages.value[key];
}
</script>

<template>
  <footer
    class="docs-footer"
    :class="{
      'has-sidebar': hasSidebar,
      'is-home': isHome,
      'is-article': !isHome,
    }"
  >
    <div v-if="isHome" class="docs-footer__home">
      <div class="docs-footer__primary">
        <a class="docs-footer__brand" :href="homeLink">
          <img :src="withBase('/favicon.ico')" alt="" width="28" height="28" />
          <span>
            <strong>MediaGo</strong>
            <small>{{ t("slogan") }}</small>
          </span>
        </a>

        <nav class="docs-footer__links" :aria-label="t('navigation')">
          <a :href="guideLink">{{ t("help") }}</a>
          <a :href="blogLink">{{ t("blog") }}</a>
          <a :href="privacyLink">{{ t("privacy") }}</a>
          <a
            href="https://github.com/caorushizi/mediago"
            target="_blank"
            rel="noopener noreferrer"
          >
            {{ t("repository") }}
          </a>
        </nav>
      </div>

      <div class="docs-footer__meta">
        <span>Copyright © {{ currentYear }} MediaGo</span>
        <a
          href="https://beian.miit.gov.cn"
          target="_blank"
          rel="noopener noreferrer"
        >
          豫ICP备20012967号-2
        </a>
      </div>
    </div>

    <div v-else class="docs-footer__article">
      <span class="docs-footer__copyright">
        Copyright © {{ currentYear }} MediaGo
      </span>

      <nav class="docs-footer__article-links" :aria-label="t('navigation')">
        <a :href="guideLink">{{ t("help") }}</a>
        <a :href="blogLink">{{ t("blog") }}</a>
        <a :href="privacyLink">{{ t("privacy") }}</a>
        <a
          href="https://github.com/caorushizi/mediago"
          target="_blank"
          rel="noopener noreferrer"
        >
          {{ t("repository") }}
        </a>
        <a
          href="https://beian.miit.gov.cn"
          target="_blank"
          rel="noopener noreferrer"
        >
          豫ICP备20012967号-2
        </a>
      </nav>
    </div>
  </footer>
</template>

<style scoped>
.docs-footer {
  position: relative;
  z-index: 1;
  background: var(--vp-c-bg);
}

.docs-footer.is-home {
  border-top: 1px solid var(--vp-c-divider);
}

.docs-footer__home,
.docs-footer__article {
  margin: 0 auto;
  max-width: 1160px;
}

.docs-footer__home {
  padding: 36px 24px;
}

.docs-footer__primary,
.docs-footer__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}

.docs-footer__brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: var(--vp-c-text-1);
  text-decoration: none;
}

.docs-footer__brand img {
  flex: 0 0 auto;
  border-radius: 5px;
}

.docs-footer__brand span {
  display: grid;
  gap: 2px;
}

.docs-footer__brand strong {
  line-height: 20px;
  font-size: 14px;
  font-family: var(--mg-font-display);
  font-weight: 650;
}

.docs-footer__brand small {
  line-height: 20px;
  font-size: 12.5px;
  color: var(--vp-c-text-2);
}

.docs-footer__links {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px 20px;
}

.docs-footer__links a,
.docs-footer__meta a {
  color: var(--vp-c-text-2);
  font-size: 13px;
  font-weight: 540;
  text-decoration: none;
  transition: color 280ms cubic-bezier(0.16, 1, 0.3, 1);
}

.docs-footer__links a:hover,
.docs-footer__meta a:hover,
.docs-footer__article-links a:hover {
  color: var(--vp-c-brand-1);
}

.docs-footer__meta {
  margin-top: 22px;
  padding-top: 18px;
  border-top: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-2);
  font-size: 12px;
}

.docs-footer__article {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px 32px;
  width: calc(100% - 48px);
  min-height: 60px;
  border-top: 1px solid var(--vp-c-divider);
  padding: 18px 0 20px;
  color: var(--vp-c-text-2);
  font-size: 12px;
}

.docs-footer__copyright {
  flex: 0 0 auto;
}

.docs-footer__article-links {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px 18px;
}

.docs-footer__article-links a {
  color: var(--vp-c-text-2);
  font-size: 12px;
  font-weight: 540;
  text-decoration: none;
  transition: color 180ms ease;
}

@media (min-width: 768px) {
  .docs-footer__article {
    width: calc(100% - 64px);
  }
}

@media (min-width: 960px) {
  .docs-footer.has-sidebar {
    padding-left: var(--vp-sidebar-width);
  }
}

@media (min-width: 1440px) {
  .docs-footer.has-sidebar {
    padding-left: calc(
      (100% - var(--vp-layout-max-width)) / 2 + var(--vp-sidebar-width)
    );
    padding-right: calc((100% - var(--vp-layout-max-width)) / 2);
  }
}

@media (max-width: 767px) {
  .docs-footer__primary,
  .docs-footer__meta {
    align-items: flex-start;
    flex-direction: column;
  }

  .docs-footer__links {
    justify-content: flex-start;
  }

  .docs-footer__article {
    align-items: flex-start;
    flex-direction: column;
    padding-top: 20px;
    padding-bottom: 22px;
  }

  .docs-footer__article-links {
    justify-content: flex-start;
  }
}
</style>
