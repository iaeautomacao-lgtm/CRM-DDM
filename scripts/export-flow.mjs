import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { serializeFlowExport } from "./lib/flow-export.mjs";

// Mesmo carregamento de scripts/check-schema-readiness.mjs, sem sobrescrever o ambiente.
for (const file of [".env.local", ".env.production.local", ".env.production", ".env"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] = value;
  }
}

async function main() {
  const [flowId, flag, out, ...extra] = process.argv.slice(2);
  if (!flowId || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(flowId)
    || (flag !== undefined && (flag !== "--out" || !out)) || extra.length > 0) {
    throw new Error("Uso: node scripts/export-flow.mjs <flow_id UUID> [--out supabase/flows/<slug>.json]");
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios.");
  }
  const db = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "wacrm" },
  });
  const { data: flow, error } = await db.from("flows")
    .select("id,name,description,status,trigger_type,trigger_config,entry_node_id,fallback_policy")
    .eq("id", flowId).maybeSingle();
  // Não imprimir respostas do banco: podem conter configurações sensíveis.
  if (error) throw new Error("Não foi possível ler o fluxo no Supabase.");
  if (!flow) throw new Error("Fluxo não encontrado.");

  const nodes = [];
  const pageSize = 500;
  for (let offset = 0; ; ) {
    const { data, error: nodesError } = await db.from("flow_nodes")
      .select("node_key,node_type,config,position_x,position_y")
      .eq("flow_id", flowId).order("node_key", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (nodesError) throw new Error("Não foi possível ler os nós do fluxo no Supabase.");
    const page = data ?? [];
    if (page.length === 0) break;
    nodes.push(...page);
    offset += page.length;
  }
  const json = serializeFlowExport(flow, nodes);
  if (out) {
    const destination = resolve(out);
    // O destino não pode sair da pasta do projeto, mesmo por junction/symlink.
    const root = await realpath(process.cwd());
    const assertInside = (path) => {
      const rel = relative(root, path);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error("O arquivo de saída deve ficar dentro da pasta do projeto.");
      }
    };
    assertInside(destination);
    let ancestor = dirname(destination);
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    assertInside(await realpath(ancestor));
    if (existsSync(destination)) assertInside(await realpath(destination));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, json, "utf8");
    console.error("[export-flow] JSON exportado com segredos mascarados.");
  } else {
    process.stdout.write(json);
  }
}

try {
  await main();
} catch (error) {
  // Erros inesperados também podem carregar URLs/tokens; só mensagens controladas.
  const message = error instanceof Error ? error.message : "";
  const safe = /^(Uso:|NEXT_PUBLIC_SUPABASE_URL|Não foi possível|Fluxo não encontrado\.|O arquivo de saída)/.test(message);
  console.error(`[export-flow] ${safe ? message : "Falha na exportação. Verifique a configuração e o destino."}`);
  process.exitCode = 1;
}
