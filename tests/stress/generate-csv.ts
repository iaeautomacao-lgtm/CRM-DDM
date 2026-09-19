// Passo 1 — gera CSVs fictícios no formato do Disparador
// (CONTATO;VAR1;VAR2;VAR3, mesmo formato de export da Meta reconhecido por
// TELEFONE1_KEYS/NAME_FIELD_KEYS em contacts/import/route.ts).
//
// Números de telefone são gerados dentro de faixas de DDD/prefixo que não
// correspondem a numeração móvel real alocada (ver FAKE_DDD/FAKE_PREFIX
// abaixo) — o objetivo é ter 13 dígitos válidos no formato 55+DDD+9XXXXXXXX
// para não cair no branch "inválido" do importador, sem gerar um número
// que exista de fato.
import fs from "node:fs";
import path from "node:path";
import { CSV_SIZES, DATA_DIR, STRESS_PREFIX } from "./config";

const FIRST_NAMES = [
  "Ana", "Bruno", "Carla", "Diego", "Elaine", "Fabio", "Gabriela", "Hugo",
  "Igor", "Julia", "Kaique", "Larissa", "Marcos", "Natalia", "Otavio",
  "Patricia", "Rafael", "Sabrina", "Thiago", "Vanessa",
];
const LAST_NAMES = [
  "Silva", "Souza", "Oliveira", "Santos", "Pereira", "Costa", "Ferreira",
  "Rodrigues", "Almeida", "Nascimento",
];

// 55 (país) + DDD (2 dígitos) + 9 dígitos de assinante (padrão celular
// brasileiro, sempre começando em 9) = 13 dígitos, batendo no formato que
// formatBrazilianPhone/TELEFONE1_KEYS esperam. Não há como gerar um número
// de celular sintaticamente válido que seja *garantidamente* inexistente
// (o espaço de fakes é o mesmo espaço de números reais) — por isso o
// prefixo STRESS_TEST vai em VAR1/VAR2 e o DDD 99 (Roraima, baixa
// densidade populacional) é usado para reduzir a chance de coincidir com
// uma linha real ativa.
function fakePhone(index: number): string {
  const ddd = "99";
  const subscriber = "9" + String(index % 100000000).padStart(8, "0");
  return `55${ddd}${subscriber}`;
}

function fakeName(index: number): string {
  const first = FIRST_NAMES[index % FIRST_NAMES.length];
  const last = LAST_NAMES[Math.floor(index / FIRST_NAMES.length) % LAST_NAMES.length];
  return `${STRESS_PREFIX}_${first} ${last}`;
}

function csvEscape(value: string): string {
  // Formato usa ; como delimitador (default do importador para .csv) —
  // só precisa escapar se o valor contiver ; ou aspas.
  if (/[;"\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// `offset` desloca a faixa de índices usada por este arquivo — sem isso,
// fakePhone(i)/fakeName(i) geram os MESMOS números para i=0..99 em todo
// arquivo (100, 500, 1000...), e cada CSV maior vira um superset exato
// dos menores. Ao importar em sequência (100 -> 500 -> 1000 -> ...), as
// linhas repetidas batem no dedup por telefone e são contadas como
// "duplicados" em vez de "importados", distorcendo a taxa de sucesso
// medida por test-import.ts. Cada tamanho recebe seu próprio bloco de
// índices (stride bem maior que o maior CSV_SIZES) para que os 5 arquivos
// nunca se sobreponham.
function generateCsv(rows: number, offset: number): string {
  const lines = ["CONTATO;VAR1;VAR2;VAR3"];
  for (let j = 0; j < rows; j++) {
    const i = offset + j;
    const contato = fakePhone(i);
    const var1 = fakeName(i);
    const var2 = STRESS_PREFIX;
    const var3 = `https://example.invalid/${STRESS_PREFIX}/${i}`;
    lines.push(
      [contato, var1, var2, var3].map(csvEscape).join(";")
    );
  }
  return lines.join("\n") + "\n";
}

const INDEX_STRIDE = 20_000; // > max(CSV_SIZES), garante blocos sem overlap

function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  CSV_SIZES.forEach((size, bucketIndex) => {
    const filename = `csv_${String(size).padStart(6, "0")}.csv`;
    const filePath = path.join(DATA_DIR, filename);
    fs.writeFileSync(filePath, generateCsv(size, bucketIndex * INDEX_STRIDE), "utf-8");
    console.log(`[generate-csv] ${filename} — ${size} linhas`);
  });

  console.log(`[generate-csv] Concluído. Arquivos em ${DATA_DIR}`);
}

main();
