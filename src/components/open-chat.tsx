import { ArrowRight, AtSign, Hash, Link2, Lock } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { debug } from '@/lib/debug';
import { parseChatTarget, type ChatTarget } from '@/lib/telegram/chat-target';
import type { ResolvedChat } from '@/lib/telegram/resolve';
import { kindLabel } from '@/lib/telegram/select-visible-dialogs';
import { router } from '@/router';

/**
 * Opening a chat that is not in the library yet, from the search field.
 *
 * This is deliberately not a second input. The library already has one field
 * for finding a chat, and "find me this chat" is the same intent whether the
 * answer happens to be in your dialog list or on Telegram's side of the wire —
 * so the search box takes a t.me link, a private invite, an @handle or a bare
 * id, and this row appears under whatever matched locally.
 *
 * Under, not over: your own chats are what you are usually looking for. A
 * pasted link matches nothing locally anyway, so in that case this is the only
 * row on screen.
 *
 * A chat you are already in opens straight away. One you are not in stops at a
 * preview first: joining is a real change to somebody's account, it is visible
 * to the other members, and it must never be the accidental result of pasting.
 */
export function OpenChatRow({ query }: { query: string }) {
    const target = useMemo(() => parseChatTarget(query), [query]);

    const [busy, setBusy] = useState(false);
    const [preview, setPreview] = useState<Preview | null>(null);

    async function open(found: ChatTarget) {
        if (busy) return;
        setBusy(true);

        try {
            const { resolveChatTarget } = await import(
                '@/lib/telegram/resolve'
            );
            const resolved = await resolveChatTarget(found);
            debug('join', 'resolved', resolved);

            // Already in it, and Telegram named it: there is nothing to ask.
            if (resolved.joined && resolved.chatId !== null) {
                void router.navigate({
                    to: '/c/$chatId',
                    params: { chatId: String(resolved.chatId) },
                });
                return;
            }

            setPreview({ resolved, joining: false });
        } catch (caught) {
            const { describeTelegramError } = await import(
                '@/lib/telegram/errors'
            );
            debug('join', 'resolve failed', caught);
            toast.error(describeTelegramError(caught));
        } finally {
            setBusy(false);
        }
    }

    async function join() {
        if (!preview || preview.joining) return;
        setPreview({ ...preview, joining: true });

        try {
            const { joinChatTarget } = await import('@/lib/telegram/resolve');
            const result = await joinChatTarget(preview.resolved.target);

            if (result.status === 'request_sent') {
                // Nobody is coming back to this dialog for the answer, so the
                // wait outlives it — see lib/telegram/join-watch.
                const { watchForJoin } = await import(
                    '@/lib/telegram/join-watch'
                );
                watchForJoin(preview.resolved.target, preview.resolved.title);

                toast.success('Request sent', {
                    description: `An admin of ${preview.resolved.title} has to let you in. We will say so when they do.`,
                });
                setPreview(null);
                return;
            }

            setPreview(null);
            void router.navigate({
                to: '/c/$chatId',
                params: { chatId: String(result.chatId) },
            });
        } catch (caught) {
            const { describeTelegramError } = await import(
                '@/lib/telegram/errors'
            );
            debug('join', 'join failed', caught);
            toast.error(describeTelegramError(caught));
            setPreview({ ...preview, joining: false });
        }
    }

    if (!target) return null;

    const { icon: Icon, title, detail } = describeTarget(target);
    const resolved = preview?.resolved;

    return (
        <>
            <button
                type="button"
                disabled={busy}
                onClick={() => void open(target)}
                className="hover:bg-muted/60 focus-visible:ring-ring group flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none focus-visible:ring-2 disabled:opacity-60"
            >
                <span className="border-brand-border bg-brand-subtle text-brand-text grid size-10 shrink-0 place-items-center rounded-lg border">
                    {busy ? (
                        <Spinner className="size-4" />
                    ) : (
                        <Icon className="size-4" aria-hidden />
                    )}
                </span>

                <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                        {title}
                    </span>
                    <span className="text-muted-foreground block truncate text-xs">
                        {detail}
                    </span>
                </span>

                <ArrowRight
                    className="text-muted-foreground group-hover:text-foreground size-4 shrink-0 transition-colors"
                    aria-hidden
                />
            </button>

            <Dialog
                open={preview !== null}
                onOpenChange={(next) => {
                    if (!next && !preview?.joining) setPreview(null);
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{resolved?.title}</DialogTitle>
                        <DialogDescription>
                            {resolved ? describeResolved(resolved) : null}
                        </DialogDescription>
                    </DialogHeader>

                    {resolved?.needsApproval ? (
                        <p className="text-muted-foreground text-sm text-pretty">
                            This chat approves members by hand, so joining sends
                            a request rather than letting you straight in.
                        </p>
                    ) : null}

                    <DialogFooter>
                        <DialogClose
                            render={
                                <Button
                                    variant="ghost"
                                    disabled={preview?.joining}
                                />
                            }
                        >
                            Cancel
                        </DialogClose>

                        {/*
                            A public chat Telegram has already named reads
                            without joining, so offer that too — the quieter
                            option, since it changes nothing about the account.
                        */}
                        {resolved != null && resolved.chatId !== null ? (
                            <Button
                                variant="outline"
                                disabled={preview?.joining}
                                onClick={() => {
                                    const id = resolved.chatId;
                                    setPreview(null);
                                    if (id !== null) {
                                        void router.navigate({
                                            to: '/c/$chatId',
                                            params: { chatId: String(id) },
                                        });
                                    }
                                }}
                            >
                                Just look
                            </Button>
                        ) : null}

                        <Button
                            disabled={preview?.joining}
                            onClick={() => void join()}
                        >
                            {preview?.joining ? (
                                <Spinner className="size-4" />
                            ) : null}
                            {resolved?.needsApproval
                                ? 'Request to join'
                                : 'Join and open'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

type Preview = { resolved: ResolvedChat; joining: boolean };

/** What the row can say before Telegram has been asked anything. */
function describeTarget(target: ChatTarget): {
    icon: typeof Link2;
    title: string;
    detail: string;
} {
    if (target.kind === 'invite') {
        return {
            icon: Lock,
            title: 'Open this private invite',
            // The hash is the whole address and it is long, so show just enough
            // to recognise the one that was pasted.
            detail: `t.me/+${target.hash.slice(0, 10)}… · not in your library`,
        };
    }

    if (target.kind === 'username') {
        return {
            icon: AtSign,
            title: `Open @${target.username}`,
            detail: 'Look this handle up on Telegram',
        };
    }

    return {
        icon: Hash,
        title: `Open chat ${target.chatId}`,
        detail: 'Look this id up on Telegram',
    };
}

/** "Channel · 12,480 members · You are not in this one". */
function describeResolved(resolved: ResolvedChat): string {
    const parts = [kindLabel(resolved.kind)];

    if (resolved.memberCount !== null) {
        parts.push(
            `${resolved.memberCount.toLocaleString()} ${
                resolved.memberCount === 1 ? 'member' : 'members'
            }`,
        );
    }

    parts.push(
        resolved.joined ? 'You are a member' : 'You are not in this one',
    );

    return parts.join(' · ');
}
