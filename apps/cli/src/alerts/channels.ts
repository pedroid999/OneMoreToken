import { type AlertChannelRegistry, createAlertChannelRegistry } from "@omt/core";
import type { ServeOptions } from "../options";
import { createTelegramChannel } from "./telegram";

type Credentials = Pick<ServeOptions, "telegramBotToken" | "telegramChatId">;

/**
 * The channels the configured credentials allow. Empty means no egress at all (spec §10): an alert
 * without a channel is reported at startup instead of being retried forever.
 */
export function alertChannels(options: Credentials): AlertChannelRegistry {
  const { telegramBotToken, telegramChatId } = options;
  if (!telegramBotToken || !telegramChatId) return new Map();
  return createAlertChannelRegistry([
    createTelegramChannel({ botToken: telegramBotToken, chatId: telegramChatId }),
  ]);
}
