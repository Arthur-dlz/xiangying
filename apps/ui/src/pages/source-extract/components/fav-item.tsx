import { Link as LinkIcon, X } from "lucide-react";
import { type ReactElement } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

interface Props {
  onContextMenu?: () => void;
  onClick?: () => void;
  onClose?: () => void;
  src?: string;
  icon?: ReactElement;
  title?: string;
}

export function FavItem({
  onContextMenu,
  onClick,
  onClose,
  src,
  icon,
  title,
}: Props) {
  return (
    <div
      className="group relative flex min-h-28 w-28 cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-md transition-colors hover:bg-surface-hover"
      onContextMenu={onContextMenu}
      onClick={onClick}
    >
      {onClose ? (
        <div
          className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground group-hover:flex"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onClose();
          }}
        >
          <X className="size-4 stroke-[1.75]" />
        </div>
      ) : null}
      <div className="flex h-14 w-14 flex-row items-center justify-center rounded-md border bg-surface-subtle">
        <Avatar className="size-9 rounded-md bg-transparent text-foreground">
          <AvatarImage src={src} alt={title || ""} />
          <AvatarFallback className="rounded-md bg-transparent text-foreground">
            {icon ?? <LinkIcon className="size-5" />}
          </AvatarFallback>
        </Avatar>
      </div>
      <div
        className="w-full truncate text-center text-sm text-muted-foreground"
        title={title}
      >
        {title}
      </div>
    </div>
  );
}
