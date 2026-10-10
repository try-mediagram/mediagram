import type { SensitiveSettings, TelegramSettings } from '@/types/mediagram';

/**
 * What Laravel used to share with every page, now baked in at build time.
 *
 * The Telegram pair is public by design — MTProto's security comes from the
 * server's RSA key and the DH handshake, not from these being secret — so it
 * is fine for it to sit in the bundle, as it does in every Telegram client.
 */
export const telegramSettings: TelegramSettings = {
    apiId: import.meta.env.VITE_TELEGRAM_API_ID ?? null,
    apiHash: import.meta.env.VITE_TELEGRAM_API_HASH ?? null,
};

/**
 * Telegram's own restriction reason codes that count as adult content. A peer
 * carrying any of them is labelled 18+; see `lib/telegram/restrictions.ts`.
 */
export const sensitiveSettings: SensitiveSettings = {
    restrictionReasons: ['porno', 'porn', 'sensitive', 'adult'],
};
