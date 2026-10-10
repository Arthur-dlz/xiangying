export type PopupViewState =
  | "loading"
  | "load-error"
  | "needs-setup"
  | "connection-error"
  | "empty"
  | "ready";

export interface PopupViewStateInput {
  loading: boolean;
  loadError: boolean;
  needsSetup: boolean;
  connectionError: boolean;
  sourceCount: number;
}

export interface PopupImportDisabledInput {
  importing: boolean;
  inspecting: boolean;
  viewState: PopupViewState;
  sourceCount: number;
}

export function derivePopupViewState({
  loading,
  loadError,
  needsSetup,
  connectionError,
  sourceCount,
}: PopupViewStateInput): PopupViewState {
  if (loadError) return "load-error";
  if (loading) return "loading";
  if (needsSetup) return "needs-setup";
  if (connectionError) return "connection-error";
  if (sourceCount === 0) return "empty";
  return "ready";
}

export function isPopupImportDisabled({
  importing,
  inspecting,
  viewState,
  sourceCount,
}: PopupImportDisabledInput): boolean {
  return importing || inspecting || viewState !== "ready" || sourceCount === 0;
}
