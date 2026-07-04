/**
 * Recording, scriptable Notifier fake — queue outcomes per notify call
 * (default 'sent').
 */
import type { Notification, Notifier, NotifyOutcome } from '../../src/core/ports/notifier.port.js';
import type { User } from '../../src/shared/entities.js';

export class FakeNotifier implements Notifier {
  readonly sent: { user: User; notification: Notification }[] = [];
  private outcomes: NotifyOutcome[] = [];

  scriptOutcomes(...outcomes: NotifyOutcome[]): void {
    this.outcomes.push(...outcomes);
  }

  async notify(user: User, notification: Notification): Promise<NotifyOutcome> {
    this.sent.push({ user, notification });
    return this.outcomes.shift() ?? 'sent';
  }
}
