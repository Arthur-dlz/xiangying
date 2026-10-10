export type ResourceCategory = "电影与剧集" | "少儿与动画" | "纪录片" | "短片";

export type ResourceSite = {
  name: string;
  url: string;
  categories: ResourceCategory[];
  mark: string;
};

export const RESOURCE_CATEGORIES = [
  "全部",
  "电影与剧集",
  "少儿与动画",
  "纪录片",
  "短片",
] as const;

export type ResourceCategoryFilter = (typeof RESOURCE_CATEGORIES)[number];

export const RESOURCE_SITES: ResourceSite[] = [
  {
    name: "1905电影网",
    url: "https://www.1905.com/vod/",
    categories: ["电影与剧集"],
    mark: "1905",
  },
  {
    name: "爱奇艺",
    url: "https://www.iqiyi.com/",
    categories: ["电影与剧集"],
    mark: "爱",
  },
  {
    name: "腾讯视频",
    url: "https://v.qq.com/",
    categories: ["电影与剧集"],
    mark: "腾",
  },
  {
    name: "优酷",
    url: "https://www.youku.com/",
    categories: ["电影与剧集"],
    mark: "优",
  },
  {
    name: "芒果TV",
    url: "https://www.mgtv.com/",
    categories: ["电影与剧集"],
    mark: "芒",
  },
  {
    name: "哔哩哔哩",
    url: "https://www.bilibili.com/",
    categories: ["电影与剧集", "少儿与动画", "纪录片", "短片"],
    mark: "哔",
  },
  {
    name: "央视节目",
    url: "https://tv.cctv.com/",
    categories: ["电影与剧集", "少儿与动画"],
    mark: "央",
  },
  {
    name: "央视纪录",
    url: "https://jishi.cctv.com/",
    categories: ["纪录片"],
    mark: "纪",
  },
  {
    name: "央视少儿",
    url: "https://tv.cctv.com/cctv14/",
    categories: ["少儿与动画"],
    mark: "少",
  },
  {
    name: "新片场",
    url: "https://www.xinpianchang.com/",
    categories: ["短片"],
    mark: "新",
  },
];

export function filterResourceSites(category: ResourceCategoryFilter) {
  return category === "全部"
    ? RESOURCE_SITES
    : RESOURCE_SITES.filter((site) => site.categories.includes(category));
}
