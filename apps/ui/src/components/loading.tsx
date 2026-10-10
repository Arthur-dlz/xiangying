import type { FC } from "react";
import { Spinner } from "@/components/ui/spinner";

const Loading: FC = () => {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <Spinner />
    </div>
  );
};

export default Loading;
