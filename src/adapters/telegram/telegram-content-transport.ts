import { Input, type Telegram } from 'telegraf';
import type {
  ContentTransport,
  SendOptions,
  TransportContent,
} from '../../core/ports/content-transport.port.js';
import type { UnitOfWork } from '../../core/repositories/index.js';
import { appError, type AppError } from '../../shared/app-error.js';
import type { DropAsset, User } from '../../shared/entities.js';
import { err, ok, type Result } from '../../shared/result.js';

type TelegramTransportApi = Pick<
  Telegram,
  'getMe' | 'sendMessage' | 'sendPhoto' | 'sendVideo' | 'sendDocument'
>;

export interface TransportLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

export class TelegramContentTransport implements ContentTransport {
  private botIdPromise?: Promise<number>;

  constructor(
    private readonly telegram: TelegramTransportApi,
    private readonly uow: UnitOfWork,
    private readonly logger: TransportLogger,
  ) {}

  async send(
    user: User,
    content: TransportContent,
    options: SendOptions,
  ): Promise<Result<void, AppError>> {
    const chatId = user.telegramId.toString();
    try {
      if (content.kind === 'text') {
        await this.telegram.sendMessage(chatId, content.text, {
          protect_content: options.protect,
        });
        return ok(undefined);
      }

      const cacheKey = await this.cacheKey();
      const cachedFileId = content.asset.transportCache?.[cacheKey];
      let fileId: string;
      if (cachedFileId !== undefined) {
        try {
          fileId = await this.sendMedia(chatId, content.asset, cachedFileId, options);
        } catch {
          // Cached Telegram ids are rebuildable. Retry once from source and refresh it.
          fileId = await this.sendMedia(
            chatId,
            content.asset,
            Input.fromURLStream(content.deliverable.url),
            options,
          );
        }
      } else {
        fileId = await this.sendMedia(
          chatId,
          content.asset,
          Input.fromURLStream(content.deliverable.url),
          options,
        );
      }
      await this.writeCache(content.asset, cacheKey, fileId);
      return ok(undefined);
    } catch (error) {
      return err(
        appError('internal', 'Content delivery failed. Please try again.', {
          transport: 'telegram',
          cause: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  private async cacheKey(): Promise<string> {
    this.botIdPromise ??= this.telegram.getMe().then((bot) => bot.id);
    return `telegram:${await this.botIdPromise}`;
  }

  private async sendMedia(
    chatId: string,
    asset: DropAsset,
    input: string | ReturnType<typeof Input.fromURLStream>,
    options: SendOptions,
  ): Promise<string> {
    const extra = { protect_content: options.protect };
    switch (asset.contentType) {
      case 'photo': {
        const message = await this.telegram.sendPhoto(chatId, input, extra);
        const lastPhoto = message.photo.at(-1);
        if (lastPhoto === undefined) throw new Error('Telegram photo response had no file id');
        return lastPhoto.file_id;
      }
      case 'video': {
        const message = await this.telegram.sendVideo(chatId, input, extra);
        return message.video.file_id;
      }
      case 'document': {
        const message = await this.telegram.sendDocument(chatId, input, extra);
        return message.document.file_id;
      }
      case 'text':
        throw new Error('Text assets must use sendMessage');
    }
  }

  private async writeCache(asset: DropAsset, key: string, fileId: string): Promise<void> {
    if (asset.transportCache?.[key] === fileId) return;
    try {
      await this.uow.run(async (repos) => {
        await repos.drops.cacheAssetTransport(asset.creatorId, asset.id, key, fileId);
      });
    } catch (error) {
      // Delivery already succeeded; a rebuildable optimization must not turn it into a failure.
      this.logger.warn(
        { err: error, assetId: asset.id, transportCacheKey: key },
        'telegram transport cache write failed',
      );
    }
  }
}
