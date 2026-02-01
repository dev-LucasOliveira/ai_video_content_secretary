#!/usr/bin/env node
/**
 * Append one favorite entry to favorites/favorites-weekly.md.
 * Reads from env: ISSUE_TITLE, ISSUE_BODY, ISSUE_URL.
 * Used by save_favorite.yml workflow.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ISSUE_TITLE = process.env.ISSUE_TITLE || "";
const ISSUE_BODY = process.env.ISSUE_BODY || "";
const ISSUE_URL = process.env.ISSUE_URL || "";
const FILE = path.join(process.cwd(), "favorites", "favorites-weekly.md");

function parseFormBody(body) {
  const out = { idea_title: "", summary: "" };
  if (!body || typeof body !== "string") return out;
  const ideaMatch = body.match(/###\s*Idea title\s*\n+([\s\S]*?)(?=\n###|$)/i);
  const summaryMatch = body.match(/###\s*Short summary[^\n]*\n+([\s\S]*?)(?=\n###|$)/i);
  if (ideaMatch) out.idea_title = ideaMatch[1].trim();
  if (summaryMatch) out.summary = summaryMatch[1].trim();
  return out;
}

const parsed = parseFormBody(ISSUE_BODY);
const ideaTitle = parsed.idea_title || ISSUE_TITLE.replace(/^Favorite:\s*/i, "").trim() || "Untitled";
const summary = parsed.summary || "-";
const timestamp = new Date().toISOString();

const block = `
## ⭐ ${ideaTitle}
- Saved at: ${timestamp}
- Issue: ${ISSUE_URL}
- Notes: ${summary}
`;

const dir = path.dirname(FILE);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.appendFileSync(FILE, block);
console.log("Appended favorite:", ideaTitle);
