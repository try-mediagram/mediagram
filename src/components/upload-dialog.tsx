import { Check, FileUp, Plus, Send, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ChoiceRow } from '@/components/choice-row';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { formatBytes } from '@/lib/format';
import { createTag, fetchTags, normaliseTag } from '@/lib/media-tags';
import {
    ALBUM_MAX,
    CAPTION_MAX,
    type CaptionMode,
    type Delivery,
    type PickedFile,
    planUpload,
    sendKindFor,
} from '@/lib/upload/plan';
import type { Tag } from '@/types/tags';

type Picked = {
    id: string;
    file: File;
    /** Object URL for an image, so the row shows what it is. */
    preview?: string;
};

const CAPTION_MODES: { value: CaptionMode; label: string; hint: string }[] = [
    {
        value: 'none',
        label: 'No text',
        hint: 'Send the files on their own.',
    },
    {
        value: 'shared',
        label: 'One message for all',
        hint: 'The same text, once per message sent.',
    },
    {
        value: 'each',
        label: 'A message for each',
        hint: 'Write something different beside every file.',
    },
];

const DELIVERIES: { value: Delivery; label: string; hint: string }[] = [
    {
        value: 'album',
        label: 'All at once',
        hint: `Grouped as albums of up to ${ALBUM_MAX}.`,
    },
    {
        value: 'separate',
        label: 'A separate message each',
        hint: 'One message per file, in the order picked.',
    },
];

let nextId = 0;

/**
 * Pick files, say what text goes with them, and send them to the chat.
 *
 * The two questions are kept apart on purpose. What text to write and how to
 * group the files are independent — "a caption each" is as sensible spread
 * over one album as it is over twelve separate messages — so they are two
 * choices rather than one list of five muddled combinations.
 *
 * Tags are a third, independent axis. They are picked here and applied once
 * the run finishes, in bulk — the reader should not have to tag forty files
 * one at a time afterwards, and the ids to tag do not exist until Telegram has
 * assigned them.
 *
 * Files go straight from disk to Telegram. Nothing is uploaded to Mediagram,
 * and there is no endpoint that would accept it — the tagging that follows
 * sends a chat id, message ids and a tag id, exactly as tagging from the grid
 * does.
 */
export function UploadDialog({
    open,
    chatId,
    chatTitle,
    onClose,
}: {
    open: boolean;
    chatId: number;
    chatTitle: string;
    onClose: () => void;
}) {
    const [picked, setPicked] = useState<Picked[]>([]);
    const [captionMode, setCaptionMode] = useState<CaptionMode>('none');
    const [sharedCaption, setSharedCaption] = useState('');
    const [captions, setCaptions] = useState<Record<string, string>>({});
    const [delivery, setDelivery] = useState<Delivery>('album');
    const [tagIds, setTagIds] = useState<number[]>([]);
    const [dragging, setDragging] = useState(false);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fileInput = useRef<HTMLInputElement>(null);

    // Object URLs are a resource, not a value: they outlive the render that
    // made them and have to be handed back explicitly.
    //
    // Held in a ref and released only on unmount. Cleaning up from an effect
    // keyed on `picked` would revoke on every change — and since adding a file
    // produces a new array holding the *same* earlier items, that revokes the
    // URLs still on screen and blanks every thumbnail but the newest.
    const pickedRef = useRef<Picked[]>([]);

    useEffect(() => {
        pickedRef.current = picked;
    }, [picked]);

    useEffect(
        () => () => {
            for (const item of pickedRef.current) {
                if (item.preview) URL.revokeObjectURL(item.preview);
            }
        },
        [],
    );

    const add = useCallback((files: FileList | null) => {
        if (!files || files.length === 0) return;
        const added: Picked[] = [...files].map((file) => {
            nextId += 1;
            return {
                id: `u${nextId}`,
                file,
                preview: file.type.startsWith('image/')
                    ? URL.createObjectURL(file)
                    : undefined,
            };
        });
        setPicked((current) => [...current, ...added]);
    }, []);

    const remove = useCallback((id: string) => {
        setPicked((current) => {
            const going = current.find((item) => item.id === id);
            if (going?.preview) URL.revokeObjectURL(going.preview);
            return current.filter((item) => item.id !== id);
        });
        setCaptions((current) => {
            const next = { ...current };
            delete next[id];
            return next;
        });
    }, []);

    const descriptors = useMemo<PickedFile[]>(
        () =>
            picked.map((item) => ({
                id: item.id,
                name: item.file.name,
                size: item.file.size,
                type: item.file.type,
            })),
        [picked],
    );

    const plan = useMemo(
        () =>
            planUpload({
                files: descriptors,
                captionMode,
                sharedCaption,
                captions,
                delivery,
            }),
        [captionMode, captions, delivery, descriptors, sharedCaption],
    );

    const tooLarge = useMemo(
        () =>
            new Set(
                plan.issues
                    .filter((issue) => issue.kind === 'too-large')
                    .map((issue) => issue.fileId),
            ),
        [plan.issues],
    );

    const send = useCallback(async () => {
        if (plan.blocked || sending) return;
        setSending(true);
        setError(null);
        try {
            const mod = await import('@/lib/upload/send');
            mod.startUpload({
                chatId,
                chatTitle,
                plan,
                files: new Map(picked.map((item) => [item.id, item.file])),
                tagIds,
            });
            // The runner owns the send from here, so the dialog gets out of
            // the way — the toast reports the rest. The files themselves went
            // with it; the previews did not, so they are released here.
            for (const item of picked) {
                if (item.preview) URL.revokeObjectURL(item.preview);
            }
            setPicked([]);
            setCaptions({});
            setSharedCaption('');
            setTagIds([]);
            onClose();
        } catch (caught) {
            setError(
                caught instanceof Error ? caught.message : 'Could not send.',
            );
        } finally {
            setSending(false);
        }
    }, [chatId, chatTitle, onClose, picked, plan, sending, tagIds]);

    useEffect(() => {
        if (!open) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    if (!open) return null;

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-label={`Send files to ${chatTitle}`}
            className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-6 backdrop-blur-sm"
            onClick={onClose}
        >
            <div
                className="border-border bg-card flex max-h-[90dvh] w-full max-w-lg flex-col rounded-3xl border shadow-lg"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="flex items-start justify-between gap-4 p-6 pb-0">
                    <div>
                        <h2 className="font-display text-xl font-bold tracking-tight">
                            Send files
                        </h2>
                        <p className="text-muted-foreground mt-1 text-sm">
                            Straight from your device to {chatTitle}. Nothing
                            passes through our servers.
                        </p>
                    </div>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={onClose}
                        aria-label="Close"
                    >
                        <X />
                    </Button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-6">
                    <input
                        ref={fileInput}
                        type="file"
                        multiple
                        hidden
                        onChange={(event) => {
                            add(event.target.files);
                            // Let the same file be picked again after removal.
                            event.target.value = '';
                        }}
                    />

                    {picked.length === 0 ? (
                        <button
                            type="button"
                            onClick={() => fileInput.current?.click()}
                            onDragOver={(event) => {
                                event.preventDefault();
                                setDragging(true);
                            }}
                            onDragLeave={() => setDragging(false)}
                            onDrop={(event) => {
                                event.preventDefault();
                                setDragging(false);
                                add(event.dataTransfer.files);
                            }}
                            className={`flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed p-8 text-sm transition ${
                                dragging
                                    ? 'border-brand-border bg-brand-subtle'
                                    : 'border-border hover:bg-muted/50'
                            }`}
                        >
                            <FileUp className="text-muted-foreground size-6" />
                            <span className="font-medium">
                                Choose files, or drop them here
                            </span>
                            <span className="text-muted-foreground text-xs">
                                Photos, video, music — anything Telegram takes.
                            </span>
                        </button>
                    ) : (
                        <>
                            <div className="grid gap-2">
                                {picked.map((item) => (
                                    <FileRow
                                        key={item.id}
                                        item={item}
                                        caption={captions[item.id] ?? ''}
                                        showCaption={captionMode === 'each'}
                                        tooLarge={tooLarge.has(item.id)}
                                        onCaption={(text) =>
                                            setCaptions((current) => ({
                                                ...current,
                                                [item.id]: text,
                                            }))
                                        }
                                        onRemove={() => remove(item.id)}
                                    />
                                ))}
                            </div>

                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="mt-3"
                                onClick={() => fileInput.current?.click()}
                            >
                                <Plus />
                                Add more
                            </Button>

                            <fieldset className="mt-5">
                                <legend className="text-sm font-medium">
                                    Text
                                </legend>
                                <div className="mt-2 grid gap-1">
                                    {CAPTION_MODES.map((mode) => (
                                        <ChoiceRow
                                            key={mode.value}
                                            active={captionMode === mode.value}
                                            label={mode.label}
                                            hint={mode.hint}
                                            onSelect={() =>
                                                setCaptionMode(mode.value)
                                            }
                                        />
                                    ))}
                                </div>

                                {captionMode === 'shared' ? (
                                    <div className="mt-2">
                                        <Textarea
                                            value={sharedCaption}
                                            onChange={(event) =>
                                                setSharedCaption(
                                                    event.target.value,
                                                )
                                            }
                                            rows={3}
                                            placeholder="Say something about these files"
                                            aria-label="Message for all files"
                                        />
                                        <CaptionCount
                                            length={sharedCaption.length}
                                        />
                                    </div>
                                ) : null}
                            </fieldset>

                            <fieldset className="mt-5">
                                <legend className="text-sm font-medium">
                                    Delivery
                                </legend>
                                <div className="mt-2 grid gap-1">
                                    {DELIVERIES.map((option) => (
                                        <ChoiceRow
                                            key={option.value}
                                            active={delivery === option.value}
                                            label={option.label}
                                            hint={option.hint}
                                            onSelect={() =>
                                                setDelivery(option.value)
                                            }
                                        />
                                    ))}
                                </div>
                            </fieldset>

                            <TagChoice
                                selected={tagIds}
                                onChange={setTagIds}
                                messages={plan.messages}
                            />

                            <Issues plan={plan} picked={picked} />
                        </>
                    )}
                </div>

                <div className="border-border flex items-center gap-3 border-t p-6">
                    <p className="text-muted-foreground min-w-0 flex-1 text-xs">
                        {plan.files > 0
                            ? `${plan.files} file${plan.files === 1 ? '' : 's'} · ${plan.messages} message${
                                  plan.messages === 1 ? '' : 's'
                              } · ${formatBytes(plan.bytes)}`
                            : 'Nothing picked yet.'}
                    </p>
                    <Button
                        disabled={plan.blocked || sending}
                        onClick={() => void send()}
                    >
                        <Send />
                        {sending ? 'Sending…' : 'Send'}
                    </Button>
                </div>

                {error ? (
                    <p className="px-6 pb-4 text-sm text-red-400" role="alert">
                        {error}
                    </p>
                ) : null}
            </div>
        </div>
    );
}

/**
 * Which tags go on everything in this run.
 *
 * Loaded when the dialog opens rather than with the chat: most sending never
 * tags anything, and the vocabulary is the same in every chat. Same reasoning
 * as the viewer's and the grid's own pickers.
 */
function TagChoice({
    selected,
    onChange,
    messages,
}: {
    selected: number[];
    onChange: (next: number[]) => void;
    /** How many messages the run will make, for the summary line. */
    messages: number;
}) {
    const [tags, setTags] = useState<Tag[] | null>(null);
    const [draft, setDraft] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);

    useEffect(() => {
        let live = true;
        void fetchTags().then((loaded) => {
            if (live) setTags(loaded);
        });
        return () => {
            live = false;
        };
    }, []);

    const toggle = (tagId: number) => {
        onChange(
            selected.includes(tagId)
                ? selected.filter((id) => id !== tagId)
                : [...selected, tagId],
        );
    };

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

            // Creating a name that already exists returns that tag rather than
            // a duplicate, so merge on id instead of appending blindly.
            setTags((current) =>
                current === null || current.some((tag) => tag.id === result.id)
                    ? current
                    : [...current, result].sort((a, b) =>
                          a.name.localeCompare(b.name),
                      ),
            );

            if (!selected.includes(result.id))
                onChange([...selected, result.id]);
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
        <fieldset className="mt-5">
            <legend className="text-sm font-medium">Tags</legend>
            <p className="text-muted-foreground mt-1 text-xs text-pretty">
                {selected.length === 0
                    ? 'Optional. Anything picked here goes on every file once it has been sent.'
                    : `Put on all ${messages.toLocaleString()} message${
                          messages === 1 ? '' : 's'
                      } once they land — in one request, not one per file.`}
            </p>

            {tags === null ? (
                <p className="text-muted-foreground mt-2 text-xs">
                    Loading tags…
                </p>
            ) : tags.length === 0 ? (
                <p className="text-muted-foreground mt-2 text-xs text-pretty">
                    No tags yet. Make one below.
                </p>
            ) : (
                <div className="mt-2 flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                    {tags.map((tag) => {
                        const on = selected.includes(tag.id);

                        return (
                            <Badge
                                key={tag.id}
                                variant={on ? 'default' : 'outline'}
                                className="cursor-pointer gap-1"
                                aria-pressed={on}
                                title={tag.name}
                                render={
                                    <button
                                        type="button"
                                        onClick={() => toggle(tag.id)}
                                    />
                                }
                            >
                                {on ? <Check className="size-3" /> : null}
                                {tag.name}
                            </Badge>
                        );
                    })}
                </div>
            )}

            <div className="mt-2 flex gap-1.5">
                <Input
                    value={draft}
                    onChange={(event) => {
                        setDraft(event.target.value);
                        setError(null);
                    }}
                    onKeyDown={(event) => {
                        // The dialog is not a form, and Enter here must not
                        // reach the Send button behind it.
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        void create();
                    }}
                    placeholder="New tag"
                    aria-label="New tag"
                    maxLength={32}
                    className="h-8"
                />
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={creating || draft.trim() === ''}
                    onClick={() => void create()}
                >
                    {creating ? <Spinner className="size-3" /> : <Plus />}
                </Button>
            </div>

            {error ? (
                <p className="mt-1 text-xs text-red-400" role="alert">
                    {error}
                </p>
            ) : null}
        </fieldset>
    );
}

function CaptionCount({ length }: { length: number }) {
    const over = length > CAPTION_MAX;
    return (
        <p
            className={`mt-1 text-right text-xs ${
                over ? 'text-red-400' : 'text-muted-foreground'
            }`}
        >
            {length.toLocaleString()} / {CAPTION_MAX.toLocaleString()}
        </p>
    );
}

function FileRow({
    item,
    caption,
    showCaption,
    tooLarge,
    onCaption,
    onRemove,
}: {
    item: Picked;
    caption: string;
    showCaption: boolean;
    tooLarge: boolean;
    onCaption: (text: string) => void;
    onRemove: () => void;
}) {
    const kind = sendKindFor({
        id: item.id,
        name: item.file.name,
        size: item.file.size,
        type: item.file.type,
    });

    return (
        <div className="border-border rounded-xl border p-2">
            <div className="flex items-center gap-3">
                {item.preview ? (
                    <img
                        src={item.preview}
                        alt=""
                        className="size-10 shrink-0 rounded-lg object-cover"
                    />
                ) : (
                    <span className="bg-muted text-muted-foreground grid size-10 shrink-0 place-items-center rounded-lg text-[10px] uppercase">
                        {kind === 'document' ? 'file' : kind}
                    </span>
                )}

                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{item.file.name}</p>
                    <p
                        className={`text-xs ${
                            tooLarge ? 'text-red-400' : 'text-muted-foreground'
                        }`}
                    >
                        {formatBytes(item.file.size)}
                        {tooLarge
                            ? ' — too large to send, will be skipped'
                            : ''}
                    </p>
                </div>

                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={onRemove}
                    aria-label={`Remove ${item.file.name}`}
                >
                    <Trash2 />
                </Button>
            </div>

            {showCaption ? (
                <div className="mt-2">
                    <Input
                        value={caption}
                        onChange={(event) => onCaption(event.target.value)}
                        placeholder="Message for this file"
                        aria-label={`Message for ${item.file.name}`}
                    />
                    {caption.length > CAPTION_MAX ? (
                        <CaptionCount length={caption.length} />
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

function Issues({
    plan,
    picked,
}: {
    plan: ReturnType<typeof planUpload>;
    picked: Picked[];
}) {
    const longCaptions = plan.issues.filter(
        (issue) => issue.kind === 'caption-too-long',
    );
    if (longCaptions.length === 0) return null;

    const names = longCaptions
        .map((issue) =>
            issue.kind === 'caption-too-long' && issue.fileId
                ? picked.find((item) => item.id === issue.fileId)?.file.name
                : 'the shared message',
        )
        .filter(Boolean);

    return (
        <p className="mt-5 text-sm text-red-400" role="alert">
            Too long for Telegram ({CAPTION_MAX.toLocaleString()} characters):{' '}
            {names.join(', ')}.
        </p>
    );
}
