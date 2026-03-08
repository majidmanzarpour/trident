import { forwardRef, type ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const FloatingPanel = forwardRef<HTMLDivElement, ComponentProps<"div">>(
  function FloatingPanel({ className, ...props }, ref) {
    return (
      <div
        className={cn(
          "pointer-events-auto rounded-2xl bg-background/74 shadow-[0_18px_60px_rgba(4,12,10,0.42)] backdrop-blur-xl",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
