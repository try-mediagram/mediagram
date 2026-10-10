import { useInfiniteQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import type { ReactNode } from 'react';

import { snippet } from '@/components/chat-composer';
import { SenderAvatar } from '@/components/sender-avatar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatMediaDateTime, formatRelativeDateTime } from '@/lib/format';
import type { ThreadMessage } from '@/lib/telegram/types';

/**
 * What the search box found in this chat, in the centre of the screen.
 *
 * Telegram does the searching, over every message and not only the loaded
 * ones. Matches read newest first, with the needle marked, and picking one
 * takes the conversation to it.
 */
export function ChatSearchResults({
    chatId,
    query,
    enabled,
    onPick,
}: {
    chatId: number;
    query: string;
    enabled: boolean;
    onPick: (message: ThreadMessage) => void;
}) {
    const results = useInfiniteQuery({
        queryKey: ['chat-search', chatId, query],
        enabled: enabled && query.length > 0,
        initialPageParam: undefined as number | undefined,
        queryFn: async ({ pageParam }) => {
            const { searchChatMessages } = await import(
                '@/lib/telegram/thread'
            );
            return searchChatMessages(chatId, query, pageParam);
        },
        getNextPageParam: (lastPage) => lastPage.next,
    });

    const messages = results.data?.pages.flatMap((page) => page.messages) ?? [];
    const total = results.data?.pages[0]?.total ?? 0;

    return (
        <section
            aria-label="Search results"
            className="min-h-0 flex-1 overflow-y-auto px-4 py-6"
        >
            <div className="mx-auto w-full max-w-2xl">
                <p className="text-muted-foreground mb-3 flex items-center justify-center gap-1.5 text-center text-xs">
                    <Search className="size-3.5" />
                    {results.isPending
                        ? `Searching for “${query}”…`
                        : `${total.toLocaleString()} ${total === 1 ? 'message matches' : 'messages match'} “${query}”`}
                </p>

                {results.isPending ? (
                    <div className="flex flex-col gap-2">
                        {['a', 'b', 'c'].map((id) => (
                            <Skeleton key={id} className="h-16 rounded-xl" />
                        ))}
                    </div>
                ) : results.error ? (
                    <p className="text-destructive text-center text-sm">
                        {results.error instanceof Error
                            ? results.error.message
                            : 'Search failed.'}
                    </p>
                ) : messages.length === 0 ? (
                    <p className="text-muted-foreground py-12 text-center text-sm">
                        Nothing in this chat matches “{query}”.
                    </p>
                ) : (
                    <ol className="flex flex-col gap-2">
                        {messages.map((message) => (
                            <li key={message.id}>
                                <button
                                    type="button"
                                    onClick={() => onPick(message)}
                                    className="border-border bg-card hover:bg-accent focus-visible:ring-ring/50 flex w-full gap-3 rounded-xl border p-3 text-left transition-colors outline-none focus-visible:ring-3"
                                >
                                    <SenderAvatar message={message} size={32} />
                                    <span className="min-w-0 flex-1">
                                        <span className="flex items-baseline justify-between gap-2">
                                            <span className="truncate text-sm font-medium">
                                                {message.senderName ||
                                                    'Unknown'}
                                            </span>
                                            <span
                                                className="text-muted-foreground shrink-0 text-xs"
                                                title={formatMediaDateTime(
                                                    message.date,
                                                )}
                                            >
                                                {formatRelativeDateTime(
                                                    message.date,
                                                )}
                                            </span>
                                        </span>
                                        <span className="text-muted-foreground mt-0.5 line-clamp-3 text-sm break-words">
                                            {highlight(snippet(message), query)}
                                        </span>
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ol>
                )}

                {results.hasNextPage ? (
                    <div className="flex justify-center py-6">
                        <Button
                            variant="outline"
                            disabled={results.isFetchingNextPage}
                            onClick={() => void results.fetchNextPage()}
                        >
                            {results.isFetchingNextPage
                                ? 'Loading…'
                                : 'More results'}
                        </Button>
                    </div>
                ) : null}
            </div>
        </section>
    );
}

/** The text with every case-insensitive match of the needle marked. */
function highlight(text: string, needle: string): ReactNode {
    const term = needle.trim();
    if (!term) return text;
    const lower = text.toLowerCase();
    const find = term.toLowerCase();
    const out: ReactNode[] = [];
    let at = 0;
    while (at < text.length) {
        const hit = lower.indexOf(find, at);
        if (hit === -1) {
            out.push(text.slice(at));
            break;
        }
        if (hit > at) out.push(text.slice(at, hit));
        out.push(
            <mark
                key={hit}
                className="bg-primary/25 text-foreground rounded-sm px-0.5"
            >
                {text.slice(hit, hit + term.length)}
            </mark>,
        );
        at = hit + term.length;
    }
    return out;
}
