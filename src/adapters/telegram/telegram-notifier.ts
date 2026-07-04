import { TelegramError, type Telegram } from 'telegraf';
import type { Notification, Notifier, NotifyOutcome } from '../../core/ports/notifier.port.js';
import type { User } from '../../shared/entities.js';

type TelegramNotifierApi = Pick<Telegram, 'sendMessage'>;

export class TelegramNotifier implements Notifier {
  constructor(private readonly telegram: TelegramNotifierApi) {}

  async notify(user: User, notification: Notification): Promise<NotifyOutcome> {
    try {
      await this.telegram.sendMessage(user.telegramId.toString(), notification.text);
      return 'sent';
    } catch (error) {
      return isBlockedTelegramError(error) ? 'blocked' : 'failed';
    }
  }
}

export const isBlockedTelegramError = (error: unknown): boolean => {
  const response =
    error instanceof TelegramError
      ? error.response
      : typeof error === 'object' && error !== null && 'response' in error
        ? (error as { response?: { error_code?: unknown; description?: unknown } }).response
        : undefined;
  if (response?.error_code !== 403 || typeof response.description !== 'string') return false;
  return /blocked by the user|user is deactivated|bot was kicked/i.test(response.description);
};
