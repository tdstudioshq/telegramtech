/**
 * The custom Telegraf context for this bot. Middleware progressively enriches it:
 * correlation → logging → rate-limit → auth (attaches `user`). Handlers read the
 * enriched fields; nothing here leaks Telegraf types into core (rule 1).
 */
import type { Context } from 'telegraf';
import type { Logger } from '../../logging/logger.js';
import type { User } from '../../shared/entities.js';

export interface BotContext extends Context {
  /** update_id-derived id threaded into every service call and log line (ADR-015). */
  correlationId: string;
  /** Child logger bound to correlationId + the acting telegram id. */
  log: Logger;
  /** Set by the auth middleware (UserService.ensureRegistered). Absent only before it runs. */
  user?: User;
}
