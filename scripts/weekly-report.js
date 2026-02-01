#!/usr/bin/env node
/**
 * Lê favorites-weekly.md; se houver favoritos, envia e-mail via Resend,
 * anexa ao archive e limpa o weekly. Usado por weekly_report.yml.
 */
import fs from "fs";
import path from "path";
import { Resend } from "resend";

const WEEKLY_PATH = path.join(process.cwd(), "favorites", "favorites-weekly.md");
const ARCHIVE_PATH = path.join(process.cwd(), "favorites", "favorites-archive.md");
const HEADER_LINES = 4; // título + linha em branco + subtítulo + linha em branco

async function main() {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const EMAIL_TO = process.env.EMAIL_TO;
  const EMAIL_FROM = process.env.EMAIL_FROM;
  if (!RESEND_API_KEY || !EMAIL_TO || !EMAIL_FROM) {
    console.error("Missing RESEND_API_KEY, EMAIL_TO, or EMAIL_FROM");
    process.exit(1);
  }

  if (!fs.existsSync(WEEKLY_PATH)) {
    console.log("No weekly file, skip");
    process.exit(0);
  }

  const raw = fs.readFileSync(WEEKLY_PATH, "utf8");
  const lines = raw.split("\n");
  const header = lines.slice(0, HEADER_LINES).join("\n");
  const body = lines.slice(HEADER_LINES).join("\n").trim();

  if (!body || !body.includes("## ⭐")) {
    console.log("No favorites this week, skip");
    process.exit(0);
  }

  const resend = new Resend(RESEND_API_KEY);
  const esc = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  const html = `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; max-width: 640px;">
    <h1 style="font-size:1.4em;">⭐ Weekly Favorites Report</h1>
    <pre style="white-space: pre-wrap; background: #f6f6f6; padding: 16px; border-radius: 8px;">${esc(body)}</pre>
  </div>
  `.trim();

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: EMAIL_TO,
      subject: "⭐ Weekly Favorites Report",
      html,
    });
  } catch (e) {
    console.error("Resend failed:", e.message);
    process.exit(1);
  }

  const weekLabel = `## Week of ${new Date().toISOString().slice(0, 10)}\n\n`;
  if (fs.existsSync(ARCHIVE_PATH)) {
    fs.appendFileSync(ARCHIVE_PATH, weekLabel + body + "\n\n");
  } else {
    fs.writeFileSync(ARCHIVE_PATH, weekLabel + body + "\n\n", "utf8");
  }

  fs.writeFileSync(WEEKLY_PATH, header + "\n", "utf8");
  console.log("Weekly report sent, archive updated, weekly cleared.");
}

main();
