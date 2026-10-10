import { type ReactNode, useContext, useEffect } from 'react';

import { BootScreen } from '@/components/boot-screen';
import { TelegramContext } from '@/providers/telegram-provider';
import { router } from '@/router';

/**
 * Holds a page back until the browser has a live Telegram session, and sends
 * the user to the sign-in screen once we know it never will.
 *
 * Reads the context directly rather than through `useTelegram()` so it can
 * still render during the first paint, before the provider settles.
 */
export function AuthGate({ children }: { children: ReactNode }) {
    const telegram = useContext(TelegramContext);
    const status = telegram?.status;

    useEffect(() => {
        if (!status) return;
        if (
            status === 'booting' ||
            status === 'connecting' ||
            status === 'ready'
        ) {
            return;
        }
        void router.navigate({ to: '/' });
    }, [status]);

    if (!telegram || status !== 'ready') {
        return <BootScreen />;
    }

    return children;
}
