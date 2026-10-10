/**
 * Telegram API credentials, built in (see `lib/config.ts`) so users never see
 * the api_id form. Public in the bundle by design, as in every Telegram client.
 */
export type TelegramSettings = {
    apiId: string | null;
    apiHash: string | null;
};

/**
 * Which of Telegram's restriction reasons count as adult content. The window
 * matches them against the peer, because only the window ever sees one.
 */
export type SensitiveSettings = {
    restrictionReasons: string[];
};

/** chat id => highest message id already seen. */
export type SourceMap = Record<string, number>;
