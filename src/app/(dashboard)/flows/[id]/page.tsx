"use client";

import { apiFetch } from "@/lib/api-fetch";

import { Suspense, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";

import { ErrorState, ForbiddenState } from "@/components/ddm/states";
import { usePermissions } from "@/hooks/use-permission";
import { FlowEditorShell } from "@/components/flows/flow-editor-shell";
import { useFlowDebug } from "@/hooks/use-flow-debug";
import type { FlowRow, FlowNodeRow } from "@/lib/flows/types";

/**
 * Flow editor shell.
 *
 * Loads `{flow, nodes}` from `/api/flows/[id]` and hands it to
 * `<FlowBuilder>`. Owns the loading/error state so the builder can
 * focus purely on editing.
 *
 * Open to every authenticated user — the beta gate that previously
 * 404'd non-beta accounts was removed in PR #134. The API still
 * 404s on a flow id the caller doesn't own (RLS), which becomes the
 * "Flow not found" state below.
 */
export default function FlowEditorPage() {
  // O servidor exige flows.edit até para ler o fluxo (guardFlow em
  // /api/flows/[id]): sem a permissão não há editor nem modo leitura.
  const { loading, can } = usePermissions();
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!can("flows.edit")) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <ForbiddenState
          title="Você não tem acesso ao editor de fluxos"
          hint="Se precisar dele, peça a um administrador da organização."
        />
      </div>
    );
  }
  return <FlowEditorLoader />;
}

function FlowEditorLoader() {
  const router = useRouter();
  const params = useParams<{ id: string }>();

  const [flow, setFlow] = useState<FlowRow | null>(null);
  const [nodes, setNodes] = useState<FlowNodeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (!params.id) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/flows/${params.id}`);
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        if (!res.ok) throw new Error(`Failed: ${res.status}`);
        const json = (await res.json()) as {
          flow: FlowRow;
          nodes: FlowNodeRow[];
        };
        if (!cancelled) {
          setFlow(json.flow);
          setNodes(json.nodes ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          console.error(err);
          setLoadError("Não foi possível carregar o fluxo.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.id, reloadNonce]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <ErrorState
          title="Não foi possível carregar o fluxo"
          hint={loadError}
          onRetry={() => {
            setLoadError(null);
            setLoading(true);
            setReloadNonce((n) => n + 1);
          }}
        />
      </div>
    );
  }
  if (notFound || !flow) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">Fluxo não encontrado.</p>
        <button
          type="button"
          onClick={() => router.push("/flows")}
          className="text-sm text-primary hover:opacity-80"
        >
          ← Voltar para fluxos
        </button>
      </div>
    );
  }

  return (
    <Suspense fallback={null}>
      <FlowEditorWithDebug flowId={params.id} flow={flow} nodes={nodes} />
    </Suspense>
  );
}

/**
 * Split out from FlowEditorPage so `useFlowDebug` — which calls
 * `useSearchParams()` to read `?run_id=` — has its own Suspense
 * boundary. Next.js requires that for any Client Component reading
 * search params: without it, `next build` fails with "useSearchParams()
 * should be wrapped in a suspense boundary". `fallback={null}` is fine
 * here — this only ever suspends for a frame during the initial
 * client-side render, there's no meaningful loading state to show.
 */
function FlowEditorWithDebug({
  flowId,
  flow,
  nodes,
}: {
  flowId: string;
  flow: FlowRow;
  nodes: FlowNodeRow[];
}) {
  const debug = useFlowDebug(flowId);
  // `?node=` vem do atalho do card "Fluxo" no inbox (junto com `run_id`).
  const focusNodeKey = useSearchParams().get("node");
  return (
    <FlowEditorShell
      initialFlow={flow}
      initialNodes={nodes}
      debug={debug}
      focusNodeKey={focusNodeKey}
    />
  );
}