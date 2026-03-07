import { useMemo, useState } from "react";
import type { GeometryNode } from "@web-hammer/shared";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

type SceneHierarchyPanelProps = {
  nodes: GeometryNode[];
  onFocusNode: (nodeId: string) => void;
  onSelectNodes: (nodeIds: string[]) => void;
  selectedNodeId?: string;
};

export function SceneHierarchyPanel({
  nodes,
  onFocusNode,
  onSelectNodes,
  selectedNodeId
}: SceneHierarchyPanelProps) {
  const [query, setQuery] = useState("");
  const filteredNodes = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    if (!normalizedQuery) {
      return nodes;
    }

    return nodes.filter((node) => node.name.toLowerCase().includes(normalizedQuery));
  }, [nodes, query]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="space-y-2 px-1 pt-1">
        <div className="text-[10px] font-medium tracking-[0.18em] text-foreground/42 uppercase">Scene</div>
        <Input
          className="h-9 rounded-xl border-white/8 bg-white/5 text-xs"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search nodes"
          value={query}
        />
      </div>

      <ScrollArea className="min-h-0 flex-1 pr-1">
        <div className="space-y-0.5 px-1 pb-1">
          {filteredNodes.length > 0 ? (
            filteredNodes.map((node) => (
              <button
                className={cn(
                  "block w-full rounded-xl px-2.5 py-2 text-left text-[12px] font-medium text-foreground/62 transition-colors hover:bg-white/5 hover:text-foreground",
                  selectedNodeId === node.id && "bg-emerald-500/14 text-emerald-200"
                )}
                key={node.id}
                onClick={() => onSelectNodes([node.id])}
                onDoubleClick={() => onFocusNode(node.id)}
                type="button"
              >
                <span className="block truncate">{node.name}</span>
                <span className="block text-[10px] text-foreground/35">{node.kind}</span>
              </button>
            ))
          ) : (
            <div className="px-2.5 py-3 text-xs text-foreground/45">No nodes match the current search.</div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
