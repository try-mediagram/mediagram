import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Film, Image, Music, Pin } from 'lucide-react';
import type { ReactNode } from 'react';

import { TagGlyph } from '@/components/tag-picker-dialog';
import { fetchTagPreviews, PREVIEW_COUNT } from '@/lib/media-tags';
import { loadTaggedRefs } from '@/lib/tagged-media';
import type { MediaItem } from '@/lib/telegram/types';
import { cn } from '@/lib/utils';
import type { Tag } from '@/types/tags';

/**
 * A folder's two colours: the back and the front panel. Spelled out in full
 * so Tailwind sees every class.
 */
type FolderTone = { back: string; front: string; glyph: string };

const TONES: FolderTone[] = [
    {
        back: 'bg-lime-500',
        front: 'from-lime-300 to-lime-400',
        glyph: 'text-lime-700/70',
    },
    {
        back: 'bg-sky-500',
        front: 'from-sky-300 to-sky-400',
        glyph: 'text-sky-800/60',
    },
    {
        back: 'bg-violet-500',
        front: 'from-violet-300 to-violet-400',
        glyph: 'text-violet-800/60',
    },
    {
        back: 'bg-emerald-500',
        front: 'from-emerald-300 to-emerald-400',
        glyph: 'text-emerald-800/60',
    },
    {
        back: 'bg-orange-500',
        front: 'from-orange-300 to-orange-400',
        glyph: 'text-orange-800/60',
    },
    {
        back: 'bg-teal-500',
        front: 'from-teal-300 to-teal-400',
        glyph: 'text-teal-800/60',
    },
];

const FAVORITE_TONE: FolderTone = {
    back: 'bg-rose-500',
    front: 'from-rose-300 to-rose-400',
    glyph: 'text-rose-700/70',
};

const BOOKMARK_TONE: FolderTone = {
    back: 'bg-amber-500',
    front: 'from-amber-200 to-amber-300',
    glyph: 'text-amber-700/70',
};

/** Same tag, same colour, every time: picked off the name, not stored. */
export function folderTone(name: string): FolderTone {
    if (name === 'favorite') return FAVORITE_TONE;
    if (name === 'bookmark') return BOOKMARK_TONE;
    let hash = 0;
    for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
    return TONES[Math.abs(hash) % TONES.length] ?? TONES[0];
}

/** The query key a tag's folder previews are cached under. */
export function tagPreviewsKey(tagId: number) {
    return ['tag-previews', tagId] as const;
}

/**
 * The thumbnails a tag's last few items show, as object URLs. Keyed on the
 * count too, so tagging something new changes what peeks out.
 */
function useTagPreviews(tag: Tag) {
    return useQuery({
        queryKey: [...tagPreviewsKey(tag.id), tag.count],
        enabled: tag.count > 0,
        staleTime: 5 * 60_000,
        queryFn: async () => {
            const refs = await fetchTagPreviews(tag.id, PREVIEW_COUNT);
            const items = await loadTaggedRefs(refs);
            const { downloadThumb, inlinePreview } = await import(
                '@/lib/telegram/media'
            );
            return Promise.all(
                items.map(async (item) => ({
                    item,
                    src: (await downloadThumb(item)) ?? inlinePreview(item),
                })),
            );
        },
    });
}

/** Fanned out behind the front panel: left, right, then the middle on top. */
const FAN = [
    'left-[14%] -rotate-[8deg] group-hover/folder:-translate-y-3 group-hover/folder:-rotate-[12deg]',
    'right-[14%] rotate-[7deg] group-hover/folder:-translate-y-3 group-hover/folder:rotate-[11deg]',
    'left-1/2 -translate-x-1/2 group-hover/folder:-translate-y-5',
];

/**
 * A tag drawn as a folder, its last few items peeking out of the top.
 *
 * The whole card opens the tag's page. `actions` sit in the corner over it,
 * for the tags page's pin and menu.
 */
export function TagFolderCard({
    tag,
    actions,
    className,
}: {
    tag: Tag;
    actions?: ReactNode;
    className?: string;
}) {
    const tone = folderTone(tag.name);
    const previews = useTagPreviews(tag);
    const sheets = previews.data ?? [];

    return (
        <div className={cn('group/folder relative', className)}>
            <Link
                to="/tag/$name"
                params={{ name: tag.name }}
                className="focus-visible:ring-ring/60 block rounded-2xl outline-none focus-visible:ring-2"
            >
                <div className="relative mx-auto aspect-[5/4] w-full">
                    {/* The back of the folder, with its tab. */}
                    <div
                        className={cn(
                            'absolute inset-x-[6%] top-[12%] bottom-[8%] rounded-2xl shadow-sm',
                            tone.back,
                        )}
                    />
                    <div
                        className={cn(
                            'absolute top-[7%] left-[6%] h-[12%] w-[34%] rounded-t-xl',
                            tone.back,
                        )}
                    />

                    {/* What is inside, sticking up out of it. */}
                    {sheets.length > 0
                        ? sheets.map(({ item, src }, index) => (
                              <Sheet
                                  key={item.key}
                                  item={item}
                                  src={src}
                                  className={
                                      sheets.length === 1
                                          ? FAN[2]
                                          : FAN[index % FAN.length]
                                  }
                              />
                          ))
                        : tag.count > 0 && previews.isPending
                          ? FAN.map((fan) => (
                                <div
                                    key={fan}
                                    className={cn(
                                        'bg-muted absolute top-[10%] aspect-[4/5] w-[34%] animate-pulse rounded-lg shadow-md transition-transform duration-300',
                                        fan,
                                    )}
                                />
                            ))
                          : null}

                    {/* The front panel. */}
                    <div
                        className={cn(
                            'absolute inset-x-[2%] top-[34%] bottom-0 grid place-items-center overflow-hidden rounded-2xl bg-gradient-to-b shadow-[0_-1px_0_rgba(255,255,255,0.45)_inset,0_8px_20px_-8px_rgba(0,0,0,0.35)] transition-transform duration-300 group-hover/folder:translate-y-0.5',
                            tone.front,
                        )}
                    >
                        <TagGlyph
                            name={tag.name}
                            className={cn(
                                'size-[22%] fill-current stroke-[1.5]',
                                tone.glyph,
                            )}
                        />
                        <span className="absolute inset-x-0 bottom-[14%] h-px bg-white/35" />
                        <span className="absolute inset-x-0 bottom-[10%] h-px bg-white/25" />
                    </div>
                </div>

                <div className="mt-2 flex items-baseline gap-1.5 px-1">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {tag.name}
                    </span>
                    {tag.pinned ? (
                        <Pin className="text-muted-foreground size-3 shrink-0" />
                    ) : null}
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                        {tag.count.toLocaleString()}
                    </span>
                </div>
            </Link>

            {actions ? (
                <div className="absolute top-[36%] right-[4%] flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/folder:opacity-100 group-hover/folder:opacity-100 [@media(hover:none)]:opacity-100">
                    {actions}
                </div>
            ) : null}
        </div>
    );
}

/** One item peeking out: its thumbnail, or a plain sheet with its kind. */
function Sheet({
    item,
    src,
    className,
}: {
    item: MediaItem;
    src: string | null;
    className: string;
}) {
    const Icon =
        item.type === 'photo'
            ? Image
            : item.type === 'audio' || item.type === 'voice'
              ? Music
              : Film;
    return (
        <div
            className={cn(
                'bg-card absolute top-[10%] aspect-[4/5] w-[34%] overflow-hidden rounded-lg border border-white/70 shadow-md transition-transform duration-300 ease-out',
                className,
            )}
        >
            {src ? (
                <img
                    src={src}
                    alt=""
                    draggable={false}
                    className="size-full object-cover"
                />
            ) : (
                <div className="text-muted-foreground grid size-full place-items-center">
                    <Icon className="size-5" />
                </div>
            )}
        </div>
    );
}
