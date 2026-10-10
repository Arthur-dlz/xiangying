import { useCallback, useEffect, useRef } from "react";
import { cn } from "@/utils";
import { Textarea } from "@/components/ui/textarea";

export type BatchUrlTextareaProps = React.ComponentProps<typeof Textarea>;

export function BatchUrlTextarea({
  className,
  ref,
  ...props
}: BatchUrlTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const setTextareaRef = useCallback(
    (element: HTMLTextAreaElement | null) => {
      textareaRef.current = element;
      if (typeof ref === "function") ref(element);
      else if (ref) ref.current = element;
    },
    [ref],
  );

  useEffect(() => {
    const handleScroll = () => {
      if (textareaRef.current && highlightRef.current) {
        const textarea = textareaRef.current;
        highlightRef.current.scrollTop = textarea.scrollTop;
        highlightRef.current.scrollLeft = textarea.scrollLeft;
      }
    };

    const textarea = textareaRef.current;
    if (textarea) {
      textarea.addEventListener("scroll", handleScroll);
      return () => textarea.removeEventListener("scroll", handleScroll);
    }
  }, []);

  const renderHighlightedText = () => {
    const text = String(props.value || "");
    const parts = text.split(" ");

    return (
      <>
        {parts.map((part, index) => (
          <span key={index}>
            {part}
            {index < parts.length - 1 && (
              <span className="bg-yellow-500"> </span>
            )}
          </span>
        ))}
        {text.endsWith("\n") && <br />}
      </>
    );
  };

  return (
    <div className="relative inline-block w-full rounded-md bg-surface-raised">
      <div
        ref={highlightRef}
        className={cn(
          "pointer-events-none absolute inset-0 z-1 overflow-hidden wrap-break-word whitespace-pre border border-transparent px-3 py-2 text-base leading-6 text-transparent md:text-sm md:leading-5",
        )}
      >
        {renderHighlightedText()}
      </div>
      <Textarea
        ref={setTextareaRef}
        {...props}
        className={cn(
          "relative z-2 min-h-0 field-sizing-fixed bg-transparent! leading-6 md:leading-5",
          className,
        )}
      />
    </div>
  );
}
