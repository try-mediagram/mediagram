import {
    Bookmark,
    Folder,
    Heart,
    Minus,
    Plus,
    Tag as TagIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandShortcut,
} from '@/components/ui/command';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import {
    BUILTIN_TAGS,
    createTag,
    fetchFolders,
    fetchTags,
    normaliseTag,
} from '@/lib/media-tags';
import { normaliseTagQuery } from '@/lib/tag-filters';
import { cn } from '@/lib/utils';
import type { Tag, TagFolder } from '@/types/tags';

/** How much of what is being tagged already carries a tag. */
export type TagState = 'all' | 'some' | 'none';

/**
 * The icon a built-in tag is shown with everywhere: a heart for favorite, a
 * bookmark for bookmark. Anything else is a plain tag.
 */
export function TagGlyph({
    name,
    className,
}: {
    name: string;
    className?: string;
}) {
    if (name === 'favorite') return <Heart className={className} />;
    if (name === 'bookmark') return <Bookmark className={className} />;
    return <TagIcon className={className} />;
}

/**
 * A searchable list of every tag, grouped by folder, to put on or take off
 * whatever is being tagged — one item in the viewer, a selection in the grid.
 *
 * Typing filters; Enter or a click toggles the highlighted tag and the list
 * stays open, so tagging three things is three presses rather than three trips
 * through a popover. When what is typed is not a tag yet, the first row offers
 * to create it and put it on.
 */
export function TagPickerDialog({
    open,
    onOpenChange,
    stateOf,
    onToggle,
    subject,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Whether a tag is on what is being tagged. */
    stateOf: (tag: Tag) => TagState;
    /** Put the tag on (when it is not on all of it) or take it off. */
    onToggle: (tag: Tag, state: TagState) => Promise<void>;
    /** What is being tagged, for the screen reader title: "this photo". */
    subject: string;
}) {
    const [tags, setTags] = useState<Tag[] | null>(null);
    const [folders, setFolders] = useState<TagFolder[]>([]);
    const [query, setQuery] = useState('');
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Read fresh on every open: the vocabulary may have changed in the panel
    // or on the tags page since last time.
    useEffect(() => {
        if (!open) return;
        let live = true;
        setQuery('');
        setError(null);
        void Promise.all([fetchTags(), fetchFolders()]).then(([t, f]) => {
            if (!live) return;
            setTags(t);
            setFolders(f);
        });
        return () => {
            live = false;
        };
    }, [open]);

    const groups = useMemo(() => {
        const all = tags ?? [];
        const quick = all.filter((tag) => tag.builtin);
        const byFolder = folders.map((folder) => ({
            folder,
            tags: all.filter(
                (tag) => !tag.builtin && tag.folderId === folder.id,
            ),
        }));
        const known = new Set(folders.map((folder) => folder.id));
        const unfiled = all.filter(
            (tag) =>
                !tag.builtin &&
                (tag.folderId === null || !known.has(tag.folderId)),
        );
        return { quick, byFolder, unfiled };
    }, [folders, tags]);

    const typed = normaliseTag(query);
    const exists =
        typed !== null && (tags ?? []).some((tag) => tag.name === typed);

    const run = async (key: string, work: () => Promise<void>) => {
        setBusy(key);
        setError(null);
        try {
            await work();
        } catch (caught) {
            setError(
                caught instanceof Error ? caught.message : 'That did not work.',
            );
        } finally {
            setBusy(null);
        }
    };

    const toggle = (tag: Tag) =>
        run(String(tag.id), () => onToggle(tag, stateOf(tag)));

    const create = (name: string) =>
        run('create', async () => {
            const made = await createTag(name);
            setTags((current) =>
                current === null || current.some((tag) => tag.id === made.id)
                    ? current
                    : [...current, made],
            );
            await onToggle(made, 'none');
            setQuery('');
        });

    const row = (tag: Tag) => {
        const state = stateOf(tag);
        return (
            <CommandItem
                key={tag.id}
                value={`${tag.name} ${tag.id}`}
                keywords={[tag.name]}
                disabled={busy !== null}
                data-checked={state === 'all'}
                onSelect={() => void toggle(tag)}
            >
                {busy === String(tag.id) ? (
                    <Spinner className="size-4" />
                ) : (
                    <TagGlyph
                        name={tag.name}
                        className={cn(
                            state === 'all' &&
                                tag.name === 'favorite' &&
                                'fill-current text-rose-500',
                            state === 'all' &&
                                tag.name === 'bookmark' &&
                                'fill-current text-amber-400',
                        )}
                    />
                )}
                <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                {state === 'some' ? (
                    <Minus className="text-muted-foreground" />
                ) : null}
                {tag.name === 'favorite' ? (
                    <CommandShortcut>F</CommandShortcut>
                ) : tag.name === 'bookmark' ? (
                    <CommandShortcut>B</CommandShortcut>
                ) : null}
            </CommandItem>
        );
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                showCloseButton={false}
                className="top-1/4 translate-y-0 overflow-hidden rounded-xl! p-0 sm:max-w-md"
            >
                <DialogTitle className="sr-only">Tag {subject}</DialogTitle>
                <DialogDescription className="sr-only">
                    Search your tags. Enter puts the highlighted tag on, or
                    takes it off.
                </DialogDescription>
                <Command
                    // Every item's value ends in its id so two folders can't
                    // collide; the search matches the name through keywords.
                    filter={(value, search, keywords) => {
                        const needle = normaliseTagQuery(search);
                        if (needle === '') return 1;
                        if (value.startsWith('create:')) return 1;
                        return (keywords ?? []).some((word) =>
                            word.includes(needle),
                        )
                            ? 1
                            : 0;
                    }}
                >
                    <CommandInput
                        value={query}
                        onValueChange={setQuery}
                        placeholder="Find or create a tag…"
                        autoFocus
                    />
                    <CommandList className="max-h-[min(24rem,50dvh)]">
                        {tags === null ? (
                            <div className="text-muted-foreground py-6 text-center text-sm">
                                Loading tags…
                            </div>
                        ) : (
                            <>
                                <CommandEmpty>
                                    {typed === null && query.trim() !== ''
                                        ? 'A tag is one word: letters, numbers, - or _.'
                                        : 'No tags yet.'}
                                </CommandEmpty>

                                {typed !== null && !exists ? (
                                    <CommandGroup>
                                        <CommandItem
                                            value={`create:${typed}`}
                                            forceMount
                                            disabled={busy !== null}
                                            onSelect={() => void create(typed)}
                                        >
                                            {busy === 'create' ? (
                                                <Spinner className="size-4" />
                                            ) : (
                                                <Plus />
                                            )}
                                            <span className="truncate">
                                                Create{' '}
                                                <span className="font-medium">
                                                    {typed}
                                                </span>{' '}
                                                and add it
                                            </span>
                                        </CommandItem>
                                    </CommandGroup>
                                ) : null}

                                {groups.quick.length > 0 ? (
                                    <CommandGroup heading="Quick">
                                        {[...groups.quick]
                                            .sort(
                                                (a, b) =>
                                                    BUILTIN_TAGS.indexOf(
                                                        a.name,
                                                    ) -
                                                    BUILTIN_TAGS.indexOf(
                                                        b.name,
                                                    ),
                                            )
                                            .map(row)}
                                    </CommandGroup>
                                ) : null}

                                {groups.byFolder.map(
                                    ({ folder, tags: inside }) =>
                                        inside.length > 0 ? (
                                            <CommandGroup
                                                key={folder.id}
                                                heading={
                                                    <span className="flex items-center gap-1.5">
                                                        <Folder className="size-3" />
                                                        {folder.name}
                                                    </span>
                                                }
                                            >
                                                {inside.map(row)}
                                            </CommandGroup>
                                        ) : null,
                                )}

                                {groups.unfiled.length > 0 ? (
                                    <CommandGroup
                                        heading={
                                            folders.length > 0
                                                ? 'Unfiled'
                                                : 'Tags'
                                        }
                                    >
                                        {groups.unfiled.map(row)}
                                    </CommandGroup>
                                ) : null}
                            </>
                        )}
                    </CommandList>
                    <div className="border-border text-muted-foreground flex items-center justify-between gap-2 border-t px-3 py-2 text-xs">
                        {error ? (
                            <span
                                className="text-destructive text-pretty"
                                role="alert"
                            >
                                {error}
                            </span>
                        ) : (
                            <span>↵ add or remove · Esc close</span>
                        )}
                    </div>
                </Command>
            </DialogContent>
        </Dialog>
    );
}
