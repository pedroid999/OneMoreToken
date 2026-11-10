import type { AlertChannel, AlertMessage } from "@omt/core";

/** The slice of `fetch` this channel needs; injected so tests never touch the network. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

export interface TelegramOptions {
  /** Secret: read from a flag or the environment, never logged and never stored. */
  botToken: string;
  chatId: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/** Telegram's Bot API refuses long messages; this is its own limit for a text message. */
const MAX_MESSAGE_CHARS = 4096;

/**
 * The first pluggable channel (spec §9, T7). A rejection makes the pass retry the instance later;
 * the error never carries the URL, so the token cannot reach a log line.
 */
export function createTelegramChannel(options: TelegramOptions): AlertChannel {
  const send = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const text = (message: AlertMessage) =>
    `${message.subject}\n\n${message.text}`.slice(0, MAX_MESSAGE_CHARS);
  return {
    id: "telegram",
    async send(message: AlertMessage): Promise<void> {
      let response: { ok: boolean; status: number };
      try {
        response = await send(`https://api.telegram.org/bot${options.botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: options.chatId,
            text: text(message),
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        });
      } catch {
        // Deliberately opaque: the underlying error may quote the request URL with the token.
        throw new Error("telegram request failed");
      }
      if (!response.ok) throw new Error(`telegram responded ${response.status}`);
    },
  };
}
