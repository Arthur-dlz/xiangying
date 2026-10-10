<script setup lang="ts">
import { withBase } from "vitepress";
</script>

<template>
  <section class="home-topics" aria-labelledby="home-topics-title">
    <header class="home-topics__header">
      <h2 id="home-topics-title">专题阅读</h2>
      <a class="home-topics__all" :href="withBase('/blog/')">查看全部文章</a>
    </header>

    <div class="home-topics__grid">
      <a
        class="home-topics__item home-topics__item--primary"
        :href="withBase('/blog/video-downloader-recommendation/')"
      >
        <strong>视频下载器推荐</strong>
        <p>
          按免费、电脑端、M3U8、IDM、yt-dlp、猫抓和 NAS 场景梳理主流工具怎么选。
        </p>
      </a>

      <a
        class="home-topics__item home-topics__item--secondary"
        :href="withBase('/blog/video-download/')"
      >
        <strong>网页视频下载指南</strong>
        <p>
          了解网页视频下载的常见入口、工具选择和 MediaGo
          的内置浏览器、扩展、队列工作流。
        </p>
      </a>

      <a
        class="home-topics__item home-topics__item--secondary"
        :href="withBase('/blog/m3u8-hls-download/')"
      >
        <strong>M3U8 / HLS 专题</strong>
        <p>
          解释 M3U8、HLS、DASH、直播流和分段视频的关系，以及常见下载失败原因。
        </p>
      </a>
    </div>
  </section>
</template>
