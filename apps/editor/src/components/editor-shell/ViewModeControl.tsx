import { LayoutGrid } from "lucide-react";
import { FloatingPanel } from "@/components/editor-shell/FloatingPanel";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { getViewModePreset, viewModePresets, type ViewModeId } from "@/viewport/viewports";

export function ViewModeControl({
  currentViewMode,
  onSetViewMode
}: {
  currentViewMode: ViewModeId;
  onSetViewMode: (viewMode: ViewModeId) => void;
}) {
  const currentPreset = getViewModePreset(currentViewMode);

  return (
    <FloatingPanel className="flex h-11 items-center gap-2 px-3 text-[11px] text-foreground/72">
      <LayoutGrid className="size-3.5 text-emerald-300" />
      <Popover>
        <PopoverTrigger
          render={
            <Button className="h-7 rounded-xl px-2.5 text-[11px] font-medium" size="sm" variant="ghost">
              {currentPreset.shortLabel}
            </Button>
          }
        />
        <PopoverContent align="start" className="w-64 rounded-2xl bg-popover/96 p-2 shadow-[0_18px_48px_rgba(4,12,10,0.46)] backdrop-blur-xl">
          <div className="space-y-1">
            <div className="px-2 pb-1 text-[10px] font-medium tracking-[0.18em] text-foreground/45 uppercase">View Mode</div>
            {viewModePresets.map((preset) => (
              <button
                className={cn(
                  "flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left text-[12px] text-foreground/62 transition-colors hover:bg-white/5 hover:text-foreground",
                  preset.id === currentViewMode && "bg-emerald-500/14 text-emerald-200"
                )}
                key={preset.id}
                onClick={() => onSetViewMode(preset.id)}
                type="button"
              >
                <span className="font-medium">{preset.shortLabel}</span>
                <span className="ml-3 text-[10px] text-foreground/35">{preset.label}</span>
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </FloatingPanel>
  );
}
