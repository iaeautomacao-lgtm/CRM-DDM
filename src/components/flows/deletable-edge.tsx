'use client';

/**
 * Custom edge renderer — draws the same bezier path React-Flow's
 * default edge type would, plus a small delete button at the
 * midpoint so users don't have to select an edge and hit
 * Backspace/Delete to remove a connection. Registered as the
 * `default` edge type in flow-canvas.tsx, so every derived edge
 * (deriveCanvasEdges) picks it up automatically.
 */

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useReactFlow,
  type EdgeProps,
} from '@xyflow/react';
import { Trash2 } from 'lucide-react';

export function DeletableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  label,
  selected,
}: EdgeProps) {
  const { deleteElements } = useReactFlow();
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
          className="nodrag nopan flex items-center gap-1"
        >
          {label ? (
            <span className="border-border bg-card text-muted-foreground rounded border px-1.5 py-0.5 text-[11px]">
              {label}
            </span>
          ) : null}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              deleteElements({ edges: [{ id }] });
            }}
            title="Excluir conexão"
            aria-label="Excluir conexão"
            className={`border-border bg-card text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full border shadow-sm transition-[opacity,color,border-color] hover:border-danger hover:text-danger hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring ${selected ? 'opacity-100' : 'opacity-40'}`}
          >
            <Trash2 className="size-3" aria-hidden="true" />
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
