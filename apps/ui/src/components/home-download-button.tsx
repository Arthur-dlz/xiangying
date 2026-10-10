import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

interface Props {
  onClick?: () => void;
}

export function HomeDownloadButton({ onClick }: Props) {
  const { t } = useTranslation();

  return (
    <Button type="button" onClick={onClick}>
      <Download />
      {t("newDownload")}
    </Button>
  );
}
