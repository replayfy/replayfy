import { useToast } from "@/components/feedback";
import { Icon } from "@/components/primitives";

/* A hover-revealed copy affordance for a block of text (console expands,
   network payload/response). Wrap the block: the icon parks in its top-right
   corner and only appears on hover, so it never competes with the content. */
export function RvCopyBlock({
  value,
  children,
  label = "Copied to clipboard",
}: {
  value: string;
  children: React.ReactNode;
  label?: string;
}) {
  const toast = useToast();
  const copy = async (e: React.MouseEvent) => {
    // the block often sits inside a row that toggles on click
    e.stopPropagation();
    try {
      await navigator.clipboard?.writeText(value);
      toast?.(label, { kind: "ok" });
    } catch {
      toast?.("Couldn't copy to clipboard");
    }
  };
  return (
    <div className="rv-copywrap">
      {children}
      <button
        className="rv-copybtn"
        onClick={copy}
        aria-label="Copy"
        title="Copy"
      >
        <Icon name="copy" size={11} />
      </button>
    </div>
  );
}
