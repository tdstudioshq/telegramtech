/**
 * Composition root: the only module that wires core, persistence, providers,
 * the Telegram client, and the M5 background job scheduler together.
 */
import { MemoryCacheProvider } from './adapters/cache/memory-cache.provider.js';
import { NoopCacheProvider } from './adapters/cache/noop-cache.provider.js';
import { SupabaseStorageProvider } from './adapters/content/supabase-storage.provider.js';
import { MockPaymentProvider } from './adapters/payments/mock-payment.provider.js';
import { createDatabase } from './adapters/persistence/db/client.js';
import { SEED_IDS } from './adapters/persistence/db/seed.js';
import { DrizzleUnitOfWork } from './adapters/persistence/db/unit-of-work.js';
import {
  configureTelegramBot,
  createTelegramBot,
  launchTelegramBot,
  type TelegramBotConfig,
} from './adapters/telegram/bot.js';
import { TelegramContentTransport } from './adapters/telegram/telegram-content-transport.js';
import { TelegramNotifier } from './adapters/telegram/telegram-notifier.js';
import { SUBSCRIPTION_SWEEP_BATCH, STALE_PAYMENT_BATCH } from './config/constants.js';
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
import { AuditService } from './core/services/audit.service.js';
import { DropService } from './core/services/drop.service.js';
import { PurchaseService } from './core/services/purchase.service.js';
import { SubscriptionService } from './core/services/subscription.service.js';
import { UserService } from './core/services/user.service.js';
import { createAnalyticsJob } from './jobs/analytics.job.js';
import { createCleanupJob } from './jobs/cleanup.job.js';
import { createNotificationJob } from './jobs/notification.job.js';
import { createSubscriptionExpirationJob } from './jobs/subscription-expiration.job.js';
import { Scheduler } from './jobs/scheduler.js';
import type { Logger } from './logging/logger.js';

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
  const drops = new DropService(uow, audit, systemClock);
  const cache = createCache(env, systemClock);
  const paymentProvider = new MockPaymentProvider({
    delayMs: env.MOCK_PAYMENT_DELAY_MS,
    failureRate: env.MOCK_PAYMENT_FAILURE_RATE,
  });
  const purchases = new PurchaseService(uow, paymentProvider, access, audit, systemClock);
  const subscriptions = new SubscriptionService(uow, purchases, audit, systemClock);

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
    creatorId: SEED_IDS.creator,
    premiumPlanId: SEED_IDS.premiumPlan,
    users,
    drops,
    access,
    purchases,
    subscriptions,
    delivery,
    cache,
    logger: logger.child({ module: 'telegram' }),
  });

  let started = false;
  return {
    async start(): Promise<void> {
      started = true;
      try {
        // Arm the job timers first: in polling mode launchTelegramBot blocks until
        // the bot stops, so anything after it would never run. The scheduler start
        // is non-blocking and the jobs don't depend on the bot being launched.
        scheduler.start();
        await launchTelegramBot(bot, botConfig);
      } catch (error) {
        started = false;
        await scheduler.stop();
        throw error;
      }
    },
    async stop(reason: string): Promise<void> {
      if (started) {
        bot.stop(reason);
        started = false;
      }
      // stop the scheduler (awaiting in-flight runs) before closing the pool so no
      // job transaction is severed mid-flight.
      await scheduler.stop();
      await database.close();
    },
  };
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
  const scheduler = new Scheduler(cache, logger.child({ module: 'jobs' }));
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
