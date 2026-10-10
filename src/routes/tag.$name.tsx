import {
    useInfiniteQuery,
    useQuery,
    useQueryClient,
} from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ChevronRight, Pin, PinOff, Tags } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';

import { AccountBar } from '@/components/account-bar';
import { AuthGate } from '@/components/auth-gate';
import { Lightbox } from '@/components/lightbox';
import { folderTone, tagPreviewsKey } from '@/components/tag-folder-card';
import { TagGlyph } from '@/components/tag-picker-dialog';
import { ThumbImage } from '@/components/thumb-image';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
    fetchTag,
    fetchTaggedAcross,
    fetchTagsOn,
    setTagPinned,
} from '@/lib/media-tags';
import { loadTaggedRefs } from '@/lib/tagged-media';
import type { MediaItem } from '@/lib/telegram/types';
import { cn } from '@/lib/utils';
import type { MediaItemTag, Tag, TagChat } from '@/types/tags';

/**
 * One tag's media, from every chat it is in, most recently tagged first.
 *
 * This is where a pinned tag in the rail goes, and where a folder on the tags
 * page opens. The database answers with chat and message ids; the media is
 * fetched from Telegram here, a request per chat.
 */
export const Route = createFileRoute('/tag/$name')({
    head: ({ params }) => ({
        meta: [{ title: `#${params.name} - Mediagram` }],
    }),
    component: TagPage,
});

const GRID =
    'grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5';

function TagPage() {
    const { name } = Route.useParams();
    return (
        <AuthGate>
            <TagMedia key={name} name={name} />
        </AuthGate>
    );
}

function TagMedia({ name }: { name: string }) {
    const queryClient = useQueryClient();
    const tagQuery = useQuery({
        queryKey: ['tag', name],
        queryFn: () => fetchTag(name),
    });
    const tag = tagQuery.data ?? null;

    const pages = useInfiniteQuery({
        queryKey: ['tag-media', tag?.id],
        enabled: tag !== null,
        initialPageParam: 0,
        queryFn: async ({ pageParam }) => {
            if (!tag) return { items: [], nextCursor: null };
            const page = await fetchTaggedAcross(
                tag.id,
                pageParam || undefined,
            );
            return {
                items: await loadTaggedRefs(page.refs),
                nextCursor: page.nextCursor,
            };
        },
        getNextPageParam: (last) => last.nextCursor ?? undefined,
    });

    const items = useMemo(
        () => pages.data?.pages.flatMap((page) => page.items) ?? [],
        [pages.data],
    );

    // Every tag on what is loaded, so the tiles and the viewer can show them.
    const chips = useQuery({
        queryKey: ['tag-media-chips', tag?.id, items.map((item) => item.key)],
        enabled: items.length > 0,
        placeholderData: (previous) => previous,
        queryFn: () => tagsOnItems(items),
    });
    const tagsOf = (item: MediaItem): MediaItemTag[] =>
        chips.data?.[`${item.chatId}:${item.messageId}`] ?? [];

    const [openIndex, setOpenIndex] = useState<number | null>(null);
    const [changed, setChanged] = useState(false);
    const openItem = openIndex === null ? null : (items[openIndex] ?? null);

    const refreshVocabulary = () => {
        void queryClient.invalidateQueries({ queryKey: ['tags'] });
        void queryClient.invalidateQueries({ queryKey: ['tag', name] });
        if (tag) {
            void queryClient.invalidateQueries({
                queryKey: tagPreviewsKey(tag.id),
            });
        }
    };

    const togglePin = async () => {
        if (!tag) return;
        await setTagPinned(tag.id, !tag.pinned);
        queryClient.setQueryData<Tag | null>(['tag', name], (current) =>
            current ? { ...current, pinned: !tag.pinned } : current,
        );
        void queryClient.invalidateQueries({ queryKey: ['tags'] });
    };

    const goNext = () => {
        if (openIndex === null) return;
        if (openIndex < items.length - 1) setOpenIndex(openIndex + 1);
        else if (pages.hasNextPage && !pages.isFetchingNextPage) {
            void pages.fetchNextPage().then(() => setOpenIndex(openIndex + 1));
        }
    };

    if (tagQuery.isPending) {
        return (
            <Shell>
                <div className="grid place-items-center py-24">
                    <Spinner />
                </div>
            </Shell>
        );
    }

    if (!tag) {
        return (
            <Shell>
                <div className="grid place-items-center gap-3 py-24 text-center">
                    <p className="text-sm font-medium">
                        No tag called “{name}”
                    </p>
                    <Button
                        variant="outline"
                        size="sm"
                        render={<Link to="/tags" />}
                    >
                        See every tag
                    </Button>
                </div>
            </Shell>
        );
    }

    const tone = folderTone(tag.name);

    return (
        <Shell>
            <header className="flex flex-wrap items-center gap-3">
                <span
                    className={cn(
                        'grid size-11 shrink-0 place-items-center rounded-xl bg-gradient-to-b',
                        tone.front,
                    )}
                >
                    <TagGlyph
                        name={tag.name}
                        className={cn('size-5 fill-current', tone.glyph)}
                    />
                </span>
                <div className="min-w-0 flex-1">
                    <h1 className="truncate text-xl font-semibold">
                        {tag.name}
                    </h1>
                    <p className="text-muted-foreground text-sm tabular-nums">
                        {tag.count.toLocaleString()} item
                        {tag.count === 1 ? '' : 's'}
                        {tag.chats.length > 0
                            ? ` in ${(tag.chats.length + tag.moreChats).toLocaleString()} chat${
                                  tag.chats.length + tag.moreChats === 1
                                      ? ''
                                      : 's'
                              }`
                            : ''}
                    </p>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    aria-pressed={tag.pinned}
                    onClick={() => void togglePin()}
                >
                    {tag.pinned ? (
                        <PinOff data-icon="inline-start" />
                    ) : (
                        <Pin data-icon="inline-start" />
                    )}
                    {tag.pinned ? 'Unpin' : 'Pin to sidebar'}
                </Button>
                <Button variant="ghost" size="sm" render={<Link to="/tags" />}>
                    <Tags data-icon="inline-start" />
                    All tags
                </Button>
            </header>

            {tag.chats.length > 0 ? (
                <ul className="mt-4 flex flex-wrap gap-1.5">
                    {tag.chats.map((chat) => (
                        <ChatChip
                            key={chat.chatId}
                            chat={chat}
                            tag={tag.name}
                        />
                    ))}
                    {tag.moreChats > 0 ? (
                        <li className="text-muted-foreground self-center px-1 text-xs">
                            and {tag.moreChats} more
                        </li>
                    ) : null}
                </ul>
            ) : null}

            <div className="mt-6">
                {tag.count === 0 ? (
                    <div className="grid place-items-center gap-2 py-20 text-center">
                        <TagGlyph
                            name={tag.name}
                            className="text-muted-foreground/60 size-6"
                        />
                        <p className="text-sm font-medium">Nothing here yet</p>
                        <p className="text-muted-foreground max-w-xs text-sm text-pretty">
                            {tag.name === 'favorite'
                                ? 'Press F in the viewer to favorite what you are looking at.'
                                : tag.name === 'bookmark'
                                  ? 'Press B in the viewer to bookmark what you are looking at.'
                                  : 'Press T in the viewer to put this tag on media.'}
                        </p>
                    </div>
                ) : pages.isPending ? (
                    <div className={GRID}>
                        {Array.from(
                            { length: Math.min(tag.count, 10) },
                            (_, i) => (
                                <div
                                    // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
                                    key={i}
                                    className="bg-muted aspect-square animate-pulse rounded-lg"
                                />
                            ),
                        )}
                    </div>
                ) : items.length === 0 ? (
                    <p className="text-muted-foreground py-20 text-center text-sm text-pretty">
                        The tagged media could not be loaded. It may have been
                        deleted, or be in a chat you have left.
                    </p>
                ) : (
                    <>
                        <div className={GRID}>
                            {items.map((item, index) => (
                                <ThumbImage
                                    key={item.key}
                                    item={item}
                                    tags={tagsOf(item)}
                                    onOpen={() => setOpenIndex(index)}
                                />
                            ))}
                        </div>
                        {pages.hasNextPage ? (
                            <div className="mt-6 grid place-items-center">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={pages.isFetchingNextPage}
                                    onClick={() => void pages.fetchNextPage()}
                                >
                                    {pages.isFetchingNextPage ? (
                                        <Spinner />
                                    ) : null}
                                    Load more
                                </Button>
                            </div>
                        ) : null}
                    </>
                )}
            </div>

            {openItem && openIndex !== null ? (
                <Lightbox
                    item={openItem}
                    tags={tagsOf(openItem)}
                    onTagsChange={() => {
                        setChanged(true);
                        void chips.refetch();
                        refreshVocabulary();
                    }}
                    index={openIndex}
                    total={items.length}
                    hasMore={pages.hasNextPage}
                    loadingMore={pages.isFetchingNextPage}
                    onClose={() => {
                        setOpenIndex(null);
                        // Something may have lost this tag while open; the
                        // list is only re-read once the viewer is gone, so it
                        // never shifts under the reader.
                        if (changed) {
                            setChanged(false);
                            void pages.refetch();
                        }
                    }}
                    onPrev={() => setOpenIndex(Math.max(0, openIndex - 1))}
                    onNext={goNext}
                />
            ) : null}
        </Shell>
    );
}

function Shell({ children }: { children: ReactNode }) {
    return (
        <div className="min-h-dvh">
            <AccountBar title="Tags" back={{ label: 'Library' }} />
            <main className="mx-auto w-full max-w-6xl px-4 py-6">
                {children}
            </main>
        </div>
    );
}

/** Every tag on these items, keyed `chatId:messageId`, one read per chat. */
async function tagsOnItems(
    items: MediaItem[],
): Promise<Record<string, MediaItemTag[]>> {
    const byChat = new Map<number, number[]>();
    for (const item of items) {
        const ids = byChat.get(item.chatId) ?? [];
        ids.push(item.messageId);
        byChat.set(item.chatId, ids);
    }
    const out: Record<string, MediaItemTag[]> = {};
    await Promise.all(
        [...byChat].map(async ([chatId, ids]) => {
            const onMedia = await fetchTagsOn(chatId, ids);
            for (const [messageId, tags] of Object.entries(onMedia)) {
                out[`${chatId}:${messageId}`] = tags;
            }
        }),
    );
    return out;
}

/**
 * A chat the tag is in, linking into it already filtered by the tag. The
 * title comes off the same `['dialog', chatId]` query the grid uses.
 */
function ChatChip({ chat, tag }: { chat: TagChat; tag: string }) {
    const dialog = useQuery({
        queryKey: ['dialog', chat.chatId],
        staleTime: 5 * 60_000,
        retry: false,
        queryFn: async () => {
            const { getDialog } = await import('@/lib/telegram/dialogs');
            return getDialog(chat.chatId);
        },
    });

    return (
        <li>
            <Link
                to="/c/$chatId"
                params={{ chatId: String(chat.chatId) }}
                search={{ tags: tag }}
                className="border-border text-muted-foreground hover:text-foreground hover:bg-accent/50 inline-flex max-w-56 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors"
            >
                <span className="min-w-0 truncate">
                    {dialog.data?.title ??
                        (dialog.isPending ? 'Loading…' : `Chat ${chat.chatId}`)}
                </span>
                <span className="tabular-nums">{chat.count}</span>
                <ChevronRight className="size-3 shrink-0" />
            </Link>
        </li>
    );
}
