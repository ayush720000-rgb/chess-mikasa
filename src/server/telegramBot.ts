import { Telegraf } from 'telegraf';
import axios from 'axios';
import crypto from 'crypto';
import type express from 'express';

// Webhook path on our own server. Telegram posts updates here; the secret header
// (derived from the bot token) proves they really come from Telegram.
const WEBHOOK_PATH = '/telegram-webhook';
// The Mini App belongs to this bot. Inline results send t.me/<handle>/<short name>.
const MINIAPP_HANDLE = (process.env.MINIAPP_BOT_USERNAME || 'Ig_MikasaBot').replace(/^@/, '');
const MINIAPP_SHORT = process.env.CHESS_MINIAPP_SHORT || 'Chess';

export interface TelegramBotInfo {
  isActive: boolean;
  username?: string;
  appUrl: string;
}

function isValidBotToken(token?: string): boolean {
  if (!token) return false;
  const clean = token.trim();
  if (
    clean === '' ||
    clean.includes('MY_TELEGRAM') ||
    clean.includes('YOUR_BOT_TOKEN') ||
    clean.includes('placeholder')
  ) {
    return false;
  }
  // Standard Telegram bot token format: <bot_id>:<secret>
  return /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(clean);
}

export class TelegramBotService {
  private bot: Telegraf | null = null;
  private appUrl: string;
  // Replaced with the real handle from getMe() once the token is verified.
  private botUsername: string = (process.env.BOT_USERNAME || 'Ig_MikasaBot').replace(/^@/, '');
  // Webhook mode (Render): Telegram messages wake the instance, and it sleeps when idle.
  // Polling mode (local dev): long polling, no public URL needed.
  private webhookBot: Telegraf | null = null;
  private webhookSecret = '';
  private publicUrl: string | null = null;

  constructor(appUrl: string) {
    this.appUrl = appUrl || 'https://t.me';
    const rawToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    this.publicUrl = (process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL || '').trim() || null;

    if (isValidBotToken(rawToken)) {
      const token = rawToken!.trim();
      try {
        const botInstance = new Telegraf(token);
        this.webhookSecret = crypto.createHash('sha256').update(token).digest('hex');
        if (this.publicUrl) {
          this.webhookBot = botInstance;
        }

        // Catch background polling errors gracefully without throwing uncaught rejections
        botInstance.catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.log('[TelegramBot] Background update notice:', msg);
        });

        // Verify bot credentials before attempting to launch polling
        botInstance.telegram
          .getMe()
          .then((me) => {
            this.bot = botInstance;
            if (me.username) {
              this.botUsername = me.username;
            }
            console.log(`Telegram Bot @${this.botUsername} connected successfully.`);
            this.setupHandlers(botInstance);

            if (this.publicUrl) {
              // Handlers are ready; now tell Telegram where to send updates.
              const url = this.publicUrl.replace(/\/+$/, '') + WEBHOOK_PATH;
              botInstance.telegram
                .setWebhook(url, { secret_token: this.webhookSecret, drop_pending_updates: false })
                .then(() => console.log('Telegram Bot webhook set to ' + url))
                .catch((err: unknown) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  console.log('[TelegramBot] Could not set webhook:', msg);
                  this.bot = null;
                });
            } else {
              botInstance
                .launch({ dropPendingUpdates: true })
                .then(() => {
                  console.log('Telegram Bot polling launched successfully.');
                })
                .catch((err: unknown) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  console.log('[TelegramBot] Polling stopped:', msg);
                  this.bot = null;
                });
            }
          })
          .catch((err: unknown) => {
            // Handle 401 Unauthorized or invalid token gracefully
            this.bot = null;
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`[TelegramBot] Bot token inactive or unauthorized (${msg}). Running in Web & Telegram WebApp mode.`);
          });
      } catch (err: unknown) {
        this.bot = null;
        const msg = err instanceof Error ? err.message : String(err);
        console.log('[TelegramBot] Could not initialize Telegraf:', msg);
      }
    } else {
      console.log('[TelegramBot] No valid TELEGRAM_BOT_TOKEN provided. Operating in Web & Telegram WebApp mode.');
    }
  }

  /**
   * Mounts the Telegram webhook route. Call it before express.json(), because
   * Telegraf reads the raw request body itself. Does nothing in polling mode.
   */
  public mountWebhook(app: express.Express): void {
    if (!this.webhookBot) return;
    app.use(this.webhookBot.webhookCallback(WEBHOOK_PATH, { secretToken: this.webhookSecret }));
  }

  private setupHandlers(bot: Telegraf) {
    // Start command
    bot.command('start', async (ctx) => {
      const user = ctx.from;
      const firstName = user.first_name || 'Chess Player';
      const webAppUrl = this.appUrl;

      await ctx.reply(
        `👋 Welcome, *${firstName}*!\n\n♟️ Ready to play chess?\nCreate lobbies, challenge friends, or play against our intelligent chess bot!`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '♟️ Play ChessNow',
                  web_app: { url: webAppUrl },
                },
              ],
              [
                {
                  text: '🌐 Open Website',
                  url: webAppUrl,
                },
              ],
            ],
          },
        }
      );
    });

    // Inline mode: @bot in any chat shows the Mikasa image; tapping it sends the Mini App link.
    bot.on('inline_query', async (ctx) => {
      const miniAppLink = `https://t.me/${MINIAPP_HANDLE}/${MINIAPP_SHORT}`;
      const image = `${this.appUrl.replace(/\/+$/, '')}/assets/mikasa.jpg`;

      await ctx.answerInlineQuery([
        {
          type: 'article',
          id: 'chess_mini_app',
          title: 'Play ChessNow',
          description: 'Send the chess Mini App to this chat',
          thumbnail_url: image,
          thumbnail_width: 256,
          thumbnail_height: 256,
          input_message_content: {
            message_text: `♟️ Play chess with me on Mikasa Chess!\n${miniAppLink}`,
          },
          reply_markup: {
            inline_keyboard: [[{ text: '♟️ Play ChessNow', url: miniAppLink }]],
          },
        },
      ]);
    });
  }

  public async fetchUserAvatarBase64(userId: number): Promise<string | undefined> {
    if (!this.bot) return undefined;
    try {
      const photos = await this.bot.telegram.getUserProfilePhotos(userId, 0, 1);
      if (photos.total_count === 0 || !photos.photos[0] || photos.photos[0].length === 0) {
        return undefined;
      }

      // Pick medium resolution photo
      const photoSizes = photos.photos[0];
      const selected = photoSizes[Math.min(1, photoSizes.length - 1)];
      const fileLink = await this.bot.telegram.getFileLink(selected.file_id);

      const resp = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
      const b64 = Buffer.from(resp.data).toString('base64');
      return `data:image/jpeg;base64,${b64}`;
    } catch {
      return undefined;
    }
  }

  public stop(): void {
    if (this.bot) {
      try {
        this.bot.stop();
      } catch {
        // ignore
      }
      this.bot = null;
    }
  }

  public getInfo(): TelegramBotInfo {
    return {
      isActive: Boolean(this.bot),
      username: this.botUsername,
      appUrl: this.appUrl,
    };
  }
}
