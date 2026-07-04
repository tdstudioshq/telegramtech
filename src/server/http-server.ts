/**
 * Production HTTP server (M6). One Node http server on `PORT` serves both:
 *  - the health probe (`GET {healthPath}` → 200 when ok, 503 when degraded), and
 *  - in webhook mode, the Telegram update endpoint (delegated to a telegraf
 *    request handler that verifies the secret token).
 * Everything else is 404. In polling (dev) mode `webhook` is omitted and only the
 * health route is served. Lives in the composition zone — it knows nothing about
 * Telegram beyond the opaque request handler app.ts hands it.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '../logging/logger.js';
import type { HealthCheck } from './health.js';

export type HttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  next?: () => void,
) => void | Promise<void>;

export interface WebhookRoute {
  readonly path: string;
  readonly handler: HttpRequestHandler;
}

export interface HttpServerConfig {
  readonly port: number;
  readonly healthPath: string;
  readonly webhook?: WebhookRoute;
}

export class HttpServer {
  private server: Server | null = null;
  private boundPort = 0;

  constructor(
    private readonly config: HttpServerConfig,
    private readonly healthCheck: HealthCheck,
    private readonly logger: Logger,
  ) {}

  /** The actually-bound port (useful when configured with port 0 in tests). */
  get port(): number {
    return this.boundPort;
  }

  start(): Promise<void> {
    const server = createServer((req, res) => void this.route(req, res));
    this.server = server;
    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      server.once('error', onError);
      server.listen(this.config.port, () => {
        server.off('error', onError);
        this.boundPort = (server.address() as AddressInfo).port;
        this.logger.info(
          {
            port: this.boundPort,
            healthPath: this.config.healthPath,
            webhookPath: this.config.webhook?.path ?? null,
          },
          'http server listening',
        );
        resolve();
      });
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];

    if (path === this.config.healthPath) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return this.send(res, 405, { error: 'method_not_allowed' });
      }
      try {
        const report = await this.healthCheck();
        return this.send(res, report.status === 'ok' ? 200 : 503, report);
      } catch (err) {
        this.logger.error({ err }, 'health check threw');
        return this.send(res, 503, { status: 'degraded', error: 'healthcheck_failed' });
      }
    }

    const webhook = this.config.webhook;
    if (webhook !== undefined && path === webhook.path) {
      await webhook.handler(req, res);
      return;
    }

    this.send(res, 404, { error: 'not_found' });
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  /** Stops accepting connections and resolves once existing ones drain. */
  async stop(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
