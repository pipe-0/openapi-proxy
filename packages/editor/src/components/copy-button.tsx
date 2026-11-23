import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "../ui/button";

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The Clipboard API was refused (insecure context, no permission): copy via a selection.
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  }
}

/** Copies on press. The icon becomes a check for a moment, and a toast says what was copied. */
export function CopyButton({
  value,
  label,
  what = "Copied",
  onClick,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "children" | "value"> & {
  value: string;
  /** Button text. Omit for an icon-only button. */
  label?: string;
  /** Toast text, e.g. "URL copied". */
  what?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <Button
      variant="outline"
      size={label ? "default" : "icon"}
      aria-label={label ? undefined : "Copy"}
      {...props}
      onClick={async (event) => {
        // A tooltip or menu wrapping this button gets its click too.
        onClick?.(event);
        if (!(await copyText(value))) {
          toast.error("Could not copy. Select the text and copy it by hand.");
          return;
        }
        toast.success(what);
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {label}
    </Button>
  );
}
