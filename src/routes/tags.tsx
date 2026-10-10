import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import {
    Check,
    Folder,
    FolderInput,
    FolderPlus,
    MoreHorizontal,
    Pencil,
    Pin,
    PinOff,
    Search,
    Tag as TagIcon,
    Trash2,
    X,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';

import { AccountBar } from '@/components/account-bar';
import { AuthGate } from '@/components/auth-gate';
import { TagFolderCard } from '@/components/tag-folder-card';
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
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Segmented, type SegmentedOption } from '@/components/ui/segmented';
import { Spinner } from '@/components/ui/spinner';
import {
    createFolder,
    createTag,
    deleteFolder,
    deleteTag,
    FOLDER_MAX_LENGTH,
    fetchFolders,
    fetchTags,
    moveTag,
    normaliseTag,
    renameFolder,
    setTagPinned,
} from '@/lib/media-tags';
import {
    DEFAULT_TAG_FILTER,
    filterTags,
    type TagSort,
} from '@/lib/tag-filters';
import type { Tag, TagFolder } from '@/types/tags';

const SORTS: SegmentedOption<TagSort>[] = [
    { value: 'name', label: 'A–Z', title: 'Alphabetical' },
    { value: 'used', label: 'Most used', title: 'Busiest first' },
];

/**
 * Where the tag vocabulary is managed.
 *
 * Tagging itself happens in the viewer and in the grid, on media. This is the
 * list behind it: what exists and how much each is on.
 *
 * Searching and filtering happen here in the browser rather than through a
 * query string. `fetchTags()` already answers with the whole vocabulary in one
 * grouped query, so a search query would be a second read for rows the page
 * is already holding. The logic itself lives in `lib/tag-filters.ts`, which is pure and
 * unit-tested.
 */
export const Route = createFileRoute('/tags')({
    head: () => ({ meta: [{ title: 'Your tags - Mediagram' }] }),
    component: Tags,
});

const TAGS_KEY = ['tags'] as const;
const FOLDERS_KEY = ['tag-folders'] as const;
const NO_TAGS: Tag[] = [];
const NO_FOLDERS: TagFolder[] = [];

function Tags() {
    return (
        <AuthGate>
            <TagManager />
        </AuthGate>
    );
}

function TagManager() {
    const queryClient = useQueryClient();
    const vocabulary = useQuery({ queryKey: TAGS_KEY, queryFn: fetchTags });
    const tags = vocabulary.data ?? NO_TAGS;
    const folderQuery = useQuery({
        queryKey: FOLDERS_KEY,
        queryFn: fetchFolders,
    });
    const folders = folderQuery.data ?? NO_FOLDERS;
    // The same cache the chat list and tag pickers read, so a change made
    // here is already there when they next render.
    const setTags = (next: Tag[] | ((current: Tag[]) => Tag[])) =>
        queryClient.setQueryData<Tag[]>(TAGS_KEY, (current = NO_TAGS) =>
            typeof next === 'function' ? next(current) : next,
        );
    const [draft, setDraft] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [busy, setBusy] = useState<number | null>(null);
    const [confirming, setConfirming] = useState<Tag | null>(null);
    const [dropping, setDropping] = useState<TagFolder | null>(null);

    const [query, setQuery] = useState(DEFAULT_TAG_FILTER.query);
    const [sort, setSort] = useState<TagSort>(DEFAULT_TAG_FILTER.sort);

    const shown = useMemo(
        () => filterTags(tags, { query, sort }),
        [query, sort, tags],
    );

    /**
     * The built-ins first, then each folder, then whatever is unfiled — each
     * in the order the sort asks for. A search hides the groups it empties.
     */
    const sections = useMemo(() => {
        const known = new Set(folders.map((folder) => folder.id));
        const quick = shown.filter((tag) => tag.builtin);
        const byFolder = folders.map((folder) => ({
            folder,
            tags: shown.filter(
                (tag) => !tag.builtin && tag.folderId === folder.id,
            ),
        }));
        const unfiled = shown.filter(
            (tag) =>
                !tag.builtin &&
                (tag.folderId === null || !known.has(tag.folderId)),
        );
        return { quick, byFolder, unfiled };
    }, [folders, shown]);

    const searching = query.trim() !== '';

    const refreshFolders = () =>
        queryClient.invalidateQueries({ queryKey: FOLDERS_KEY });

    const move = async (tag: Tag, folderId: number | null) => {
        setBusy(tag.id);
        try {
            await moveTag(tag.id, folderId);
            setTags((current) =>
                current.map((each) =>
                    each.id === tag.id ? { ...each, folderId } : each,
                ),
            );
        } finally {
            setBusy(null);
        }
    };

    const dropFolder = async (folder: TagFolder) => {
        setDropping(null);
        await deleteFolder(folder.id);
        setTags((current) =>
            current.map((each) =>
                each.folderId === folder.id
                    ? { ...each, folderId: null }
                    : each,
            ),
        );
        await refreshFolders();
    };

    const togglePin = async (tag: Tag) => {
        setBusy(tag.id);
        try {
            await setTagPinned(tag.id, !tag.pinned);
            setTags((current) =>
                current.map((each) =>
                    each.id === tag.id
                        ? { ...each, pinned: !tag.pinned }
                        : each,
                ),
            );
        } finally {
            setBusy(null);
        }
    };

    const row = (tag: Tag) => (
        <li key={tag.id}>
            <TagFolderCard
                tag={tag}
                actions={
                    <TagMenu
                        tag={tag}
                        folders={folders}
                        busy={busy}
                        onPin={() => void togglePin(tag)}
                        onMove={(folderId) => void move(tag, folderId)}
                        onDelete={() => setConfirming(tag)}
                    />
                }
            />
        </li>
    );

    /** Make a tag. */
    const create = async () => {
        const name = normaliseTag(draft);

        if (name === null) {
            setError(
                'A tag is a single word: letters, numbers, dashes or underscores.',
            );
            return;
        }

        setCreating(true);
        try {
            const result = await createTag(name);

            setDraft('');
            setError(null);

            // Creating a name that already exists returns that tag rather
            // than a duplicate, so merge on id instead of appending blindly.
            setTags((current) =>
                current.some((tag) => tag.id === result.id)
                    ? current
                    : [...current, result].sort((a, b) =>
                          a.name.localeCompare(b.name),
                      ),
            );
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

    const remove = async (tag: Tag) => {
        setBusy(tag.id);
        setConfirming(null);
        try {
            setTags(await deleteTag(tag.id));
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="min-h-dvh">
            <AccountBar title="Tags" back={{ label: 'Library' }} />

            <main className="mx-auto w-full max-w-5xl px-4 py-6">
                <p className="text-muted-foreground mb-5 text-sm text-pretty">
                    Tags are private and live on this Mac. Each one is a folder
                    of everything it is on, from every chat. Pin the ones you
                    use most and they sit in the sidebar.
                </p>

                <form
                    className="grid gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void create();
                    }}
                >
                    <div className="flex items-start gap-2">
                        <div className="flex-1">
                            <Input
                                value={draft}
                                onChange={(event) => {
                                    setDraft(event.target.value);
                                    setError(null);
                                }}
                                placeholder="dog"
                                maxLength={32}
                                aria-label="New tag"
                            />
                            {error ? (
                                <p className="text-destructive mt-1.5 text-xs text-pretty">
                                    {error}
                                </p>
                            ) : null}
                        </div>
                        <Button
                            type="submit"
                            disabled={creating || draft.trim() === ''}
                        >
                            {creating ? <Spinner /> : 'Create tag'}
                        </Button>
                    </div>
                </form>

                {vocabulary.isPending ? (
                    <div className="mt-10 grid place-items-center">
                        <Spinner />
                    </div>
                ) : tags.length === 0 ? (
                    <Nothing
                        title="No tags yet"
                        hint="Make one above, then add it to media from the viewer or straight from the grid."
                    />
                ) : (
                    <>
                        <div className="mt-6 flex flex-wrap items-center gap-2">
                            <div className="relative min-w-48 flex-1">
                                <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                                <Input
                                    value={query}
                                    onChange={(event) =>
                                        setQuery(event.target.value)
                                    }
                                    placeholder="Find a tag"
                                    aria-label="Find a tag"
                                    className="h-9 pr-9 pl-9"
                                />
                                {query !== '' ? (
                                    <button
                                        type="button"
                                        aria-label="Clear search"
                                        onClick={() => setQuery('')}
                                        className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded-md transition-colors"
                                    >
                                        <X className="size-3.5" />
                                    </button>
                                ) : null}
                            </div>

                            <Segmented
                                value={sort}
                                onChange={setSort}
                                options={SORTS}
                                className="text-xs"
                            />
                        </div>

                        {shown.length === 0 ? (
                            <Nothing
                                title="Nothing matches"
                                hint={`No tag here is called “${query.trim()}”.`}
                                onReset={() => setQuery('')}
                            />
                        ) : (
                            <div className="mt-3 grid gap-5">
                                {sections.quick.length > 0 ? (
                                    <Section title="Quick">
                                        {sections.quick.map(row)}
                                    </Section>
                                ) : null}

                                {sections.byFolder.map(
                                    ({ folder, tags: inside }) =>
                                        searching &&
                                        inside.length === 0 ? null : (
                                            <Section
                                                key={folder.id}
                                                title={folder.name}
                                                folder={folder}
                                                onRenamed={refreshFolders}
                                                onDelete={() =>
                                                    setDropping(folder)
                                                }
                                            >
                                                {inside.length > 0 ? (
                                                    inside.map(row)
                                                ) : (
                                                    <li className="text-muted-foreground border-border col-span-full rounded-lg border border-dashed px-4 py-6 text-center text-xs text-pretty">
                                                        Empty. File a tag here
                                                        from its folder menu.
                                                    </li>
                                                )}
                                            </Section>
                                        ),
                                )}

                                {sections.unfiled.length > 0 ? (
                                    <Section
                                        title={
                                            folders.length > 0
                                                ? 'Unfiled'
                                                : 'Your tags'
                                        }
                                    >
                                        {sections.unfiled.map(row)}
                                    </Section>
                                ) : null}
                            </div>
                        )}

                        <NewFolder onCreated={refreshFolders} />

                        {shown.length > 0 && shown.length !== tags.length ? (
                            <p className="text-muted-foreground mt-2 text-xs tabular-nums">
                                {shown.length} of {tags.length} shown
                            </p>
                        ) : null}
                    </>
                )}

                {tags.length > 0 ? (
                    <p className="text-muted-foreground mt-3 text-xs text-pretty">
                        Deleting a tag takes it off everything it was on.
                    </p>
                ) : null}
            </main>

            <DeleteDialog
                tag={confirming}
                onCancel={() => setConfirming(null)}
                onConfirm={(tag) => void remove(tag)}
            />

            <DeleteFolderDialog
                folder={dropping}
                onCancel={() => setDropping(null)}
                onConfirm={(folder) => void dropFolder(folder)}
            />
        </div>
    );
}

/**
 * One group of tags: the built-ins, a folder, or the unfiled rest. A folder's
 * heading renames in place and offers its delete.
 */
function Section({
    title,
    folder,
    onRenamed,
    onDelete,
    children,
}: {
    title: string;
    folder?: TagFolder;
    onRenamed?: () => void;
    onDelete?: () => void;
    children: ReactNode;
}) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(title);
    const [error, setError] = useState<string | null>(null);

    const save = async () => {
        if (!folder) return;
        try {
            await renameFolder(folder.id, draft);
            setEditing(false);
            setError(null);
            onRenamed?.();
        } catch (caught) {
            setError(
                caught instanceof Error ? caught.message : 'Could not rename.',
            );
        }
    };

    return (
        <section>
            <div className="mb-1.5 flex min-h-7 items-center gap-1.5 px-1">
                {folder ? (
                    <Folder className="text-muted-foreground size-3.5 shrink-0" />
                ) : null}
                {editing ? (
                    <form
                        className="flex flex-1 items-center gap-1"
                        onSubmit={(event) => {
                            event.preventDefault();
                            void save();
                        }}
                    >
                        <Input
                            value={draft}
                            onChange={(event) => {
                                setDraft(event.target.value);
                                setError(null);
                            }}
                            onKeyDown={(event) => {
                                if (event.key === 'Escape') {
                                    setEditing(false);
                                    setDraft(title);
                                }
                            }}
                            maxLength={FOLDER_MAX_LENGTH}
                            aria-label="Folder name"
                            autoFocus
                            className="h-7 text-xs"
                        />
                        <Button
                            type="submit"
                            variant="ghost"
                            size="icon-xs"
                            aria-label="Save name"
                        >
                            <Check />
                        </Button>
                    </form>
                ) : (
                    <h2 className="text-muted-foreground min-w-0 flex-1 truncate text-xs font-medium tracking-wide uppercase">
                        {title}
                    </h2>
                )}
                {folder && !editing ? (
                    <>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            className="text-muted-foreground"
                            aria-label={`Rename ${title}`}
                            onClick={() => {
                                setDraft(title);
                                setEditing(true);
                            }}
                        >
                            <Pencil />
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            className="text-muted-foreground hover:text-destructive"
                            aria-label={`Delete folder ${title}`}
                            onClick={onDelete}
                        >
                            <Trash2 />
                        </Button>
                    </>
                ) : null}
            </div>
            {error ? (
                <p
                    className="text-destructive mb-1.5 px-1 text-xs"
                    role="alert"
                >
                    {error}
                </p>
            ) : null}
            <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {children}
            </ul>
        </section>
    );
}

/** A field for a new folder, behind a button so the page stays quiet. */
function NewFolder({ onCreated }: { onCreated: () => void }) {
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    if (!open) {
        return (
            <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground mt-3"
                onClick={() => setOpen(true)}
            >
                <FolderPlus data-icon="inline-start" />
                New folder
            </Button>
        );
    }

    return (
        <form
            className="mt-3 grid gap-1.5"
            onSubmit={(event) => {
                event.preventDefault();
                setSaving(true);
                void createFolder(draft)
                    .then(() => {
                        setDraft('');
                        setOpen(false);
                        setError(null);
                        onCreated();
                    })
                    .catch((caught: unknown) =>
                        setError(
                            caught instanceof Error
                                ? caught.message
                                : 'Could not create that folder.',
                        ),
                    )
                    .finally(() => setSaving(false));
            }}
        >
            <div className="flex items-center gap-2">
                <Input
                    value={draft}
                    onChange={(event) => {
                        setDraft(event.target.value);
                        setError(null);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'Escape') setOpen(false);
                    }}
                    placeholder="Folder name"
                    aria-label="Folder name"
                    maxLength={FOLDER_MAX_LENGTH}
                    autoFocus
                    className="h-8"
                />
                <Button
                    type="submit"
                    size="sm"
                    disabled={saving || draft.trim() === ''}
                >
                    {saving ? <Spinner /> : 'Create folder'}
                </Button>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setOpen(false)}
                >
                    Cancel
                </Button>
            </div>
            {error ? (
                <p className="text-destructive text-xs" role="alert">
                    {error}
                </p>
            ) : null}
        </form>
    );
}

/** Deleting a folder never deletes a tag; that is what this says. */
function DeleteFolderDialog({
    folder,
    onCancel,
    onConfirm,
}: {
    folder: TagFolder | null;
    onCancel: () => void;
    onConfirm: (folder: TagFolder) => void;
}) {
    return (
        <AlertDialog
            open={folder !== null}
            onOpenChange={(next) => {
                if (!next) onCancel();
            }}
        >
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        Delete the {folder?.name} folder?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        Its tags are kept and move to Unfiled. Nothing comes off
                        any media.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>Keep it</AlertDialogCancel>
                    <AlertDialogAction
                        variant="destructive"
                        onClick={() => {
                            if (folder) onConfirm(folder);
                        }}
                    >
                        Delete folder
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}

/**
 * Everything a folder card can do besides open: pin it to the sidebar, file
 * it, delete it. The built-ins can only be pinned.
 */
function TagMenu({
    tag,
    folders,
    busy,
    onPin,
    onMove,
    onDelete,
}: {
    tag: Tag;
    folders: TagFolder[];
    /** The tag currently being written to, so the whole page locks together. */
    busy: number | null;
    onPin: () => void;
    onMove: (folderId: number | null) => void;
    onDelete: () => void;
}) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                render={
                    <Button
                        variant="ghost"
                        size="icon-xs"
                        className="bg-black/25 text-white hover:bg-black/40 hover:text-white"
                        aria-label={`${tag.name} options`}
                        disabled={busy !== null}
                    />
                }
            >
                {busy === tag.id ? <Spinner /> : <MoreHorizontal />}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={onPin}>
                    {tag.pinned ? <PinOff /> : <Pin />}
                    {tag.pinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
                </DropdownMenuItem>

                {tag.builtin ? null : (
                    <>
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                                <FolderInput />
                                Move to folder
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className="w-48">
                                <DropdownMenuRadioGroup
                                    value={String(tag.folderId ?? 'none')}
                                    onValueChange={(value) =>
                                        onMove(
                                            value === 'none'
                                                ? null
                                                : Number(value),
                                        )
                                    }
                                >
                                    <DropdownMenuRadioItem value="none">
                                        Unfiled
                                    </DropdownMenuRadioItem>
                                    {folders.map((folder) => (
                                        <DropdownMenuRadioItem
                                            key={folder.id}
                                            value={String(folder.id)}
                                        >
                                            <span className="truncate">
                                                {folder.name}
                                            </span>
                                        </DropdownMenuRadioItem>
                                    ))}
                                </DropdownMenuRadioGroup>
                                {folders.length === 0 ? (
                                    <p className="text-muted-foreground px-2 py-1.5 text-xs text-pretty">
                                        Make a folder at the bottom of the page
                                        to file tags in it.
                                    </p>
                                ) : null}
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>

                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            variant="destructive"
                            onClick={onDelete}
                        >
                            <Trash2 />
                            Delete tag
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/**
 * Deleting is asked about first, because it is not undoable and it is not
 * small: the word goes, and it comes off every piece of media it was on.
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
                            ? `It comes off ${tag.count.toLocaleString()} item${
                                  tag.count === 1 ? '' : 's'
                              }. The media itself is untouched — it stays in Telegram.`
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

function Nothing({
    title,
    hint,
    onReset,
}: {
    title: string;
    hint: string;
    onReset?: () => void;
}) {
    return (
        <div className="mt-10 grid place-items-center gap-2 px-6 text-center">
            <TagIcon className="text-muted-foreground/60 size-6" />
            <p className="text-sm font-medium">{title}</p>
            <p className="text-muted-foreground max-w-xs text-sm text-pretty">
                {hint}
            </p>
            {onReset ? (
                <Button variant="outline" size="sm" onClick={onReset}>
                    Show every tag
                </Button>
            ) : null}
        </div>
    );
}
