import {
  CloudDownload,
  Library,
  ScanSearch,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { useLocation } from "react-router-dom";
import { isWeb } from "@/utils";

export interface NavigationItem {
  active: boolean;
  Icon: LucideIcon;
  key: "library" | "home" | "source" | "settings";
  label: string;
  to: string;
}

export function useNavigationItems(): NavigationItem[] {
  const { pathname } = useLocation();
  const items: NavigationItem[] = [
    {
      key: "source",
      to: "/source",
      label: "找视频",
      Icon: ScanSearch,
      active: pathname === "/source" || pathname === "/browser",
    },
    {
      key: "home",
      to: "/downloads",
      label: "下载任务",
      Icon: CloudDownload,
      active: pathname === "/downloads" || pathname === "/done",
    },
    {
      key: "library",
      to: "/",
      label: "我的片库",
      Icon: Library,
      active: pathname === "/" || pathname === "/library",
    },
    {
      key: "settings",
      to: "/settings",
      label: "设置",
      Icon: Settings,
      active: pathname === "/settings",
    },
  ];

  return isWeb ? items.filter((item) => item.key !== "source") : items;
}
