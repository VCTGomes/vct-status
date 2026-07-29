#!/usr/bin/env node
// Deriva o status de cada dia, por monitor, a partir do historico do git.
//
// Por que o git e nao o history/summary.json: o campo dailyMinutesDown do
// summary so contabiliza "down", entao um dia inteiro degradado apareceria
// como no ar. O log do git tem os tres estados.
//
// Importante: o Upptime NAO faz um commit por check. Ele grava o
// history/<slug>.yml quando o status muda, mais um heartbeat diario. Ou seja,
// cada commit e uma OBSERVACAO, e o estado entre duas observacoes e
// interpolado a partir da primeira (a mesma convencao do proprio Upptime:
// a indisponibilidade comeca no instante em que foi detectada).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const OUT_PATH = join(REPO_ROOT, "daily", "uptime.json");

const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 90);
// Acima deste intervalo sem observacao o periodo vira "sem dado" em vez de ser
// preenchido com o ultimo status conhecido. 25h cobre o heartbeat diario com
// folga; se o monitoramento parar de verdade, a fita mostra o buraco.
const MAX_GAP_MINUTES = Number(process.env.MAX_GAP_MINUTES || 1500);
// Abaixo desta disponibilidade o dia conta como fora do ar (vermelho); acima,
// com qualquer incidente, conta como degradado (amarelo).
const DOWN_THRESHOLD_PCT = Number(process.env.DOWN_THRESHOLD_PCT || 99);

const MINUTES_PER_DAY = 1440;
const MS_PER_MINUTE = 60_000;

const git = (args) =>
  execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/**
 * Extrai o status da mensagem de commit. O Upptime usa emoji + "is <status>",
 * mas commits antigos deste repo trazem "está <status>" (sobra de um
 * commitMessages personalizado que foi removido), entao aceitamos os dois.
 */
const parseStatus = (subject) => {
  if (subject.includes("🟩")) return "up";
  if (subject.includes("🟨")) return "degraded";
  if (subject.includes("🟥")) return "down";
  const m = subject.match(/\b(?:is|está|esta) (up|down|degraded)\b/);
  return m ? m[1] : null;
};

/** Observacoes de um monitor, mais antiga primeiro. */
const observations = (slug) => {
  const out = git(["log", "--reverse", "--format=%ct%x09%s", "--", `history/${slug}.yml`]);
  const result = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    const status = parseStatus(line.slice(tab + 1));
    if (!status) continue;
    result.push({ at: Number(line.slice(0, tab)) * 1000, status });
  }
  return result;
};

/**
 * Converte observacoes em intervalos [from, to) com status constante.
 * Um intervalo maior que MAX_GAP_MINUTES e truncado, e o resto fica descoberto.
 */
const intervals = (obs, now) => {
  const cap = MAX_GAP_MINUTES * MS_PER_MINUTE;
  return obs.map(({ at, status }, i) => {
    const next = i + 1 < obs.length ? obs[i + 1].at : now;
    return { from: at, to: Math.min(next, at + cap), status };
  });
};

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const startOfDay = (ms) => Date.parse(`${dayKey(ms)}T00:00:00.000Z`);

const classify = ({ up, degraded, down }) => {
  const covered = up + degraded + down;
  if (covered <= 0) return { status: "nodata", uptime: null };
  const uptime = ((up + degraded) / covered) * 100;
  if (down > 0 && uptime < DOWN_THRESHOLD_PCT) return { status: "down", uptime };
  if (down > 0 || degraded > 0) return { status: "degraded", uptime };
  return { status: "up", uptime };
};

const buildDays = (obs, now) => {
  const today = startOfDay(now);
  const buckets = new Map();
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const day = today - i * MINUTES_PER_DAY * MS_PER_MINUTE;
    buckets.set(dayKey(day), { up: 0, degraded: 0, down: 0 });
  }

  const windowStart = today - (WINDOW_DAYS - 1) * MINUTES_PER_DAY * MS_PER_MINUTE;
  for (const { from, to, status } of intervals(obs, now)) {
    // Recorta o intervalo na janela e distribui entre os dias que ele cruza.
    let cursor = Math.max(from, windowStart);
    const end = Math.min(to, now);
    while (cursor < end) {
      const key = dayKey(cursor);
      const dayEnd = startOfDay(cursor) + MINUTES_PER_DAY * MS_PER_MINUTE;
      const slice = Math.min(end, dayEnd);
      const bucket = buckets.get(key);
      if (bucket) bucket[status] += (slice - cursor) / MS_PER_MINUTE;
      cursor = slice;
    }
  }

  return [...buckets].map(([date, minutes]) => {
    const rounded = {
      up: Math.round(minutes.up),
      degraded: Math.round(minutes.degraded),
      down: Math.round(minutes.down),
    };
    const { status, uptime } = classify(rounded);
    return {
      date,
      status,
      uptime: uptime === null ? null : Math.round(uptime * 100) / 100,
      minutes: rounded,
    };
  });
};

const now = Date.now();
const summary = JSON.parse(readFileSync(join(REPO_ROOT, "history", "summary.json"), "utf8"));

const monitors = summary.map(({ name, slug, icon }) => ({
  slug,
  name,
  icon,
  days: buildDays(observations(slug), now),
}));

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(
  OUT_PATH,
  // compacto de proposito: a pagina baixa este arquivo a cada visita, e o
  // conteudo e gerado por maquina (diff legivel nao ajuda em nada aqui)
  `${JSON.stringify({
    generatedAt: new Date(now).toISOString(),
    windowDays: WINDOW_DAYS,
    maxGapMinutes: MAX_GAP_MINUTES,
    downThresholdPct: DOWN_THRESHOLD_PCT,
    monitors,
  })}\n`
);

for (const m of monitors) {
  const counts = m.days.reduce((acc, d) => ({ ...acc, [d.status]: (acc[d.status] || 0) + 1 }), {});
  console.log(
    `${m.slug}: ${Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}`
  );
}
