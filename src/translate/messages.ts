import { createHash } from "node:crypto";
import type { TurnInputPart } from "../muse/turn.js";

/** The subset of an OpenAI chat message open-muse reads. */
export interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | ContentPart[] | null;
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: string | { url: string } }
  | { type: string; [key: string]: unknown };

export function textOf(message: ChatMessage): string {
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof (p as any).text === "string")
    .map((p) => p.text)
    .join("\n");
}

function imagesOf(message: ChatMessage): TurnInputPart[] {
  if (!Array.isArray(message.content)) return [];
  const parts: TurnInputPart[] = [];
  for (const part of message.content) {
    if (part.type !== "image_url") continue;
    const raw = (part as any).image_url;
    const url: string = typeof raw === "string" ? raw : raw?.url ?? "";
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
    if (match) parts.push({ type: "image", mediaType: match[1], base64Data: match[2] });
  }
  return parts;
}

/** Muse turn input for one OpenAI user message: its text plus any inline images. */
export function toTurnInput(message: ChatMessage, prefix?: string): TurnInputPart[] {
  const text = [prefix, textOf(message)].filter(Boolean).join("\n\n");
  const parts: TurnInputPart[] = [];
  if (text) parts.push({ type: "text", text });
  parts.push(...imagesOf(message));
  if (parts.length === 0) parts.push({ type: "text", text: "(empty message)" });
  return parts;
}

export function userMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.role === "user");
}

/** Stable digest of the user side of a conversation, used to tell "same conversation, one more message" from "history was edited". */
export function digestUsers(users: ChatMessage[]): string {
  const hash = createHash("sha256");
  for (const m of users) {
    hash.update(textOf(m));
    hash.update(`\u0000${imagesOf(m).length}\u0001`);
  }
  return hash.digest("hex");
}

export function systemPrompt(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map(textOf)
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Render earlier conversation for a brand-new Muse session that has to pick up
 * a conversation midway (OpenCode restarted with no saved mapping, the user
 * reverted/edited history, or OpenCode compacted the session).
 */
export function renderHistory(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = textOf(m).trim();
    if (!text) continue;
    lines.push(`<${m.role}>\n${text}\n</${m.role}>`);
  }
  if (lines.length === 0) return "";
  return [
    "This conversation is continuing from an earlier session. Prior messages, for context only:",
    "<conversation_history>",
    ...lines,
    "</conversation_history>",
    "Respond to the new message below.",
  ].join("\n");
}

/** A short title from the user's first message, so OpenCode's title requests don't spend a Muse prompt. */
export function localTitle(messages: ChatMessage[]): string {
  const lines = userMessages(messages)
    .map(textOf)
    .join("\n")
    .replace(/<[^>]+>/g, " ")
    .split(/\r?\n/)
    .map((l) => l.trim())
    // OpenCode wraps the real message in a title instruction; skip it.
    .filter((l) => l.length > 0 && !/^generate a title\b/i.test(l));
  const firstLine = lines[0] ?? "New session";
  const clean = firstLine.replace(/\s+/g, " ").replace(/^["'`]+|["'`]+$/g, "");
  return clean.length > 50 ? `${clean.slice(0, 47).trimEnd()}...` : clean;
}
