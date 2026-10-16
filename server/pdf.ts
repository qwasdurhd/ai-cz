import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import type { Response } from "express";
import type { StoredMessage } from "./device-data";

/* Arabic-aware PDF rendering for Ai - Cz.
 * PDFKit has no complex-text support, so Arabic is reshaped (presentation
 * forms) and re-ordered with the Unicode bidi algorithm before being drawn.
 * A bundled OFL font (Tajawal, supports Arabic + Latin) is used when present. */

let reshaper: ((text: string) => string) | null = null;
let bidi: { getEmbeddingLevels: (text: string) => unknown; getReorderedString: (text: string, info: unknown) => string } | null = null;
let shapingAttempted = false;

async function ensureShaping() {
  if (shapingAttempted) return;
  shapingAttempted = true;
  try {
    const reshaperModule = (await import("arabic-reshaper")).default as { convertArabic?: (text: string) => string } | undefined;
    if (reshaperModule?.convertArabic) reshaper = reshaperModule.convertArabic;
    const bidiModule = (await import("bidi-js")).default as ((...args: unknown[]) => unknown) | undefined;
    const instance = typeof bidiModule === "function" ? (bidiModule as () => unknown)() : bidiModule;
    if (instance && typeof (instance as { getEmbeddingLevels: unknown }).getEmbeddingLevels === "function") {
      bidi = instance as typeof bidi;
    }
  } catch {
    reshaper = null;
    bidi = null;
  }
}

/** Convert logical Arabic text into presentation forms in visual order. */
export async function shapeArabic(text: string): Promise<string> {
  await ensureShaping();
  if (!reshaper || !bidi || !text) return text;
  try {
    const reshaped = reshaper(text);
    const info = bidi.getEmbeddingLevels(reshaped);
    return bidi.getReorderedString(reshaped, info);
  } catch {
    return text;
  }
}

const FONT_NAME = "tajawal";
const FONT_NAME_BOLD = "tajawal-bold";

function moduleDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function resolveFontPair() {
  const each = (name: string) => [
    path.join(moduleDir(), "fonts", name),
    path.join(process.cwd(), "server", "fonts", name),
    process.env.PDF_FONT_DIR ? path.join(process.env.PDF_FONT_DIR, name) : "",
  ].find(candidate => candidate && fs.existsSync(candidate));
  // Amiri (OFL) maps the Arabic presentation forms emitted by the reshaper so
  // shaped Arabic renders with every joining form. Tajawal is kept as a legacy
  // secondary. System fonts are the last resort.
  for (const [regularName, boldName] of [["Amiri-Regular.ttf", "Amiri-Bold.ttf"], ["Tajawal-Regular.ttf", "Tajawal-Bold.ttf"]]) {
    const regular = each(regularName);
    if (!regular) continue;
    return { regular, bold: each(boldName) ?? null };
  }
  const fallback = [process.env.PDF_FONT_PATH, "C:\\Windows\\Fonts\\tahoma.ttf", "C:\\Windows\\Fonts\\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"].find(candidate => candidate && fs.existsSync(candidate));
  return { regular: fallback ?? null, bold: null };
}

function registerFonts(doc: PDFKit.PDFDocument) {
  const { regular, bold } = resolveFontPair();
  if (regular) {
    doc.registerFont(FONT_NAME, regular);
    if (bold) doc.registerFont(FONT_NAME_BOLD, bold);
  }
}

function useFont(doc: PDFKit.PDFDocument, bold = false) {
  const { regular } = resolveFontPair();
  if (regular) doc.font(bold && resolveFontPair().bold ? FONT_NAME_BOLD : FONT_NAME);
  return regular !== null;
}

const ACCENT = "#91b94b";
const INK = "#111827";
const SOFT = "#3c4858";
const MUTED = "#8b98a8";
const LINE = "#d9e2ec";

function stripMarkdown(text: string) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .trim();
}

export type PdfMessage = StoredMessage;

/** Render a single instruction/answer as a clean PDF. */
export async function serveAnswerPdf(
  res: Response,
  input: { title: string; content: string },
) {
  const title = input.title.slice(0, 160) || "Ai - Cz · إجابة";
  const content = stripMarkdown(input.content).slice(0, 120000);
  if (!content.trim()) throw new Error("لا يوجد محتوى لتصديره");
  res.status(200).set({ "Content-Type": "application/pdf", "Content-Disposition": "attachment; filename=ai-cz-answer.pdf", "Cache-Control": "no-store" });
  const doc = new PDFDocument({ size: "A4", margins: { top: 58, bottom: 58, left: 54, right: 54 } });
  registerFonts(doc);
  doc.pipe(res);
  useFont(doc);
  doc.fillColor(ACCENT).fontSize(10).text("AI - CZ", { align: "right" });
  doc.moveDown(0.5).fillColor(INK).fontSize(20).text(await shapeArabic(title), { align: "right" });
  doc.moveDown(1).strokeColor(LINE).moveTo(54, 126).lineTo(541, 126).stroke();
  doc.moveDown(1.3).fillColor(SOFT).fontSize(11).text(await shapeArabic(content), { align: "right", lineGap: 5, width: 487 });
  doc.moveDown(2).fillColor(MUTED).fontSize(8).text(await shapeArabic(`تم التصدير من Ai - Cz · ${new Date().toLocaleString("ar-SA")}`), { align: "right" });
  doc.end();
}

/** Render the full conversation: model name, both speakers, tokens, timestamps. */
export async function serveConversationPdf(
  res: Response,
  input: { title: string; mode?: string; tokens?: number; messages: PdfMessage[] },
) {
  const title = input.title.slice(0, 160) || "محادثة Ai - Cz";
  const modeLabel = input.mode === "agent" ? "Agent (وكيل ذكي)" : "Ai Chat (دردشة)";
  const messages = (input.messages ?? []).slice(0, 200);
  if (!messages.length) throw new Error("لا توجد رسائل لتصديرها");
  const tokenTotal = Math.max(0, Math.floor(Number(input.tokens) || 0));
  res.status(200).set({ "Content-Type": "application/pdf", "Content-Disposition": "attachment; filename=ai-cz-conversation.pdf", "Cache-Control": "no-store" });
  const doc = new PDFDocument({ size: "A4", margins: { top: 54, bottom: 54, left: 54, right: 54 } });
  registerFonts(doc);
  doc.pipe(res);

  // Header
  useFont(doc);
  doc.fillColor(ACCENT).fontSize(10).text("AI - CZ · CONVERSATION", { align: "right" });
  doc.moveDown(0.5).fillColor(INK).fontSize(19).text(await shapeArabic(title), { align: "right" });
  doc.moveDown(0.35).fillColor(SOFT).fontSize(9).text(await shapeArabic(`${modeLabel} · ${messages.length} رسالة · ${tokenTotal.toLocaleString("ar-SA")} توكن`), { align: "right" });
  doc.moveDown(0.9).strokeColor(LINE).moveTo(54, 138).lineTo(541, 138).stroke();
  doc.moveDown(0.9);

  const time = (createdAt: number) => new Date(createdAt).toLocaleString("ar-SA");
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const isUser = message.role === "user";
    const speaker = isUser ? "أنت" : `الرد من ${message.model || "النموذج"}`;
    const line = `[${index + 1}] ${speaker} — ${time(message.createdAt)}${message.tokens ? ` · ${message.tokens} توكن` : ""}`;
    doc.fillColor(ACCENT).fontSize(8.5).text(await shapeArabic(line), { align: "right" });
    doc.moveDown(0.35);
    useFont(doc);
    doc.fillColor(isUser ? SOFT : INK).fontSize(10).text(await shapeArabic(stripMarkdown(message.content)), { align: "right", lineGap: 4, width: 487 });
    doc.moveDown(0.85);
    if (index < messages.length - 1) {
      doc.strokeColor("#e4eaf2").moveTo(54, doc.y).lineTo(541, doc.y).stroke();
    }
    doc.moveDown(0.65);
  }

  // Footer summary
  doc.strokeColor(LINE).moveTo(54, doc.y).lineTo(541, doc.y).stroke();
  doc.moveDown(1).fillColor(MUTED).fontSize(8).text(await shapeArabic(`مُلخّص: ${messages.length} رسالة في محادثة واحدة${tokenTotal ? ` · إجمالي التوكنز ${tokenTotal.toLocaleString("ar-SA")}` : ""} · يصدر عن Ai - Cz · ${new Date().toLocaleString("ar-SA")}`), { align: "right" });
  doc.end();
}