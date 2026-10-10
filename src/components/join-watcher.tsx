import { useEffect } from 'react';
import { toast } from 'sonner';

import type { JoinAccepted } from '@/lib/telegram/join-watch';
import { router } from '@/router';

/**
 * Says so when an admin lets this account into a chat it asked to join.
 *
 * A request to join is answered by a person, later, and the screen it was made
 * from is long gone by then — so the waiting lives in `lib/telegram/join-watch`
 * and this only listens. It sits in `AppShell` beside the toaster for the same
 * reason the Telegram session does: it has to survive an Inertia visit.
 *
 * The chat is offered, never opened. Being let in is somebody else's action,
 * and it must not throw the reader out of what they were looking at.
 */
export function JoinWatcher() {
    useEffect(() => {
        let live = true;
        let unsubscribe: (() => void) | null = null;

        void import('@/lib/telegram/join-watch').then((mod) => {
            if (!live) return;
            unsubscribe = mod.subscribeJoinAccepted(announce);
        });

        return () => {
            live = false;
            unsubscribe?.();
        };
    }, []);

    return null;
}

function announce(accepted: JoinAccepted) {
    toast.success(`You are in ${accepted.title}`, {
        description: 'An admin approved your request to join.',
        duration: 15_000,
        action: {
            label: 'Open',
            onClick: () =>
                void router.navigate({
                    to: '/c/$chatId',
                    params: { chatId: String(accepted.chatId) },
                }),
        },
    });
}
