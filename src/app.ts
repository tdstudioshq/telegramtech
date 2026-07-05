/**
 * Composition root: the only module that wires core, persistence, providers,
 * the Telegram client, and the M5 background job scheduler together.
 */
import { createApiHandler } from './adapters/api/router.js';
import { ScryptPasswordHasher } from './adapters/auth/scrypt-password-hasher.js';
import { CryptoSessionTokenService } from './adapters/auth/crypto-session-token.js';
import { MemoryCacheProvider } from './adapters/cache/memory-cache.provider.js';
import { NoopCacheProvider } from './adapters/cache/noop-cache.provider.js';
import { SupabaseStorageProvider } from './adapters/content/supabase-storage.provider.js';
import { MockPaymentProvider } from './adapters/payments/mock-payment.provider.js';
import { createDatabase } from './adapters/persistence/db/client.js';
import { DrizzleUnitOfWork } from './adapters/persistence/db/unit-of-work.js';
import {
  configureTelegramBot,
  createTelegramBot,
  createTelegramWebhookHandler,
  deleteTelegramWebhook,
  registerTelegramWebhook,
  startTelegramPolling,
  type TelegramBotConfig,
} from './adapters/telegram/bot.js';
import { CreatorContext } from './adapters/telegram/creator-context.js';
import { TelegramContentTransport } from './adapters/telegram/telegram-content-transport.js';
import { TelegramNotifier } from './adapters/telegram/telegram-notifier.js';
import {
  APP_VERSION,
  HEALTH_PATH,
  SUBSCRIPTION_SWEEP_BATCH,
  STALE_PAYMENT_BATCH,
} from './config/constants.js';
import type { Env } from './config/env.js';
import { DeliveryEngine } from './core/engines/delivery.engine.js';
import { NotificationEngine } from './core/engines/notification.engine.js';
import { EventDispatcher } from './core/events/dispatcher.js';
import { analyticsStub } from './core/events/handlers/analytics.handler.js';
import {
  contentUnlockedEnrichment,
  purchaseCompletedEnrichment,
} from './core/events/handlers/audit-enrichment.handler.js';
import {
  paymentFailedNotification,
  subscriptionActivatedNotification,
  subscriptionExpiredNotification,
} from './core/events/handlers/notification.handler.js';
import type { CacheProvider } from './core/ports/cache-provider.port.js';
import type { Clock } from './core/ports/clock.port.js';
import { AccessService } from './core/services/access.service.js';
import { AnalyticsService } from './core/services/analytics.service.js';
import { AuditService } from './core/services/audit.service.js';
import { AuthService } from './core/services/auth.service.js';
import { CreatorService } from './core/services/creator.service.js';
import { DropService } from './core/services/drop.service.js';
import { PurchaseService } from './core/services/purchase.service.js';
import { SubscriptionService } from './core/services/subscription.service.js';
import { UserService } from './core/services/user.service.js';
import { createAnalyticsJob } from './jobs/analytics.job.js';
import { createCleanupJob } from './jobs/cleanup.job.js';
import { createNotificationJob } from './jobs/notification.job.js';
import { createSubscriptionExpirationJob } from './jobs/subscription-expiration.job.js';
import { Scheduler, loggingJobMetrics } from './jobs/scheduler.js';
import type { Logger } from './logging/logger.js';
import { createHealthCheck } from './server/health.js';
import { HttpServer, type WebhookRoute } from './server/http-server.js';

export interface Application {
  start(): Promise<void>;
  stop(reason: string): Promise<void>;
}

const systemClock: Clock = { now: () => new Date() };

export const createApplication = (env: Env, logger: Logger): Application => {
  if (env.PAYMENT_PROVIDER !== 'mock') {
    throw new Error(`PAYMENT_PROVIDER=${env.PAYMENT_PROVIDER} is reserved and not implemented`);
  }

  const database = createDatabase(env.DATABASE_URL);
  const dispatcher = new EventDispatcher(logger.child({ module: 'events' }));
  const uow = new DrizzleUnitOfWork(database.db, dispatcher);
  const audit = new AuditService();
  const access = new AccessService(uow, systemClock);
  const users = new UserService(uow, audit);
  const creators = new CreatorService(uow);
  const drops = new DropService(uow, audit, systemClock);
  const cache = createCache(env, systemClock);
  const creatorContext = new CreatorContext(cache, creators, env.DEFAULT_CREATOR_SLUG);
  const paymentProvider = new MockPaymentProvider({
    delayMs: env.MOCK_PAYMENT_DELAY_MS,
    failureRate: env.MOCK_PAYMENT_FAILURE_RATE,
  });
  const purchases = new PurchaseService(uow, paymentProvider, access, audit, systemClock);
  const subscriptions = new SubscriptionService(uow, purchases, audit, systemClock);
  const analytics = new AnalyticsService(uow, systemClock);
  const auth = new AuthService(
    uow,
    new ScryptPasswordHasher(),
    new CryptoSessionTokenService(),
    systemClock,
    audit,
    env.SESSION_TTL_HOURS,
  );

  const bot = createTelegramBot(env.BOT_TOKEN);
  const notifier = new TelegramNotifier(bot.telegram);
  const transport = new TelegramContentTransport(
    bot.telegram,
    uow,
    logger.child({ module: 'telegram-transport' }),
  );
  const content = new SupabaseStorageProvider(
    {
      url: env.SUPABASE_URL,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
      bucket: env.STORAGE_BUCKET,
      signedUrlTtlSeconds: env.SIGNED_URL_TTL_SECONDS,
    },
    systemClock,
  );
  const delivery = new DeliveryEngine(uow, access, content, transport, audit, systemClock);
  const notifications = new NotificationEngine(uow, notifier);

  registerEventHandlers(dispatcher, uow, audit, notifications);

  const scheduler = buildScheduler(env, logger, cache, subscriptions, notifications, purchases);

  const botConfig: TelegramBotConfig = {
    token: env.BOT_TOKEN,
    mode: env.BOT_MODE,
    webhookUrl: env.WEBHOOK_URL,
    webhookSecretToken: env.WEBHOOK_SECRET_TOKEN,
    port: env.PORT,
    rateLimitPoints: env.RATE_LIMIT_POINTS,
    rateLimitWindowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
  };
  configureTelegramBot(bot, botConfig, {
    creatorContext,
    users,
    drops,
    access,
    purchases,
    subscriptions,
    delivery,
    cache,
    logger: logger.child({ module: 'telegram' }),
  });

  const isWebhook = env.BOT_MODE === 'webhook';
  // In webhook mode the update handler is built synchronously (no network) and mounted
  // on our HTTP server; setWebhook runs later, once the server is listening.
  const webhookRoute: WebhookRoute | undefined = isWebhook
    ? { path: new URL(requireWebhookUrl(env)).pathname, handler: createTelegramWebhookHandler(bot, botConfig) }
    : undefined;
  const apiHandler = createApiHandler({
    auth,
    creators,
    drops,
    subscriptions,
    analytics,
    content,
    logger: logger.child({ module: 'api' }),
  });
  const httpServer = new HttpServer(
    {
      port: env.PORT,
      healthPath: HEALTH_PATH,
      webhook: webhookRoute,
      api: { prefix: '/api', handler: apiHandler },
    },
    createHealthCheck({ database, version: APP_VERSION }),
    logger.child({ module: 'http' }),
  );

  let started = false;
  return {
    async start(): Promise<void> {
      started = true;
      try {
        // Fail fast if the database is unreachable — nothing downstream can work.
        await database.ping();
        logger.info('database reachable');
        // Health endpoint + (webhook mode) the update route must be live before we
        // tell Telegram to POST. The scheduler is armed before the polling launch,
        // which blocks until shutdown (jobs don't depend on the bot being up).
        await httpServer.start();
        scheduler.start();
        if (isWebhook) {
          await registerTelegramWebhook(bot, botConfig);
          logger.info('webhook registered — accepting updates');
        } else {
          await startTelegramPolling(bot); // blocks until the bot stops
        }
      } catch (error) {
        started = false;
        await scheduler.stop();
        await httpServer.stop();
        throw error;
      }
    },
    async stop(reason: string): Promise<void> {
      // Stop accepting inbound requests first, then quiesce the bot, drain in-flight
      // jobs, and finally close the pool so no transaction is severed mid-flight.
      await httpServer.stop();
      if (isWebhook) {
        await deleteTelegramWebhook(bot).catch((err: unknown) =>
          logger.warn({ err }, 'failed to delete webhook on shutdown (ignored)'),
        );
      } else if (started) {
        bot.stop(reason);
      }
      started = false;
      await scheduler.stop();
      await database.close();
    },
  };
};

/** WEBHOOK_URL is guaranteed present in webhook mode by env validation; guard defensively. */
const requireWebhookUrl = (env: Env): string => {
  if (env.WEBHOOK_URL === undefined) {
    throw new Error('WEBHOOK_URL is required in webhook mode (env validation should have caught this)');
  }
  return env.WEBHOOK_URL;
};

const MINUTE_MS = 60_000;

/** Wires the M5 scheduler: intervals from config, batch sizes from constants (§11). */
const buildScheduler = (
  env: Env,
  logger: Logger,
  cache: CacheProvider,
  subscriptions: SubscriptionService,
  notifications: NotificationEngine,
  purchases: PurchaseService,
): Scheduler => {
  const jobLogger = logger.child({ module: 'jobs' });
  const scheduler = new Scheduler(cache, jobLogger, loggingJobMetrics(jobLogger));
  scheduler.register(
    createSubscriptionExpirationJob(subscriptions, {
      intervalMs: env.JOB_SUBSCRIPTION_SWEEP_INTERVAL * MINUTE_MS,
      lockTtlSeconds: env.JOB_SUBSCRIPTION_SWEEP_INTERVAL * 60,
      batchSize: SUBSCRIPTION_SWEEP_BATCH,
    }),
  );
  scheduler.register(
    createNotificationJob(notifications, {
      intervalMs: env.JOB_NOTIFICATION_INTERVAL * MINUTE_MS,
      lockTtlSeconds: env.JOB_NOTIFICATION_INTERVAL * 60,
    }),
  );
  scheduler.register(
    createCleanupJob(purchases, {
      intervalMs: env.JOB_CLEANUP_INTERVAL * MINUTE_MS,
      lockTtlSeconds: env.JOB_CLEANUP_INTERVAL * 60,
      stalePendingMinutes: env.PENDING_PAYMENT_TTL_MINUTES,
      batchSize: STALE_PAYMENT_BATCH,
    }),
  );
  scheduler.register(createAnalyticsJob());
  return scheduler;
};

const createCache = (env: Env, clock: Clock): CacheProvider => {
  switch (env.CACHE_PROVIDER) {
    case 'memory':
      return new MemoryCacheProvider(clock);
    case 'noop':
      return new NoopCacheProvider();
    case 'redis':
      throw new Error('CACHE_PROVIDER=redis is reserved and not implemented');
  }
};

const registerEventHandlers = (
  dispatcher: EventDispatcher,
  uow: DrizzleUnitOfWork,
  audit: AuditService,
  notifications: NotificationEngine,
): void => {
  dispatcher.register(
    'PurchaseCompleted',
    'audit.purchase-completed',
    purchaseCompletedEnrichment(uow, audit),
  );
  dispatcher.register('PurchaseCompleted', 'analytics.stub', analyticsStub());
  dispatcher.register(
    'ContentUnlocked',
    'audit.content-unlocked',
    contentUnlockedEnrichment(uow, audit),
  );
  dispatcher.register(
    'PaymentFailed',
    'notification.payment-failed',
    paymentFailedNotification(notifications),
  );
  dispatcher.register(
    'SubscriptionActivated',
    'notification.subscription-activated',
    subscriptionActivatedNotification(notifications),
  );
  dispatcher.register(
    'SubscriptionExpired',
    'notification.subscription-expired',
    subscriptionExpiredNotification(notifications),
  );
};
