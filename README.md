# Daily Content Idea

A system that runs daily via **GitHub Actions**, uses the **Groq API** (OpenAI-compatible) to generate a complete video idea in JSON, and emails it to you via **Resend**. Built for YouTube content strategy around dev career (BR → abroad) and frontend.

---

## What it does

1. **Mon–Fri + Sun at 9h, 9h05, 9h10, 9h15, 9h20 São Paulo (UTC-3)** — or on manual trigger — the workflow runs.
2. **Groq (LLM)** generates one full video package: type (`career_international` / `tech_frontend` / `life_productivity` / `communication_english` / `strategy_content`), title options, chosen title, thumbnail concepts, hook, outline, full script, description, tags, CTA, and “why today.”
3. **History** is stored in a single GitHub Issue (last 50 items). The prompt receives the last 10 titles/tags so the model avoids repeating similar themes.
4. **Resend** sends a formatted, readability-first HTML email with the idea.
5. **Debug artifacts** (run metadata, response preview, summary) are uploaded to the Actions run and shown in the Step Summary.

---

## Features

| Feature | Description |
|--------|-------------|
| **Cron** | Mon–Fri + Sun 9h / 9h05 / 9h10 / 9h15 / 9h20 BRT = `0,5,10,15,20 12 * * 0,1-5` UTC |
| **History** | GitHub Issue `daily-content-idea-history` as JSON storage (max 50 items, no DB) |
| **Anti-repetition** | 14-day window: types/titles/tags from last 14 days excluded; prompt gets "don't repeat" block |
| **Trends** | PyTrends → `trends.json`; prompt gets a short "real trends" block (BR/US dev keywords) |
| **Favorites** | Link in daily email → GitHub Issue (template); workflow appends to weekly, closes issue; Saturday report emails and archives |
| **Observability** | Structured JSON logs, run ID, timings (total, LLM, Resend), debug bundle, Step Summary with Trends yes/no |
| **Email** | Index with anchors, TL;DR, collapsible script/description, inline styles (Gmail-safe), "Save to Favorites" link |
| **Robust JSON** | `extractJson` (direct parse + first `{` / last `}`) + one LLM retry at lower temperature |

---

## Requirements

- **Node.js 20+**
- **Env vars** (see below)
- **Groq API key** — [console.groq.com](https://console.groq.com)
- **Resend API key** — [resend.com](https://resend.com) (e.g. `onboarding@resend.dev` for testing)

---

## Setup

### 1. GitHub Actions secrets

In the repo: **Settings → Secrets and variables → Actions**, add:

| Secret | Required | Description |
|--------|----------|-------------|
| `GROQ_API_KEY` | Yes | Groq API key |
| `RESEND_API_KEY` | Yes | Resend API key |
| `EMAIL_TO` | Yes | Email that receives the idea |
| `EMAIL_FROM` | Yes | Sender (must be a verified domain in Resend, or e.g. `onboarding@resend.dev`) |
| `GROQ_MODEL` | No | Default: `llama-3.3-70b-versatile` |

`GITHUB_TOKEN` and `GITHUB_REPOSITORY` are set automatically by the workflow (no need to create them).

### 2. Local development

Clone and install:

```bash
git clone <repo-url>
cd ai_video_content_secretary
npm install
```

Set env vars (optional: add `GITHUB_TOKEN` + `GITHUB_REPOSITORY` to enable history):

```bash
export GROQ_API_KEY="your-groq-key"
export RESEND_API_KEY="your-resend-key"
export EMAIL_TO="you@example.com"
export EMAIL_FROM="Ideas <onboarding@resend.dev>"
# Optional: for history (issue read/write)
export GITHUB_TOKEN="ghp_..."
export GITHUB_REPOSITORY="owner/repo"
```

Run once:

```bash
npm run daily
```

---

## Project structure

```
.
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   └── favorite.yml   # "Save Favorite Idea" form (idea_title, summary)
│   └── workflows/
│       ├── daily.yml      # Mon–Fri + Sun 12:00/12:05/12:10/12:15/12:20 UTC; PyTrends; npm run daily; debug artifacts
│       ├── save_favorite.yml   # On issue opened (label/title "Favorite: ...") → append weekly, close issue
│       └── weekly_report.yml  # Saturday 12:00 UTC; email weekly favorites, archive, clear weekly
├── favorites/
│   ├── favorites-weekly.md   # Current week favorites (appended by save_favorite)
│   └── favorites-archive.md # Past weeks (appended by weekly_report)
├── scripts/
│   ├── append-favorite.js   # Parses issue body, appends to favorites-weekly.md
│   └── weekly-report.js      # Sends Resend email, appends to archive, clears weekly
├── src/
│   └── daily-idea.js      # Main: Groq, history, trends, Resend, debug bundle, extractJson
├── trends.py              # Fetches Google Trends (BR/US) for dev keywords → trends.json
├── debug/                 # Generated at runtime (.gitignore)
│   ├── last-run.json
│   ├── last-response-preview.txt
│   ├── last-payload.json
│   ├── summary.md
│   └── trends-preview.json
├── package.json
└── README.md
```

---

## Running

### On schedule

The workflow runs **Mon–Fri + Sun at 12:00, 12:05, 12:10, 12:15, 12:20 UTC** (9h, 9h05, 9h10, 9h15, 9h20 São Paulo).

### Manual run

1. **Actions** → **Daily Content Idea** → **Run workflow** → **Run workflow**.

### Locally

```bash
npm run daily
```

If `GITHUB_TOKEN` or `GITHUB_REPOSITORY` is missing, the script still runs but skips loading/saving history (logs `history_skip`).

---

## History (GitHub Issue)

- **Issue title:** `daily-content-idea-history`
- **Body:** JSON only, e.g.:

```json
{
  "version": 1,
  "items": [
    {
      "ts": "2025-01-31T12:00:00.000Z",
      "video_type": "career_international",
      "chosen_title": "...",
      "tags": ["carreira", "..."],
      "hook": "...",
      "why_today": "..."
    }
  ]
}
```

- New idea is **prepended**; list is **sliced to 50**.
- If the issue doesn’t exist, it is created. If the body is invalid JSON, it is re-initialized with `{ "version": 1, "items": [] }`.

---

## Debug and observability

- **Structured logs:** One JSON line per event (`logInfo` / `logWarn` / `logError`). No secrets; only env var names (present/absent).
- **Run ID:** Unique per run (timestamp + random) for correlating logs and artifacts.
- **Timings:** `totalMs`, `llmMs`, `resendMs` in `debug/last-run.json`.
- **Artifacts:** The workflow uploads the `debug/` folder as **debug-artifacts** (on success or failure).
- **Step Summary:** Content of `debug/summary.md` is appended to the job’s Step Summary in the Actions UI.

---

## Video types

- **Selection:** Random, with 14-day anti-repetition: types (and related titles/tags) from the last 14 days are excluded; one type is chosen uniformly from the remaining.
- **Fallback:** If all types are excluded or none available, `career_international` is used.
- **Valid types:** `career_international`, `tech_frontend`, `life_productivity`, `communication_english`, `strategy_content`.

---

## License

Private / use as you like.
