/** The text a channel delivers; rendering never knows which channel will carry it. */
export interface AlertMessage {
  subject: string;
  text: string;
}

export interface AlertChannel {
  id: string;
  /** Resolves when the message was accepted by the channel; a rejection is retried next pass. */
  send(message: AlertMessage): Promise<void>;
}

/** Channels by id, so the evaluator never imports a concrete transport. */
export type AlertChannelRegistry = ReadonlyMap<string, AlertChannel>;

export function createAlertChannelRegistry(
  channels: readonly AlertChannel[],
): AlertChannelRegistry {
  return new Map(channels.map((channel) => [channel.id, channel]));
}
