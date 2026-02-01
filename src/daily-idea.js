import OpenAI from "openai";
import { Resend } from "resend";
import fs from "fs";
import path from "path";

const HISTORY_ISSUE_TITLE = "daily-content-idea-history";
const MAX_HISTORY_ITEMS = 50;
const RECENT_FOR_PROMPT = 10;
const PREVIEW_CHARS = 1200;
const FULL_SCRIPT_TRUNCATE = 3000;
const MS_14_DAYS = 14 * 24 * 60 * 60 * 1000;

// ——— Run ID per execution: correlate logs and artifacts
const runId =
  String(Date.now()) + "-" + Math.random().toString(36).slice(2, 10);
let lastTrendsPreview = null;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// ——— Structured logging: one JSON line per event; never log secrets
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

// ——— Debug dir for artifacts (Actions upload)
function ensureDebugDir() {
  const dir = path.join(process.cwd(), "debug");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ——— Writes run metadata (no secrets) and raw preview
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
    errorMessage,
    trendsPreview
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
        safePayload.full_script.slice(0, FULL_SCRIPT_TRUNCATE) + "\n\n[... truncated]";
    }
    fs.writeFileSync(
      path.join(dir, "last-payload.json"),
      JSON.stringify(safePayload, null, 2)
    );
  }

  const summaryLines = [
    success ? "## ✅ Daily Content Idea — Success" : "## ❌ Daily Content Idea — Failure",
    "",
    `- **Run ID:** \`${runId}\``,
    `- **Total:** ${totalMs} ms`,
    `- **LLM:** ${llmMs} ms`,
    `- **Resend:** ${resendMs} ms`,
    `- **Model:** ${model || "—"}`
  ];
  if (success && payload) {
    summaryLines.push("", `- **Title:** ${payload.chosen_title || "—"}`);
    summaryLines.push(`- **Type:** ${payload.video_type || "—"}`);
  }
  if (!success && errorMessage) {
    summaryLines.push("", "### Error", "```", errorMessage, "```");
  }
  fs.writeFileSync(path.join(dir, "summary.md"), summaryLines.join("\n"));

  if (trendsPreview != null) {
    fs.writeFileSync(
      path.join(dir, "trends-preview.json"),
      JSON.stringify(trendsPreview, null, 2)
    );
  }
}

// ——— Video types with context for better idea generation
const VIDEO_TYPES = {
  career_international:
    "Conteúdos sobre trabalhar no exterior, rotina com empresa americana, soft skills de alto impacto, mentalidade, crescimento e adaptação.",
  tech_frontend:
    "Conteúdos técnicos práticos sobre frontend moderno, ferramentas, frameworks, boas práticas, performance, UI/UX para dev FE.",
  life_productivity:
    "Conteúdos sobre vida de dev remoto, produtividade, hábitos, rotina e equilíbrio.",
  communication_english:
    "Conteúdos sobre inglês aplicado à carreira dev internacional, comunicação no dia a dia, práticas reais, dicas objetivas.",
  strategy_content:
    "Conteúdos meta sobre criação de conteúdo, carreira como criador dev, estratégia, thumbnail/title thinking, storytelling."
};

function getValidVideoTypes() {
  return Object.keys(VIDEO_TYPES);
}

// ——— Anti-repetition: exclude types used in last 14 days; fallback if all types excluded
const FALLBACK_VIDEO_TYPE = "career_international";

function getRestriction14(items) {
  const cutoff = Date.now() - MS_14_DAYS;
  const inWindow = (items || []).filter((i) => {
    if (!i?.ts) return false;
    const t = new Date(i.ts).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
  const titles = [...new Set(inWindow.map((i) => i.chosen_title).filter(Boolean))];
  const types = [...new Set(inWindow.map((i) => i.video_type).filter(Boolean))];
  const tags = [...new Set(inWindow.flatMap((i) => i.tags || []).filter(Boolean))];
  return { titles, types, tags };
}

function chooseVideoType(typesToExclude) {
  const valid = getValidVideoTypes();
  if (!valid || valid.length === 0) return FALLBACK_VIDEO_TYPE;
  const exclude = Array.isArray(typesToExclude) ? typesToExclude : [];
  const available = valid.filter((t) => !exclude.includes(t));
  const pool = available.length > 0 ? available : valid;
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx];
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

const REMOTE_WORK_START = new Date(2022, 11, 1); // Dec 2022
const TRENDS_FILE = "trends.json";

// ——— Load trends.json (optional); return null on missing/parse error
function loadTrends() {
  const filePath = path.join(process.cwd(), TRENDS_FILE);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : null;
  } catch (_) {
    return null;
  }
}

// ——— Build "Tendências Reais DEV" section: max 3 keywords, max 5 items per list
function buildTrendsSection(trends) {
  if (!trends || typeof trends !== "object") return { text: "", preview: null };
  const data = trends.data ?? {};
  const keywords = trends.keywords_used ?? Object.keys(data);
  const preview = {
    generated_at: trends.generated_at ?? null,
    keywords_count: keywords.length,
    terms_in_preview: []
  };
  const lines = [];
  lines.push("——— TENDÊNCIAS REAIS DEV ———");
  const terms = keywords.slice(0, 3);
  preview.terms_in_preview = terms;
  const maxItems = 5;
  for (const term of terms) {
    const entry = data[term];
    if (!entry || typeof entry !== "object") continue;
    const br = entry.BR ?? {};
    const us = entry.US ?? {};
    const parts = [];
    if ((br.rising ?? []).length) parts.push(`BR rising: ${(br.rising ?? []).slice(0, maxItems).join(", ")}`);
    if ((br.top ?? []).length) parts.push(`BR top: ${(br.top ?? []).slice(0, maxItems).join(", ")}`);
    if ((us.rising ?? []).length) parts.push(`US rising: ${(us.rising ?? []).slice(0, maxItems).join(", ")}`);
    if ((us.top ?? []).length) parts.push(`US top: ${(us.top ?? []).slice(0, maxItems).join(", ")}`);
    if ((br.topics_rising ?? []).length) parts.push(`BR topics↑: ${(br.topics_rising ?? []).slice(0, maxItems).join(", ")}`);
    if ((br.topics_top ?? []).length) parts.push(`BR topics: ${(br.topics_top ?? []).slice(0, maxItems).join(", ")}`);
    if ((us.topics_rising ?? []).length) parts.push(`US topics↑: ${(us.topics_rising ?? []).slice(0, maxItems).join(", ")}`);
    if ((us.topics_top ?? []).length) parts.push(`US topics: ${(us.topics_top ?? []).slice(0, maxItems).join(", ")}`);
    if (parts.length) lines.push(`"${term}": ${parts.join(" | ")}`);
    const sug = (entry.suggestions ?? []).slice(0, maxItems);
    if (sug.length) lines.push(`  suggestions: ${sug.join(", ")}`);
  }
  lines.push("Use esse contexto de tendências reais do nicho DEV (frontend, carreira internacional, inglês, produtividade, mercado exterior) para inspirar o tema atual. Mantenha relevância para dev BR buscando remoto/exterior.");
  const text = lines.length > 1 ? lines.join("\n") + "\n" : "";
  return { text, preview };
}

function buildPrompt(videoType, recentTitlesAndTags, restriction14, trendsBlockText) {
  const typeContext = VIDEO_TYPES[videoType] ?? videoType;
  const yearsRemote = Math.floor(
    (Date.now() - REMOTE_WORK_START.getTime()) / (365.25 * 24 * 60 * 60 * 1000)
  );
  const yearsLabel =
    yearsRemote <= 0 ? "1 year" : yearsRemote === 1 ? "1 year" : `${yearsRemote} years`;
  const recentBlock =
    recentTitlesAndTags.length > 0
      ? `
RECENT TITLES/TAGS (do not repeat similar themes):
${recentTitlesAndTags.map((x) => `- "${x.title}" | ${(x.tags || []).join(", ")}`).join("\n")}

Do not repeat similar themes or angles from the last 10.
`
      : "";

  const r14 = restriction14 || { titles: [], types: [], tags: [] };
  const hasRestriction =
    r14.titles.length > 0 || r14.types.length > 0 || r14.tags.length > 0;
  const restrictionBlock = hasRestriction
    ? `
——— RESTRIÇÕES DE NÃO REPETIÇÃO (últimos 14 dias) ———
Não repetir temas, títulos, variações fortes ou conceitos similares aos títulos abaixo:
${r14.titles.length > 0 ? r14.titles.map((t) => `- ${t}`).join("\n") : "(nenhum)"}

Não repetir os tipos dos últimos 14 dias: ${r14.types.length > 0 ? r14.types.join(", ") : "(nenhum)"}
${r14.tags.length > 0 ? `Temas/tags recentes a evitar: ${r14.tags.join(", ")}` : ""}

Gere algo realmente novo e diferente dentro do tipo selecionado.
`
    : "";

  const trendsBlock = trendsBlockText ? "\n" + trendsBlockText : "";

  return `
You are writing a video brief for a real creator. Use the context below and output ONLY valid JSON.
${trendsBlock}

——— CREATOR CONTEXT (fixed, real) ———
- Brazilian Frontend developer, ${yearsLabel} working 100% remotely for companies in California (since Dec/2022).
- Fast career progression and technical growth; content is based on real experience, not theory.
- Channel focus: international dev career, frontend, remote life, English for devs, productivity, real stories and pain points.
- Goals: useful, actionable ideas; honest content; topics that Brazilian devs trying to work abroad actually face.
- Every idea must be something the creator could record tomorrow—real, not fictional or hypothetical.

——— VIDEO TYPE FOR THIS BRIEF ———
Type key (use exactly in JSON): "${videoType}"
Context: ${typeContext}
${recentBlock}
${restrictionBlock}

——— INSTRUCTIONS ———
1. THEME: Strong, original, relevant. Root it in real problems (e.g. interviews, timezone, English, salary, visa, impostor syndrome, async work). Avoid generic or superficial angles.
2. TITLE: Strong and strategic for YouTube. Clear benefit or curiosity; no cheap clickbait. "chosen_title" must be the best of "title_options".
3. THUMBNAIL: Concepts must be concrete and visual (specific scene, metaphor, or moment)—not generic dev-at-laptop. "chosen" = the best concept.
4. HOOK (first 10s): Address a real pain or desire of the audience. Something they would immediately recognize. No filler.
5. OUTLINE: Clear segments with real substance. 6–10 min total; topics must be specific, not vague.
6. FULL_SCRIPT: Complete script with storytelling (problem → journey → takeaway). Natural, conversational Brazilian Portuguese. Ready to record.
7. DESCRIPTION: Optimized for search and discovery, but natural to read. Include key terms and one clear value proposition.
8. TAGS: Useful for discovery; mix of Portuguese and English where it makes sense.
9. CTA: One clear next step (subscribe, comment, or specific resource).
10. WHY_TODAY: Real relevance—market trend, seasonality, hiring cycle, tech news, or recurring pain. Be specific, not generic.

——— OUTPUT ———
- Language: Brazilian Portuguese (all text fields).
- Respond with ONLY the JSON object below. No markdown, no explanation before or after.
- Set "video_type" to exactly "${videoType}".

EXACT JSON FORMAT:
{
  "video_type": "${videoType}",
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

Output ONLY the JSON.
  `.trim();
}

// ——— Extract JSON from raw: direct parse, or first { / last }; avoids failure from markdown/whitespace
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

// ——— Email readability-first: index with anchors, blocks, <details> for script/description, TL;DR
function toEmailHtml(payload, opts = {}) {
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
      <p style="margin:4px 0;"><b>Type:</b> ${esc(payload.video_type)} &nbsp;|&nbsp; <b>Goal:</b> ${esc(payload.goal)}</p>
      <p style="margin:4px 0;"><b>Duration:</b> 6–10 min</p>
      <p style="margin:8px 0 0 0;"><b>Speak in 3 points:</b></p>
      <ul style="margin:4px 0; padding-left:20px;">${bullets.map((b) => `<li>${b}</li>`).join("")}</ul>
    </div>`;

  const nav = `
    <nav style="margin:16px 0; padding:12px; background:#f1f3f5; border-radius:8px; font-size:0.95em;">
      <strong>Index:</strong>
      <a href="#hook" style="margin:0 8px; color:#0d6efd;">Hook</a>
      <a href="#outline" style="margin:0 8px; color:#0d6efd;">Outline</a>
      <a href="#thumbnail" style="margin:0 8px; color:#0d6efd;">Thumbnail</a>
      <a href="#script" style="margin:0 8px; color:#0d6efd;">Script</a>
      <a href="#description" style="margin:0 8px; color:#0d6efd;">Description</a>
      <a href="#tags" style="margin:0 8px; color:#0d6efd;">Tags / CTA</a>
    </nav>`;

  const headline = `
    <h1 style="font-size:1.5em; margin:0 0 12px 0; line-height:1.3;">🎬 ${title}</h1>
    <p style="margin:0; color:#495057;"><b>Why today:</b> ${esc(payload.why_today)}</p>`;

  const hookBlock = block(
    "⚡ Hook",
    "hook",
    `<p style="margin:0; white-space:pre-wrap;">${esc(payload.hook_0_10s)}</p>`
  );

  const outlineBlock = block(
    "🧱 Outline",
    "outline",
    `<ul style="margin:0; padding-left:20px;">${outline
      .map((it) => `<li><b>${esc(it.t)}</b> — ${esc(it.topic)}</li>`)
      .join("")}</ul>`
  );

  const thumb = payload.thumbnail?.chosen;
  const thumbnailBlock = block(
    "🖼️ Thumbnail",
    "thumbnail",
    `<p style="margin:0;"><b>Visual:</b> ${esc(thumb?.visual)}<br/><b>Text:</b> ${esc(thumb?.text)}<br/><b>Emotion:</b> ${esc(thumb?.emotion)}</p>`
  );

  const scriptBlock = block(
    "📝 Script",
    "script",
    `<details style="margin:0;"><summary style="cursor:pointer;">View full script</summary><pre style="white-space:pre-wrap; background:#fff; padding:12px; border-radius:6px; margin:8px 0 0 0; font-size:0.9em;">${esc(
      payload.full_script
    )}</pre></details>`
  );

  const descBlock = block(
    "📄 Description",
    "description",
    `<details style="margin:0;"><summary style="cursor:pointer;">View description</summary><pre style="white-space:pre-wrap; background:#fff; padding:12px; border-radius:6px; margin:8px 0 0 0; font-size:0.9em;">${esc(
      payload.description
    )}</pre></details>`
  );

  const tagsBlock = block(
    "🏷️ Tags & CTA",
    "tags",
    `<p style="margin:0;"><b>Tags:</b> ${esc((payload.tags || []).join(", "))}</p><p style="margin:8px 0 0 0;"><b>CTA:</b> ${esc(payload.cta)}</p>`
  );

  const githubRepo = opts.githubRepo || process.env.GITHUB_REPOSITORY || "";
  const favoriteLink =
    githubRepo && payload.chosen_title
      ? `https://github.com/${githubRepo}/issues/new?template=favorite.yml&title=Favorite:+${encodeURIComponent(payload.chosen_title)}&idea_title=${encodeURIComponent(payload.chosen_title)}`
      : "";
  const favoriteBlock =
    favoriteLink
      ? `
  <hr style="margin:24px 0 16px 0; border:0; border-top:1px solid #dee2e6;">
  <p style="margin:0 0 12px 0;">⭐ Gostou dessa ideia?</p>
  <a href="${esc(favoriteLink)}" style="display:inline-block; padding:12px 18px; background:#f5c518; color:#000; text-decoration:none; border-radius:8px; font-weight:600; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">⭐ Salvar nos Favoritos</a>
  `
      : "";

  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.5; max-width: 640px; margin: 0 auto;">
    ${headline}
    ${tldr}
    ${nav}
    ${hookBlock}
    ${outlineBlock}
    ${thumbnailBlock}
    ${scriptBlock}
    ${descBlock}
    ${tagsBlock}
    ${favoriteBlock}
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

  const history = await loadHistory();
  const restriction14 = getRestriction14(history.items || []);
  const videoType = chooseVideoType(restriction14.types);
  const recent = (history.items || []).slice(0, RECENT_FOR_PROMPT).map((i) => ({
    title: i.chosen_title,
    tags: i.tags
  }));
  const trends = loadTrends();
  const trendsSection = trends ? buildTrendsSection(trends) : { text: "", preview: null };
  lastTrendsPreview = trendsSection.preview ?? null;
  if (lastTrendsPreview) {
    logInfo("trends_loaded", {
      keywords_count: lastTrendsPreview.keywords_count ?? 0,
      terms_in_preview: lastTrendsPreview.terms_in_preview ?? [],
      terms_in_preview_count: lastTrendsPreview.terms_in_preview?.length ?? 0
    });
  }
  const prompt = buildPrompt(videoType, recent, restriction14, trendsSection.text);

  const client = new OpenAI({
    apiKey: GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1"
  });

  let raw;
  let llmMs = 0;

  async function callLlm(temperature, extraUserMessage) {
    const t0 = Date.now();
    const messages = [
      { role: "system", content: "Respond only with valid JSON." },
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
      "Return only a single valid JSON object, no markdown and no text before or after."
    );
    payload = extractJson(raw);
  }
  if (!payload) {
    throw new Error("Invalid JSON after retry. Preview:\n" + raw.slice(0, 800));
  }

  const resend = new Resend(RESEND_API_KEY);
  const tResend0 = Date.now();
  const subject = `📬 Video idea (${payload.video_type}) — ${payload.chosen_title}`;
  await resend.emails.send({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject,
    html: toEmailHtml(payload, { githubRepo: process.env.GITHUB_REPOSITORY })
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
    success: true,
    trendsPreview: lastTrendsPreview
  });

  console.log("Email sent successfully!");
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
    errorMessage: msg,
    trendsPreview: lastTrendsPreview
  });
  console.error(err);
  process.exit(1);
});
