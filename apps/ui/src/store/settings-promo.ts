import { create } from "zustand";

export type SettingsPromoPlacement = "settings" | "sidebar";

const PLACEMENT_STORAGE_KEY = "mediago:settings-promo-placement:v1";
const PLACEMENT_SCHEMA_VERSION = 1;

interface StoredSettingsPromoPlacement {
  schemaVersion: 1;
  campaignId: string;
  placement: SettingsPromoPlacement;
}

interface SettingsPromoPlacementState {
  campaignId: string;
  placement: SettingsPromoPlacement;
  setPlacement: (campaignId: string, placement: SettingsPromoPlacement) => void;
}

function readPlacement(): StoredSettingsPromoPlacement | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(
      window.localStorage.getItem(PLACEMENT_STORAGE_KEY) || "null",
    ) as Partial<StoredSettingsPromoPlacement> | null;
    if (
      value?.schemaVersion !== PLACEMENT_SCHEMA_VERSION ||
      typeof value.campaignId !== "string" ||
      (value.placement !== "settings" && value.placement !== "sidebar")
    ) {
      return null;
    }
    return {
      schemaVersion: PLACEMENT_SCHEMA_VERSION,
      campaignId: value.campaignId,
      placement: value.placement,
    };
  } catch {
    return null;
  }
}

function writePlacement(
  campaignId: string,
  placement: SettingsPromoPlacement,
): void {
  try {
    window.localStorage.setItem(
      PLACEMENT_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: PLACEMENT_SCHEMA_VERSION,
        campaignId,
        placement,
      } satisfies StoredSettingsPromoPlacement),
    );
  } catch {
    // The placement still changes for this session when storage is unavailable.
  }
}

const initialPlacement = readPlacement();

export const useSettingsPromoPlacementStore =
  create<SettingsPromoPlacementState>((set) => ({
    campaignId: initialPlacement?.campaignId ?? "",
    placement: initialPlacement?.placement ?? "sidebar",
    setPlacement: (campaignId, placement) => {
      writePlacement(campaignId, placement);
      set({ campaignId, placement });
    },
  }));

export function resolveSettingsPromoPlacement(
  state: Pick<SettingsPromoPlacementState, "campaignId" | "placement">,
  campaignId: string,
): SettingsPromoPlacement {
  return state.campaignId === campaignId ? state.placement : "sidebar";
}
