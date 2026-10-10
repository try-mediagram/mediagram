import { Paperclip, Pencil, Reply, SendHorizontal, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import type { ThreadMessage } from '@/lib/telegram/types';
import { cn } from '@/lib/utils';

/** How often "typing…" is re-sent while the reader keeps typing. */
const TYPING_EVERY_MS = 5_000;

export type ComposerMode =
    | { kind: 'new' }
    | { kind: 'reply'; message: ThreadMessage }
    | { kind: 'edit'; message: ThreadMessage };

/**
 * Where a message is written.
 *
 * Enter sends and Shift+Enter breaks the line, the way every chat app does.
 * Escape drops a reply or an edit. While editing, the field holds the
 * message's own text and Send saves it in place.
 */
export function ChatComposer({
    mode,
    onCancelMode,
    onSend,
    onTyping,
    onAttach,
    disabledReason,
    compact = false,
}: {
    mode: ComposerMode;
    onCancelMode: () => void;
    /** Resolves once Telegram has the message; rejects to keep the draft. */
    onSend: (text: string) => Promise<void>;
    onTyping?: () => void;
    /** Sends photos, video and files; the button only shows when given. */
    onAttach?: () => void;
    /** Shown in place of the field when this account cannot write here. */
    disabledReason?: string | null;
    compact?: boolean;
}) {
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const field = useRef<HTMLTextAreaElement>(null);
    const lastTyping = useRef(0);
    // The draft that was being written before an edit took over the field,
    // handed back when the edit is done or dropped.
    const stashed = useRef('');

    const editing = mode.kind === 'edit' ? mode.message : null;
    const replying = mode.kind === 'reply' ? mode.message : null;

    // biome-ignore lint/correctness/useExhaustiveDependencies: the draft is read only at the moment the mode changes
    useEffect(() => {
        if (editing) {
            stashed.current = draft;
            setDraft(editing.text);
        }
        if (mode.kind !== 'new') field.current?.focus();
    }, [editing, mode.kind]);

    if (disabledReason) {
        return (
            <p className="text-muted-foreground border-border shrink-0 border-t px-3 py-3 text-center text-xs text-pretty">
                {disabledReason}
            </p>
        );
    }

    const trimmed = draft.trim();
    const unchanged = editing !== null && trimmed === editing.text.trim();

    async function submit() {
        if (!trimmed || sending || unchanged) return;
        setSending(true);
        try {
            await onSend(trimmed);
            setDraft(editing ? stashed.current : '');
            stashed.current = '';
        } catch {
            // The caller said why; the draft stays so nothing is lost.
        } finally {
            setSending(false);
            field.current?.focus();
        }
    }

    function cancel() {
        if (editing) {
            setDraft(stashed.current);
            stashed.current = '';
        }
        onCancelMode();
    }

    return (
        <div className="border-border bg-background shrink-0 border-t">
            {replying || editing ? (
                <div className="border-border flex items-center gap-2 border-b px-3 py-1.5">
                    {editing ? (
                        <Pencil className="text-primary size-3.5 shrink-0" />
                    ) : (
                        <Reply className="text-primary size-3.5 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1 border-l-2 border-primary pl-2">
                        <p className="text-primary truncate text-[11px] font-medium">
                            {editing
                                ? 'Edit message'
                                : `Reply to ${replying?.senderName ?? ''}`}
                        </p>
                        <p className="text-muted-foreground truncate text-xs">
                            {snippet(editing ?? replying)}
                        </p>
                    </div>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Cancel"
                        onClick={cancel}
                    >
                        <X />
                    </Button>
                </div>
            ) : null}
            <form
                className="flex items-end gap-2 px-3 py-2"
                onSubmit={(event) => {
                    event.preventDefault();
                    void submit();
                }}
            >
                {onAttach && !editing ? (
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground shrink-0 rounded-full"
                        aria-label="Attach photos, video or files"
                        title="Attach photos, video or files"
                        onClick={onAttach}
                    >
                        <Paperclip />
                    </Button>
                ) : null}
                <textarea
                    ref={field}
                    value={draft}
                    rows={1}
                    aria-label="Message"
                    placeholder={
                        editing ? 'Edit your message' : 'Write a message…'
                    }
                    onChange={(event) => {
                        setDraft(event.target.value);
                        const now = Date.now();
                        if (
                            onTyping &&
                            now - lastTyping.current > TYPING_EVERY_MS
                        ) {
                            lastTyping.current = now;
                            onTyping();
                        }
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'Escape' && mode.kind !== 'new') {
                            event.preventDefault();
                            cancel();
                            return;
                        }
                        if (
                            event.key === 'Enter' &&
                            !event.shiftKey &&
                            !event.nativeEvent.isComposing
                        ) {
                            event.preventDefault();
                            void submit();
                        }
                    }}
                    className={cn(
                        'border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 field-sizing-content max-h-40 min-h-9 w-full flex-1 resize-none rounded-2xl border bg-transparent px-3 py-2 outline-none focus-visible:ring-3',
                        compact ? 'text-xs' : 'text-sm',
                    )}
                />
                <Button
                    type="submit"
                    size="icon"
                    className="shrink-0 rounded-full"
                    disabled={!trimmed || sending || unchanged}
                    aria-label={editing ? 'Save edit' : 'Send message'}
                >
                    <SendHorizontal />
                </Button>
            </form>
        </div>
    );
}

export function snippet(message: ThreadMessage | null | undefined): string {
    if (!message) return '';
    const flat = message.text.replace(/\s+/g, ' ').trim();
    if (flat) return flat;
    switch (message.kind) {
        case 'photo':
            return 'Photo';
        case 'video':
            return 'Video';
        case 'gif':
            return 'GIF';
        case 'voice':
            return 'Voice message';
        case 'audio':
            return message.audioTitle ?? 'Audio';
        case 'file':
            return message.fileName ?? 'File';
        default:
            return 'Message';
    }
}
