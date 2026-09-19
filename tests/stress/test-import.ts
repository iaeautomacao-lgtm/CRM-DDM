// Passo 2 — para cada CSV gerado (generate-csv.ts), faz POST
// /api/disparador/contacts/import com sessão real de usuário e mede
// tempo de resposta + taxa de sucesso. Precisa rodar DEPOIS de
// `npm run stress:generate`.
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import FormData from "form-data";
import {
  CSV_SIZES,
  DATA_DIR,
  IMPORT_REQUEST_TIMEOUT_MS,
  RESULTS_DIR,
  SESSION_TOKEN,
  STRESS_PREFIX,
  TARGET_URL,
} from "./config";

interface ImportResult {
  size: number;
  file: string;
  httpStatus: number | null;
  durationMs: number;
  importados: number;
  duplicados: number;
  invalidos: number;
  blacklisted: number;
  erros: string[];
  ok: boolean;
  errorMessage?: string;
}

async function importCsv(size: number, sessionCookie: string): Promise<ImportResult> {
  const filename = `csv_${String(size).padStart(6, "0")}.csv`;
  const filePath = path.join(DATA_DIR, filename);

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `${filename} não encontrado. Rode "npm run stress:generate" primeiro.`
    );
  }

  const form = new FormData();
  form.append("file", fs.createReadStream(filePath), filename);
  // Tag padrão marca todo contato importado como STRESS_TEST — é o que
  // cleanup.ts usa para localizar e apagar depois.
  form.append("defaultTag", STRESS_PREFIX);

  const start = Date.now();
  try {
    const response = await axios.post(
      `${TARGET_URL}/api/disparador/contacts/import`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          Cookie: sessionCookie,
        },
        timeout: IMPORT_REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );
    const durationMs = Date.now() - start;

    if (response.status !== 200 || !response.data?.success) {
      return {
        size,
        file: filename,
        httpStatus: response.status,
        durationMs,
        importados: 0,
        duplicados: 0,
        invalidos: 0,
        blacklisted: 0,
        erros: [],
        ok: false,
        errorMessage:
          response.data?.error || `HTTP ${response.status} sem success:true`,
      };
    }

    const { results } = response.data as {
      results: {
        importados: number;
        duplicados: number;
        invalidos: number;
        blacklisted: number;
        erros: string[];
      };
    };

    return {
      size,
      file: filename,
      httpStatus: response.status,
      durationMs,
      importados: results.importados,
      duplicados: results.duplicados,
      invalidos: results.invalidos,
      blacklisted: results.blacklisted,
      erros: results.erros,
      // Sucesso = toda linha do CSV foi contabilizada em alguma categoria,
      // não necessariamente "importada". Um rerun dos CSVs gerados numa
      // rodada anterior deve legitimamente cair em duplicados, não em
      // importados — exigir importados === size fazia esse caso (dedup
      // funcionando corretamente) ser reportado como falha.
      ok: results.importados + results.duplicados + results.invalidos + results.blacklisted === size,
    };
  } catch (err: any) {
    const durationMs = Date.now() - start;
    return {
      size,
      file: filename,
      httpStatus: err.response?.status ?? null,
      durationMs,
      importados: 0,
      duplicados: 0,
      invalidos: 0,
      blacklisted: 0,
      erros: [],
      ok: false,
      errorMessage: err.code === "ECONNABORTED" ? "timeout" : err.message,
    };
  }
}

async function main() {
  const sessionCookie = SESSION_TOKEN();
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  console.log(`[test-import] Alvo: ${TARGET_URL}`);
  console.log(`[test-import] Tamanhos: ${CSV_SIZES.join(", ")}`);

  const results: ImportResult[] = [];

  for (const size of CSV_SIZES) {
    process.stdout.write(`[test-import] Importando ${size} linhas... `);
    const result = await importCsv(size, sessionCookie);
    results.push(result);

    if (result.ok) {
      console.log(
        `OK — ${result.durationMs}ms, importados=${result.importados}, ` +
          `duplicados=${result.duplicados}, invalidos=${result.invalidos}`
      );
    } else {
      console.log(
        `FALHOU — status=${result.httpStatus}, ${result.durationMs}ms, ` +
          `erro=${result.errorMessage ?? "importados != esperado"} ` +
          `(importados=${result.importados}/${size})`
      );
    }

    // Falha TOTAL (0 importados, erro de transporte/servidor) — não
    // adianta tentar tamanhos maiores se o menor já não passou.
    const failedCompletely = result.httpStatus === null || result.httpStatus >= 500;
    if (failedCompletely) {
      console.log(
        `[test-import] Parando: tamanho ${size} falhou completamente (status=${result.httpStatus}).`
      );
      break;
    }
  }

  const outPath = path.join(RESULTS_DIR, "import-results.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");
  console.log(`[test-import] Resultados salvos em ${outPath}`);
}

main().catch((err) => {
  console.error("[test-import] Erro fatal:", err.message);
  process.exit(1);
});
