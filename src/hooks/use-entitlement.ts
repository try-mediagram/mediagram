import { sensitiveSettings, telegramSettings } from '@/lib/config';
import type { SensitiveSettings, TelegramSettings } from '@/types/mediagram';

/** Telegram API credentials, from the build environment. */
export function useTelegramSettings(): TelegramSettings {
    return telegramSettings;
}

/**
 * The country to preselect a dialling code for. An edge header supplied this
 * when Laravel served the page; a desktop app has no edge, so it is always
 * null and the field simply starts empty.
 */
export function useVisitorCountry(): string | null {
    return null;
}

/** Which restriction reasons count as adult content. */
export function useSensitiveSettings(): SensitiveSettings {
    return sensitiveSettings;
}
