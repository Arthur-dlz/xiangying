import { useTranslation } from "react-i18next";

export function AppBootScreen() {
  const { t } = useTranslation();

  return (
    <div
      className="app-boot-screen"
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-testid="app-boot-screen"
    >
      <img
        className="app-boot-illustration"
        src="/startup-illustration.png"
        width={768}
        height={768}
        alt=""
        decoding="async"
        fetchPriority="high"
        draggable={false}
      />
      <div className="app-boot-wordmark" aria-hidden="true">
        <strong>MEDIA</strong>
        <span>GO</span>
      </div>
      <p className="app-boot-status">{t("startingMediaGo")}</p>
      <div className="app-boot-progress" aria-hidden="true">
        <span className="app-boot-progress-indicator" />
      </div>
    </div>
  );
}
