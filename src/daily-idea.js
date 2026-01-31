import OpenAI from "openai";
import { Resend } from "resend";
import fs from "fs";
import path from "path";

const HISTORY_ISSUE_TITLE = "daily-content-idea-history";
const MAX_HISTORY_ITEMS = 50;
const RECENT_FOR_PROMPT = 10;
const PREVIEW_CHARS = 1200;
const FULL_SCRIPT_TRUNCATE = 3000;

// ——— Run ID por execução: correlacionar logs e artifacts
const runId =
  String(Date.now()) + "-" + Math.random().toString(36).slice(2, 10);

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// ——— Structured logging: uma linha JSON por evento; nunca logar secrets
function logStructured(level, event, data = {}) {
  const payload = { level, event, runId, ...data };
  console.log(JSON.stringify(payload));
}
function logInfo(event, data) {
  logStructured("info", event, data);
}
function logWarn(event, data) {
  logStructured("warn", event, data);
}
function logError(event, data) {
  logStructured("error", event, data);
}

// ——— Debug dir para artifacts (Actions upload)
function ensureDebugDir() {
  const dir = path.join(process.cwd(), "debug");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ——— Escreve metadados da execução (sem secrets) e preview do raw
function writeDebugBundle(opts) {
  const dir = ensureDebugDir();
  const {
    totalMs,
    llmMs,
    resendMs,
    model,
    rawPreview,
    payload,
    success,
    errorMessage
  } = opts;

  const lastRun = {
    runId,
    timestamp: new Date().toISOString(),
    totalMs,
    llmMs,
    resendMs,
    model,
    success,
    envVarsPresent: [
      "GROQ_API_KEY",
      "RESEND_API_KEY",
      "EMAIL_TO",
      "EMAIL_FROM",
      "GITHUB_TOKEN",
      "GITHUB_REPOSITORY"
    ].filter((k) => !!process.env[k])
  };
  fs.writeFileSync(
    path.join(dir, "last-run.json"),
    JSON.stringify(lastRun, null, 2)
  );

  if (rawPreview != null) {
    fs.writeFileSync(
      path.join(dir, "last-response-preview.txt"),
      rawPreview.slice(0, PREVIEW_CHARS)
    );
  }

  if (success && payload) {
    const safePayload = { ...payload };
    if (safePayload.full_script && safePayload.full_script.length > FULL_SCRIPT_TRUNCATE) {
      safePayload.full_script =
        safePayload.full_script.slice(0, FULL_SCRIPT_TRUNCATE) + "\n\n[... truncado]";
    }
    fs.writeFileSync(
      path.join(dir, "last-payload.json"),
      JSON.stringify(safePayload, null, 2)
    );
  }

  const summaryLines = [
    success ? "## ✅ Daily Content Idea — Sucesso" : "## ❌ Daily Content Idea — Falha",
    "",
    `- **Run ID:** \`${runId}\``,
    `- **Total:** ${totalMs} ms`,
    `- **LLM:** ${llmMs} ms`,
    `- **Resend:** ${resendMs} ms`,
    `- **Modelo:** ${model || "—"}`
  ];
  if (success && payload) {
    summaryLines.push("", `- **Título:** ${payload.chosen_title || "—"}`);
    summaryLines.push(`- **Tipo:** ${payload.video_type || "—"}`);
  }
  if (!success && errorMessage) {
    summaryLines.push("", "### Erro", "```", errorMessage, "```");
  }
  fs.writeFileSync(path.join(dir, "summary.md"), summaryLines.join("\n"));
}

function weekdayKey(date = new Date()) {
  const d = date.getUTCDay();
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d];
}

function chooseVideoType(dayKey) {
  const fixed = { tue: "tech", thu: "work", sat: "life" };
  if (fixed[dayKey]) return fixed[dayKey];
  const weighted = [
    ["work", 0.45],
    ["tech", 0.35],
    ["life", 0.2]
  ];
  const r = Math.random();
  let acc = 0;
  for (const [k, w] of weighted) {
    acc += w;
    if (r <= acc) return k;
  }
  return "work";
}

// ——— Histórico: issue fixa como "DB"; body = JSON com até 50 itens
async function loadHistory() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    logInfo("history_skip", { reason: "GITHUB_TOKEN or GITHUB_REPOSITORY missing" });
    return { items: [] };
  }
  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) {
    logWarn("history_skip", { reason: "invalid GITHUB_REPOSITORY" });
    return { items: [] };
  }

  const baseUrl = `https://api.github.com/repos/${owner}/${repoName}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28"
  };

  const listRes = await fetch(`${baseUrl}/issues?state=all&per_page=100`, {
    headers
  });
  if (!listRes.ok) {
    logWarn("history_load_failed", { status: listRes.status });
    return { items: [] };
  }
  const issues = await listRes.json();
  const historyIssue = issues.find(
    (i) => i.title === HISTORY_ISSUE_TITLE && !i.pull_request
  );

  if (!historyIssue) {
    const body = JSON.stringify({ version: 1, items: [] });
    const createRes = await fetch(`${baseUrl}/issues`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ title: HISTORY_ISSUE_TITLE, body })
    });
    if (!createRes.ok) {
      logWarn("history_create_failed", { status: createRes.status });
      return { items: [] };
    }
    const created = await createRes.json();
    logInfo("history_created", { issueNumber: created.number });
    return { items: [], issueNumber: created.number };
  }

  const rawBody = historyIssue.body || "{}";
  let data;
  try {
    data = JSON.parse(rawBody);
  } catch (e) {
    logWarn("history_invalid_json", { action: "reinit" });
    return { items: [], issueNumber: historyIssue.number };
  }
  if (!Array.isArray(data.items)) {
    logWarn("history_invalid_structure", { action: "reinit" });
    return { items: [], issueNumber: historyIssue.number };
  }
  return { items: data.items, issueNumber: historyIssue.number };
}

async function saveHistory(newItem, existing) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return;
  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) return;

  const items = [
    {
      ts: new Date().toISOString(),
      video_type: newItem.video_type,
      chosen_title: newItem.chosen_title,
      tags: newItem.tags || [],
      hook: newItem.hook_0_10s,
      why_today: newItem.why_today
    },
    ...(existing.items || [])
  ].slice(0, MAX_HISTORY_ITEMS);

  const body = JSON.stringify({ version: 1, items });
  const baseUrl = `https://api.github.com/repos/${owner}/${repoName}`;
  const issueNumber = existing.issueNumber;
  if (issueNumber == null) {
    await fetch(`${baseUrl}/issues`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ title: HISTORY_ISSUE_TITLE, body })
    });
    return;
  }
  await fetch(`${baseUrl}/issues/${issueNumber}`, {
    method: "PATCH",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ body })
  });
}

function buildPrompt(videoType, recentTitlesAndTags) {
  const recentBlock =
    recentTitlesAndTags.length > 0
      ? `
ÚLTIMOS TÍTULOS/TAGS (não repita temas semelhantes):
${recentTitlesAndTags.map((x) => `- "${x.title}" | ${(x.tags || []).join(", ")}`).join("\n")}

REGRAS: Não repita temas/títulos semelhantes aos últimos 10.
`
      : "";

  return `
Você é um estrategista de conteúdo para YouTube focado em carreira dev internacional (BR -> exterior) e frontend.

Gere UM pacote completo de vídeo do tipo: "${videoType}".
${recentBlock}

REGRAS IMPORTANTES:
- Responda APENAS com JSON válido, sem markdown.
- Português do Brasil.
- Duração alvo: 6 a 10 minutos.

FORMATO EXATO:
{
  "video_type": "",
  "audience": "",
  "goal": "",
  "title_options": ["", "", ""],
  "chosen_title": "",
  "thumbnail": {
    "concepts": [
      {"visual":"", "text":"", "emotion":""},
      {"visual":"", "text":"", "emotion":""},
      {"visual":"", "text":"", "emotion":""}
    ],
    "chosen": {"visual":"", "text":"", "emotion":""}
  },
  "hook_0_10s": "",
  "outline": [
    {"t":"0:00-0:45", "topic":""},
    {"t":"0:45-2:00", "topic":""},
    {"t":"2:00-4:00", "topic":""},
    {"t":"4:00-7:00", "topic":""},
    {"t":"7:00-9:00", "topic":""}
  ],
  "full_script": "",
  "description": "",
  "tags": ["", "", ""],
  "cta": "",
  "why_today": ""
}

Agora gere SOMENTE o JSON.
  `.trim();
}

// ——— Extrai JSON do raw: parse direto, ou primeiro { / último }; evita falha por markdown/whitespace
function extractJson(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch (_) {}
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch (_) {}
  }
  return null;
}

// ——— Email readability-first: índice com âncoras, blocos, <details> para roteiro/description, TL;DR
function toEmailHtml(payload) {
  const esc = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");

  const title = esc(payload.chosen_title);
  const outline = payload.outline || [];
  const bullets = outline.slice(0, 3).map((o) => esc(o.topic));

  const block = (titleText, id, content) =>
    `<div style="margin:16px 0; padding:14px; background:#f8f9fa; border-radius:8px; border-left:4px solid #0d6efd;">
      <h3 id="${id}" style="margin:0 0 8px 0; font-size:1.1em;">${titleText}</h3>
      ${content}
    </div>`;

  const tldr = `
    <div style="margin:20px 0; padding:16px; background:#e7f1ff; border-radius:8px;">
      <h3 style="margin:0 0 10px 0; font-size:1.15em;">📋 TL;DR</h3>
      <p style="margin:4px 0;"><b>Tipo:</b> ${esc(payload.video_type)} &nbsp;|&nbsp; <b>Objetivo:</b> ${esc(payload.goal)}</p>
      <p style="margin:4px 0;"><b>Duração:</b> 6–10 min</p>
      <p style="margin:8px 0 0 0;"><b>Falar em 3 pontos:</b></p>
      <ul style="margin:4px 0; padding-left:20px;">${bullets.map((b) => `<li>${b}</li>`).join("")}</ul>
    </div>`;

  const nav = `
    <nav style="margin:16px 0; padding:12px; background:#f1f3f5; border-radius:8px; font-size:0.95em;">
      <strong>Índice:</strong>
      <a href="#hook" style="margin:0 8px; color:#0d6efd;">Hook</a>
      <a href="#estrutura" style="margin:0 8px; color:#0d6efd;">Estrutura</a>
      <a href="#thumbnail" style="margin:0 8px; color:#0d6efd;">Thumbnail</a>
      <a href="#roteiro" style="margin:0 8px; color:#0d6efd;">Roteiro</a>
      <a href="#description" style="margin:0 8px; color:#0d6efd;">Description</a>
      <a href="#tags" style="margin:0 8px; color:#0d6efd;">Tags / CTA</a>
    </nav>`;

  const headline = `
    <h1 style="font-size:1.5em; margin:0 0 12px 0; line-height:1.3;">🎬 ${title}</h1>
    <p style="margin:0; color:#495057;"><b>Por quê hoje:</b> ${esc(payload.why_today)}</p>`;

  const hookBlock = block(
    "⚡ Hook",
    "hook",
    `<p style="margin:0; white-space:pre-wrap;">${esc(payload.hook_0_10s)}</p>`
  );

  const outlineBlock = block(
    "🧱 Estrutura",
    "estrutura",
    `<ul style="margin:0; padding-left:20px;">${outline
      .map((it) => `<li><b>${esc(it.t)}</b> — ${esc(it.topic)}</li>`)
      .join("")}</ul>`
  );

  const thumb = payload.thumbnail?.chosen;
  const thumbnailBlock = block(
    "🖼️ Thumbnail",
    "thumbnail",
    `<p style="margin:0;"><b>Visual:</b> ${esc(thumb?.visual)}<br/><b>Texto:</b> ${esc(thumb?.text)}<br/><b>Emoção:</b> ${esc(thumb?.emotion)}</p>`
  );

  const roteiroBlock = block(
    "📝 Roteiro",
    "roteiro",
    `<details style="margin:0;"><summary style="cursor:pointer;">Ver roteiro completo</summary><pre style="white-space:pre-wrap; background:#fff; padding:12px; border-radius:6px; margin:8px 0 0 0; font-size:0.9em;">${esc(
      payload.full_script
    )}</pre></details>`
  );

  const descBlock = block(
    "📄 Description",
    "description",
    `<details style="margin:0;"><summary style="cursor:pointer;">Ver description</summary><pre style="white-space:pre-wrap; background:#fff; padding:12px; border-radius:6px; margin:8px 0 0 0; font-size:0.9em;">${esc(
      payload.description
    )}</pre></details>`
  );

  const tagsBlock = block(
    "🏷️ Tags e CTA",
    "tags",
    `<p style="margin:0;"><b>Tags:</b> ${esc((payload.tags || []).join(", "))}</p><p style="margin:8px 0 0 0;"><b>CTA:</b> ${esc(payload.cta)}</p>`
  );

  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.5; max-width: 640px; margin: 0 auto;">
    ${headline}
    ${tldr}
    ${nav}
    ${hookBlock}
    ${outlineBlock}
    ${thumbnailBlock}
    ${roteiroBlock}
    ${descBlock}
    ${tagsBlock}
  </div>
  `.trim();
}

async function main() {
  global.__dailyStart = Date.now();
  const tStart = Date.now();
  ensureDebugDir();

  const GROQ_API_KEY = requireEnv("GROQ_API_KEY");
  const RESEND_API_KEY = requireEnv("RESEND_API_KEY");
  const EMAIL_TO = requireEnv("EMAIL_TO");
  const EMAIL_FROM = requireEnv("EMAIL_FROM");
  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

  logInfo("start", {
    model,
    envVars: ["GROQ_API_KEY", "RESEND_API_KEY", "EMAIL_TO", "EMAIL_FROM"].filter(
      (k) => !!process.env[k]
    )
  });

  const dayKey = weekdayKey();
  const videoType = chooseVideoType(dayKey);

  const history = await loadHistory();
  const recent = (history.items || []).slice(0, RECENT_FOR_PROMPT).map((i) => ({
    title: i.chosen_title,
    tags: i.tags
  }));
  const prompt = buildPrompt(videoType, recent);

  const client = new OpenAI({
    apiKey: GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1"
  });

  let raw;
  let llmMs = 0;

  async function callLlm(temperature, extraUserMessage) {
    const t0 = Date.now();
    const messages = [
      { role: "system", content: "Responda somente com JSON válido." },
      { role: "user", content: prompt }
    ];
    if (extraUserMessage)
      messages.push({ role: "user", content: extraUserMessage });
    const completion = await client.chat.completions.create({
      model,
      temperature,
      messages
    });
    llmMs += Date.now() - t0;
    return completion.choices?.[0]?.message?.content?.trim() ?? "";
  }

  raw = await callLlm(0.9);
  if (!raw) throw new Error("Model returned empty content");

  let payload = extractJson(raw);
  if (!payload) {
    logWarn("json_extract_failed", { action: "retry_llm" });
    raw = await callLlm(
      0.2,
      "Retorne apenas um único objeto JSON válido, sem markdown e sem texto antes ou depois."
    );
    payload = extractJson(raw);
  }
  if (!payload) {
    throw new Error("Invalid JSON after retry. Preview:\n" + raw.slice(0, 800));
  }

  const resend = new Resend(RESEND_API_KEY);
  const tResend0 = Date.now();
  const subject = `📬 Ideia de vídeo (${payload.video_type}) — ${payload.chosen_title}`;
  await resend.emails.send({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject,
    html: toEmailHtml(payload)
  });
  const resendMs = Date.now() - tResend0;

  await saveHistory(payload, history);

  const totalMs = Date.now() - tStart;
  logInfo("done", { totalMs, llmMs, resendMs });

  writeDebugBundle({
    totalMs,
    llmMs,
    resendMs,
    model,
    rawPreview: raw,
    payload,
    success: true
  });

  console.log("Email enviado com sucesso!");
}

main().catch((err) => {
  const totalMs = Date.now() - (global.__dailyStart ?? Date.now());
  const msg = err?.message || String(err);
  logError("fatal", { message: msg });
  ensureDebugDir();
  writeDebugBundle({
    totalMs,
    llmMs: 0,
    resendMs: 0,
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    rawPreview: null,
    payload: null,
    success: false,
    errorMessage: msg
  });
  console.error(err);
  process.exit(1);
});
