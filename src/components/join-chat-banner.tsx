import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { debug } from '@/lib/debug';

/**
 * "You are reading this one from the outside."
 *
 * A public channel opens and reads without joining, which is exactly why this
 * has to be said: the media is all here, nothing is broken, and there is no
 * other sign that the chat is not in the library and will not be there
 * tomorrow. Joining is what puts it in the list.
 *
 * It is a line, not a wall: nothing behind it is gated.
 */
export function JoinChatBanner({
    chatId,
    title,
    onJoined,
}: {
    chatId: number;
    title: string;
    onJoined: () => void;
}) {
    const [joining, setJoining] = useState(false);

    async function join() {
        setJoining(true);

        try {
            const { joinChatTarget } = await import('@/lib/telegram/resolve');
            const result = await joinChatTarget({ kind: 'id', chatId });

            if (result.status === 'request_sent') {
                const { watchForJoin } = await import(
                    '@/lib/telegram/join-watch'
                );
                watchForJoin({ kind: 'id', chatId }, title);

                toast.success('Request sent', {
                    description: `An admin of ${title} has to let you in. We will say so when they do.`,
                });
            } else {
                toast.success(`Joined ${title}`);
            }

            onJoined();
        } catch (caught) {
            const { describeTelegramError } = await import(
                '@/lib/telegram/errors'
            );
            debug('join', 'join from chat failed', caught);
            toast.error(describeTelegramError(caught));
        } finally {
            setJoining(false);
        }
    }

    return (
        <div className="border-brand-border bg-brand-subtle mx-4 mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-3 py-2.5">
            <p className="text-brand-subtle-foreground min-w-0 flex-1 text-sm text-pretty">
                You are not in {title}. Join to keep it in your library.
            </p>
            <Button size="sm" disabled={joining} onClick={() => void join()}>
                {joining ? (
                    <Spinner className="size-3.5" />
                ) : (
                    <UserPlus aria-hidden />
                )}
                Join
            </Button>
        </div>
    );
}
