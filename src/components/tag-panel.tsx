import { Check, Folder, Minus, Plus, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { TagGlyph } from '@/components/tag-picker-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import {
    bulkTag,
    createTag,
    deleteTag,
    fetchFolders,
    fetchTags,
    normaliseTag,
} from '@/lib/media-tags';
import { normaliseTagQuery } from '@/lib/tag-filters';
import { cn } from '@/lib/utils';
import type { MediaItemTag, Tag, TagFolder } from '@/types/tags';

/** Past this many tags the panel offers a search box. Below it, scanning works. */
const SEARCH_FROM = 8;

/**
 * Tagging a selection, in the pane the conversation usually occupies.
 *
 * Selecting is a mode, and a mode deserves the space it needs rather than a
 * popover hung off a toolbar. Everything is on one surface here: the whole
 * vocabulary, how much of the selection each word is already on, and a field
 * to make a new one. Nothing floats, and nothing is more than one press away.
 *
 * Every press is one request. A tag on the whole selection comes off, a tag on
 * part of it goes on the rest, and both go through the bulk endpoint —
 * `.ai/rules/controllers.md` is why a screenful must never be forty round
 * trips.

 */
export function TagPanel({
    chatId,
    selected,
    tagged,
    loaded,
    onSelectAll,
    onClear,
    onDone,
    onChanged,
    className,
}: {
    chatId: number;
    /** Message ids the reader has picked. */
    selected: number[];
    /** The tags on the loaded media, keyed by message id. */
    tagged: Record<string, MediaItemTag[]>;
    /** How many items the grid is holding, for "select all". */
    loaded: number;
    onSelectAll: () => void;
    onClear: () => void;
    onDone: () => void;
    /** Tags changed; the chat's vocabulary and chips are stale. */
    onChanged: () => void;
    className?: string;
}) {
    const [tags, setTags] = useState<Tag[] | null>(null);
    const [folders, setFolders] = useState<TagFolder[]>([]);
    const [query, setQuery] = useState('');
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState<number | null>(null);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirming, setConfirming] = useState<Tag | null>(null);

    // Loaded once when the panel appears rather than with the grid: most
    // browsing never tags anything, and the vocabulary is the same in every
    // chat. Same reasoning the pickers it replaces used.
    useEffect(() => {
        let live = true;
        void Promise.all([fetchTags(), fetchFolders()]).then(
            ([loadedTags, loadedFolders]) => {
                if (!live) return;
                setTags(loadedTags);
                setFolders(loadedFolders);
            },
        );
        return () => {
            live = false;
        };
    }, []);

    const count = selected.length;

    /** How much of the selection each tag is on. */
    const onSelection = useMemo(() => {
        const counts = new Map<number, number>();

        for (const messageId of selected) {
            for (const tag of tagged[String(messageId)] ?? []) {
                counts.set(tag.id, (counts.get(tag.id) ?? 0) + 1);
            }
        }

        return counts;
    }, [selected, tagged]);

    const shown = useMemo(() => {
        const needle = normaliseTagQuery(query);
        if (needle === '') return tags ?? [];
        return (tags ?? []).filter((tag) =>
            tag.name.toLowerCase().includes(needle),
        );
    }, [query, tags]);

    /** Built-ins, then each folder, then the unfiled rest; empty groups hide. */
    const sections = useMemo(() => {
        const known = new Set(folders.map((folder) => folder.id));
        const groups: { key: string; title: string | null; tags: Tag[] }[] = [
            {
                key: 'quick',
                title: null,
                tags: shown.filter((tag) => tag.builtin),
            },
            ...folders.map((folder) => ({
                key: `folder:${folder.id}`,
                title: folder.name,
                tags: shown.filter(
                    (tag) => !tag.builtin && tag.folderId === folder.id,
                ),
            })),
            {
                key: 'unfiled',
                title: folders.length > 0 ? 'Unfiled' : null,
                tags: shown.filter(
                    (tag) =>
                        !tag.builtin &&
                        (tag.folderId === null || !known.has(tag.folderId)),
                ),
            },
        ];
        return groups.filter((group) => group.tags.length > 0);
    }, [folders, shown]);

    const run = async (tagId: number, work: () => Promise<unknown>) => {
        setBusy(tagId);
        setError(null);
        try {
            await work();
            onChanged();
        } catch (caught) {
            setError(
                caught instanceof Error ? caught.message : 'That did not work.',
            );
        } finally {
            setBusy(null);
        }
    };

    /** A tag on everything selected comes off; a tag on some of it goes on the rest. */
    const toggleAttached = (tag: Tag) => {
        const on = onSelection.get(tag.id) ?? 0;
        return run(tag.id, () =>
            bulkTag(
                chatId,
                selected,
                tag.id,
                on === count ? 'detach' : 'attach',
            ),
        );
    };

    const remove = (tag: Tag) => {
        setConfirming(null);
        return run(tag.id, async () => {
            setTags(await deleteTag(tag.id));
        });
    };

    /**
     * Make a tag and put it on the selection — one gesture, because that is
     * what the reader came here to do.
     */
    const create = async () => {
        const name = normaliseTag(draft);

        if (name === null) {
            setError(
                'A tag is a single word: letters, numbers, dashes or underscores.',
            );
            return;
        }

        setCreating(true);
        setError(null);
        try {
            const made = await createTag(name);

            setTags((current) =>
                current === null || current.some((tag) => tag.id === made.id)
                    ? current
                    : [...current, made].sort((a, b) =>
                          a.name.localeCompare(b.name),
                      ),
            );

            if (count > 0) {
                await bulkTag(chatId, selected, made.id, 'attach');
                onChanged();
            }

            setDraft('');
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : 'Could not create that tag.',
            );
        } finally {
            setCreating(false);
        }
    };

    return (
        <div className={cn('flex min-h-0 flex-col', className)}>
            <div className="border-border shrink-0 border-b p-3">
                <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium tabular-nums">
                        {count.toLocaleString()} selected
                    </p>
                    <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={onDone}
                    >
                        <Check data-icon="inline-start" />
                        Done
                    </Button>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                    <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={onSelectAll}
                        disabled={count >= loaded}
                    >
                        Select all {loaded.toLocaleString()}
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={onClear}
                        disabled={count === 0}
                    >
                        Clear
                    </Button>
                </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
                <form
                    className="border-border grid gap-2 border-b p-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void create();
                    }}
                >
                    <p className="text-xs font-medium">New tag</p>

                    <Input
                        value={draft}
                        onChange={(event) => {
                            setDraft(event.target.value);
                            setError(null);
                        }}
                        placeholder="dog"
                        aria-label="New tag"
                        maxLength={32}
                        className="h-8"
                    />

                    <Button
                        type="submit"
                        size="sm"
                        disabled={creating || draft.trim() === ''}
                    >
                        {creating ? (
                            <Spinner />
                        ) : (
                            <Plus data-icon="inline-start" />
                        )}
                        {count > 0 ? 'Create and attach' : 'Create tag'}
                    </Button>

                    {error ? (
                        <p
                            className="text-destructive text-xs text-pretty"
                            role="alert"
                        >
                            {error}
                        </p>
                    ) : null}
                </form>

                {tags === null ? (
                    <p className="text-muted-foreground p-3 text-xs">
                        Loading tags…
                    </p>
                ) : tags.length === 0 ? (
                    <p className="text-muted-foreground p-3 text-xs text-pretty">
                        No tags yet. Make one above and it goes straight onto
                        what you have picked.
                    </p>
                ) : (
                    <>
                        {tags.length > SEARCH_FROM ? (
                            <div className="relative p-3 pb-1">
                                <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-6 size-3.5 -translate-y-1/2" />
                                <Input
                                    value={query}
                                    onChange={(event) =>
                                        setQuery(event.target.value)
                                    }
                                    placeholder="Find a tag"
                                    aria-label="Find a tag"
                                    className="h-8 pl-8 text-xs"
                                />
                            </div>
                        ) : null}

                        {sections.map((section) => (
                            <div key={section.key}>
                                {section.title ? (
                                    <p className="text-muted-foreground flex items-center gap-1.5 px-3 pt-3 pb-1 text-[11px] font-medium tracking-wide uppercase">
                                        <Folder className="size-3" />
                                        <span className="truncate">
                                            {section.title}
                                        </span>
                                    </p>
                                ) : null}
                                <ul className="divide-border divide-y">
                                    {section.tags.map((tag) => (
                                        <TagRow
                                            key={tag.id}
                                            tag={tag}
                                            on={onSelection.get(tag.id) ?? 0}
                                            count={count}
                                            busy={busy}
                                            onToggleAttached={() =>
                                                void toggleAttached(tag)
                                            }
                                            onDelete={() => setConfirming(tag)}
                                        />
                                    ))}
                                </ul>
                            </div>
                        ))}

                        {shown.length === 0 ? (
                            <p className="text-muted-foreground p-3 text-xs text-pretty">
                                No tag is called “{query.trim()}”.
                            </p>
                        ) : null}
                    </>
                )}
            </div>

            <DeleteDialog
                tag={confirming}
                onCancel={() => setConfirming(null)}
                onConfirm={(tag) => void remove(tag)}
            />
        </div>
    );
}

function TagRow({
    tag,
    on,
    count,
    busy,
    onToggleAttached,
    onDelete,
}: {
    tag: Tag;
    /** How much of the selection already carries it. */
    on: number;
    /** How much is selected. */
    count: number;
    busy: number | null;
    onToggleAttached: () => void;
    onDelete: () => void;
}) {
    const all = count > 0 && on === count;
    const working = busy === tag.id;

    return (
        <li className="flex items-center gap-1.5 px-3 py-1.5">
            <button
                type="button"
                // The whole row is the attach target. A tag on everything comes
                // off, a tag on part of it completes — which is what every
                // other tagger does, and the count says which will happen.
                disabled={busy !== null || count === 0}
                aria-pressed={all}
                title={
                    count === 0
                        ? 'Pick some media first'
                        : all
                          ? `Remove ${tag.name} from all ${count}`
                          : `Add ${tag.name} to the other ${count - on}`
                }
                onClick={onToggleAttached}
                className={cn(
                    'flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors',
                    'focus-visible:ring-ring outline-none focus-visible:ring-2',
                    'disabled:pointer-events-none disabled:opacity-50',
                    all ? 'bg-accent' : 'hover:bg-foreground/[0.06]',
                )}
            >
                <span className="grid size-4 shrink-0 place-items-center">
                    {working ? (
                        <Spinner className="size-3" />
                    ) : all ? (
                        <Minus className="size-3.5" />
                    ) : (
                        <Plus className="size-3.5" />
                    )}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">
                    {tag.name}
                </span>
                {on > 0 && !all ? (
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                        {on}/{count}
                    </span>
                ) : null}
                <TagGlyph
                    name={tag.name}
                    className={cn(
                        'text-muted-foreground size-3.5 shrink-0',
                        all &&
                            tag.name === 'favorite' &&
                            'fill-current text-rose-500',
                        all &&
                            tag.name === 'bookmark' &&
                            'fill-current text-amber-400',
                    )}
                />
            </button>

            {tag.builtin ? null : (
                <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground hover:text-destructive shrink-0"
                    disabled={busy !== null}
                    aria-label={`Delete ${tag.name}`}
                    onClick={onDelete}
                >
                    <Trash2 />
                </Button>
            )}
        </li>
    );
}

/**
 * Deleting the word itself, not just taking it off the selection.
 *
 * Asked about because the two sit next to each other and only one is
 * reversible: detaching is a press away from being undone, deleting takes the
 * tag off everything in every chat.
 */
function DeleteDialog({
    tag,
    onCancel,
    onConfirm,
}: {
    tag: Tag | null;
    onCancel: () => void;
    onConfirm: (tag: Tag) => void;
}) {
    return (
        <AlertDialog
            open={tag !== null}
            onOpenChange={(next) => {
                if (!next) onCancel();
            }}
        >
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>Delete {tag?.name}?</AlertDialogTitle>
                    <AlertDialogDescription>
                        {tag && tag.count > 0
                            ? `The word goes, and it comes off ${tag.count.toLocaleString()} item${
                                  tag.count === 1 ? '' : 's'
                              } in every chat — not just what you have picked. The media stays in Telegram.`
                            : 'This tag is not on anything yet.'}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>Keep it</AlertDialogCancel>
                    <AlertDialogAction
                        variant="destructive"
                        onClick={() => {
                            if (tag) onConfirm(tag);
                        }}
                    >
                        Delete tag
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
