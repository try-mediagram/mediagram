import { Plus, Tag as TagIcon, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Spinner } from '@/components/ui/spinner';
import {
    TagGlyph,
    TagPickerDialog,
    type TagState,
} from '@/components/tag-picker-dialog';
import {
    attachTag,
    BUILTIN_TAGS,
    createTag,
    detachTag,
    isBuiltinTag,
} from '@/lib/media-tags';
import type { MediaItem } from '@/lib/telegram/types';
import { cn } from '@/lib/utils';
import type { MediaItemTag, Tag } from '@/types/tags';

/** The key that toggles each built-in tag in the viewer. */
const BUILTIN_KEYS: Record<string, string> = { favorite: 'f', bookmark: 'b' };

/** The key that opens the tag picker in the viewer. */
const PICKER_KEY = 't';

/**
 * Puts tags on one media item, and takes them off again.
 *
 * The built-ins — favorite and bookmark — are one press each, on a button or
 * on F and B. Everything else goes through the picker, on the Tag button or T.
 *
 * What reaches the local database is the chat id, the message id and a word
 * — the media itself is never stored.
 */
export function TagBar({
    item,
    tags,
    onChange,
    pickerOpen,
    onPickerOpenChange,
}: {
    item: MediaItem;
    /** The tags already on this item. */
    tags: MediaItemTag[];
    /** Something changed; the chat's tag map needs refetching. */
    onChange: () => void;
    /** Held by the viewer, so its own keys stand down while the picker is up. */
    pickerOpen: boolean;
    onPickerOpenChange: (open: boolean) => void;
}) {
    const [busy, setBusy] = useState<string | null>(null);

    const on = new Set(tags.map((tag) => tag.id));
    const onByName = new Set(tags.map((tag) => tag.name));
    const custom = tags.filter((tag) => !isBuiltinTag(tag.name));

    const run = async (key: string, work: () => Promise<unknown>) => {
        setBusy(key);
        try {
            await work();
            onChange();
        } catch (caught) {
            toast.error(
                caught instanceof Error ? caught.message : 'That did not work.',
            );
        } finally {
            setBusy(null);
        }
    };

    /**
     * Flip a built-in on this item. `createTag` hands back the existing row,
     * and remakes it should a library ever have lost it.
     */
    const toggleBuiltin = (name: string) =>
        run(name, async () => {
            const tag = await createTag(name);
            if (onByName.has(name)) {
                await detachTag(item.chatId, item.messageId, tag.id);
            } else {
                await attachTag(item.chatId, item.messageId, tag.id);
            }
        });

    // F, B and T, unless something else has the keyboard: a field, a
    // modifier chord, the picker itself, or a press already in flight.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (pickerOpen || busy !== null) return;
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            if (isTyping(event.target)) return;

            const key = event.key.toLowerCase();
            if (key === PICKER_KEY) {
                event.preventDefault();
                onPickerOpenChange(true);
                return;
            }
            const name = BUILTIN_TAGS.find((tag) => BUILTIN_KEYS[tag] === key);
            if (name) {
                event.preventDefault();
                void toggleBuiltin(name);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    const stateOf = (tag: Tag): TagState => (on.has(tag.id) ? 'all' : 'none');

    const onToggle = async (tag: Tag, state: TagState) => {
        if (state === 'all') {
            await detachTag(item.chatId, item.messageId, tag.id);
        } else {
            await attachTag(item.chatId, item.messageId, tag.id);
        }
        onChange();
    };

    return (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-3">
            {BUILTIN_TAGS.map((name) => {
                const active = onByName.has(name);
                const label = active ? `Remove ${name}` : `Add ${name}`;
                return (
                    <Button
                        key={name}
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy !== null}
                        aria-pressed={active}
                        aria-label={label}
                        title={`${label} (${BUILTIN_KEYS[name]?.toUpperCase()})`}
                        className="text-white/70 hover:bg-white/10 hover:text-white"
                        onClick={() => void toggleBuiltin(name)}
                    >
                        {busy === name ? (
                            <Spinner />
                        ) : (
                            <TagGlyph
                                name={name}
                                className={cn(
                                    active &&
                                        name === 'favorite' &&
                                        'fill-current text-rose-500',
                                    active &&
                                        name === 'bookmark' &&
                                        'fill-current text-amber-400',
                                )}
                            />
                        )}
                    </Button>
                );
            })}

            <span className="mx-1 h-4 w-px bg-white/15" aria-hidden />

            {custom.length > 0 ? (
                <TagIcon className="size-3.5 shrink-0 text-white/40" />
            ) : null}

            {custom.map((tag) => (
                <Badge
                    key={tag.id}
                    variant="secondary"
                    className="gap-1 pr-1 pl-2"
                >
                    {tag.name}
                    <button
                        type="button"
                        aria-label={`Remove ${tag.name}`}
                        disabled={busy !== null}
                        className="grid size-4 place-items-center rounded-full transition-colors hover:bg-black/20 disabled:opacity-50"
                        onClick={() =>
                            void run(String(tag.id), () =>
                                detachTag(item.chatId, item.messageId, tag.id),
                            )
                        }
                    >
                        {busy === String(tag.id) ? (
                            <Spinner className="size-3" />
                        ) : (
                            <X className="size-3" />
                        )}
                    </button>
                </Badge>
            ))}

            <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={busy !== null}
                className="text-white/70 hover:bg-white/10 hover:text-white"
                onClick={() => onPickerOpenChange(true)}
            >
                <Plus data-icon="inline-start" />
                Tag
                <Kbd className="ml-1 hidden bg-white/10 text-white/60 sm:inline-flex">
                    T
                </Kbd>
            </Button>

            <TagPickerDialog
                open={pickerOpen}
                onOpenChange={onPickerOpenChange}
                stateOf={stateOf}
                onToggle={onToggle}
                subject={item.type === 'photo' ? 'this photo' : 'this item'}
            />
        </div>
    );
}

/** Whether a key press is going into something the reader is typing in. */
function isTyping(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return (
        target.isContentEditable ||
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT'
    );
}
