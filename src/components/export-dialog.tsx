import {
    Download,
    FolderDown,
    Loader2,
    Lock,
    ScanSearch,
    X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ChoiceRow } from '@/components/choice-row';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import type { MediaSearchState } from '@/components/media-filters';
import { formatBytes } from '@/lib/format';
import type { ExportMediaKind } from '@/lib/export/plan';
import type {
    ExportFilters,
    ExportManifest,
    ExportOptions,
    ExportScope,
} from '@/lib/export/run';
import type { DialogItem } from '@/lib/telegram/types';

const KINDS: { value: ExportMediaKind; label: string }[] = [
    { value: 'photo', label: 'Photos' },
    { value: 'video', label: 'Video' },
    { value: 'gif', label: 'GIFs' },
    { value: 'audio', label: 'Music' },
    { value: 'voice', label: 'Voice notes' },
];

const DEFAULT_KINDS: ExportMediaKind[] = ['photo', 'video', 'gif'];

/** What lands in the folder. */
type ExportContents =
    /** The conversation and the files it refers to. */
    | 'everything'
    /** Just the files. Someone pulling photos out of a chat wants photos. */
    | 'media'
    /** Just the conversation. */
    | 'transcript';

const CONTENTS: { value: ExportContents; label: string; hint: string }[] = [
    {
        value: 'everything',
        label: 'Conversation and media',
        hint: 'A readable transcript, with every file beside it.',
    },
    {
        value: 'media',
        label: 'Media only',
        hint: 'Just the files, named and dated. No transcript.',
    },
    {
        value: 'transcript',
        label: 'Conversation only',
        hint: 'The messages as a web page, with no files.',
    },
];

type ScanState =
    | { phase: 'idle' }
    | { phase: 'scanning'; scanned: number; found: number }
    | { phase: 'ready'; manifest: ExportManifest }
    | { phase: 'failed'; error: string };

/**
 * What an export will contain, settled before anything is downloaded.
 *
 * Nothing is read until the reader asks for it. Opening this over a chat with
 * a long history used to walk the whole thing before they had picked a range
 * they may well narrow, so the scan is a button — and any change to what would
 * have to be walked drops back to unscanned rather than starting again behind
 * them.
 *
 * The scan reads metadata, never bytes, so the estimate is honest before the
 * reader commits to a download that may take an hour. Only the scope and the
 * earliest date change what has to be read — the kinds and the latest date are
 * decided over messages already in hand, which is why ticking a box re-plans
 * instantly instead of walking the chat again.
 *
 * The Telegram half is behind a dynamic import, so opening a chat does not pay
 * for an exporter nobody asked for.
 */
export function ExportDialog({
    open,
    chat,
    chatId,
    filters,
    onClose,
}: {
    open: boolean;
    chat: DialogItem | null;
    chatId: number;
    filters: MediaSearchState;
    onClose: () => void;
}) {
    const [contents, setContents] = useState<ExportContents>('everything');
    const [scope, setScope] = useState<ExportScope>('chat');
    const [kinds, setKinds] = useState<ExportMediaKind[]>(DEFAULT_KINDS);
    const [since, setSince] = useState('');
    const [until, setUntil] = useState('');
    const [scan, setScan] = useState<ScanState>({ phase: 'idle' });
    const [starting, setStarting] = useState(false);
    const [canUseFolder, setCanUseFolder] = useState(true);

    const title = chat?.title ?? 'this chat';

    useEffect(() => {
        if (!open) return;
        let live = true;
        void import('@/lib/export/sink').then((mod) => {
            if (live) setCanUseFolder(mod.supportsDirectoryExport());
        });
        return () => {
            live = false;
        };
    }, [open]);

    // Media needs a browser that can be handed a folder. Either way the
    // conversation still exports.
    const mediaAvailable = canUseFolder;

    // With no way to write media, the choice collapses to the one option that
    // still works rather than offering two that cannot run.
    const wanted: ExportContents = mediaAvailable ? contents : 'transcript';
    const includeMedia = mediaAvailable && wanted !== 'transcript';
    const includeTranscript = wanted !== 'media';

    const exportFilters = useMemo<ExportFilters>(
        () => ({
            type: filters.type,
            order: filters.order,
            minDur: filters.minDur,
            maxDur: filters.maxDur,
            tags: filters.tags,
            tagMatch: filters.tagMatch,
            query: filters.query,
        }),
        [filters],
    );

    const options = useMemo<ExportOptions>(
        () => ({
            chatId,
            chatTitle: title,
            chatUsername: chat?.username ?? undefined,
            scope,
            kinds,
            since: since || undefined,
            until: until || undefined,
            includeMedia,
            includeTranscript,
            filters: exportFilters,
        }),
        [
            chat?.username,
            chatId,
            exportFilters,
            includeMedia,
            includeTranscript,
            kinds,
            scope,
            since,
            title,
            until,
        ],
    );

    const scanning = useRef<AbortController | null>(null);

    /** Drop back to unscanned, stopping a walk that is still running. */
    const cancelScan = useCallback(() => {
        scanning.current?.abort();
        scanning.current = null;
        setScan({ phase: 'idle' });
    }, []);

    // Opening the dialog, and any change to what would have to be read, goes
    // back to idle. Only the scope and the earliest date decide that; the
    // kinds and the latest date re-plan over what the scan already holds.
    useEffect(() => {
        cancelScan();
    }, [cancelScan, open, scope, since, chatId]);

    useEffect(() => () => scanning.current?.abort(), []);

    const runScan = useCallback(async () => {
        scanning.current?.abort();
        const controller = new AbortController();
        scanning.current = controller;
        setScan({ phase: 'scanning', scanned: 0, found: 0 });

        try {
            const mod = await import('@/lib/export/run');
            const manifest = await mod.scanExport(
                options,
                (scanned, found) => {
                    if (!controller.signal.aborted) {
                        setScan({ phase: 'scanning', scanned, found });
                    }
                },
                controller.signal,
            );
            if (!controller.signal.aborted) {
                setScan({ phase: 'ready', manifest });
            }
        } catch (error) {
            if (controller.signal.aborted) return;
            const { describeTelegramError } = await import(
                '@/lib/telegram/errors'
            );
            setScan({
                phase: 'failed',
                error: describeTelegramError(error),
            });
        }
    }, [options]);

    // Re-plan over the scanned messages whenever the cheap options change.
    const [planned, setPlanned] = useState<ExportManifest | null>(null);

    useEffect(() => {
        if (scan.phase !== 'ready') {
            setPlanned(null);
            return;
        }
        let live = true;
        void import('@/lib/export/run').then((mod) => {
            if (live) setPlanned(mod.planFrom(options, scan.manifest.messages));
        });
        return () => {
            live = false;
        };
    }, [options, scan]);

    // A media-only run with nothing matching writes an empty folder and says
    // it succeeded. A transcript run always has something to write.
    const nothingToWrite = !includeTranscript && planned?.items === 0;

    const start = useCallback(async () => {
        if (!planned) return;
        setStarting(true);
        try {
            const [sinkMod, runMod] = await Promise.all([
                import('@/lib/export/sink'),
                import('@/lib/export/run'),
            ]);

            const folder = runMod.exportFolderFor(options);
            // The picker needs the click that opened it, so it goes first —
            // an await before it turns "pick a folder" into a silent no-op.
            const sink = mediaAvailable
                ? await sinkMod.pickDirectorySink(folder)
                : sinkMod.createTranscriptSink(folder);

            runMod.startExport(planned, sink);
            onClose();
        } catch (error) {
            const { ExportCancelled } = await import('@/lib/export/sink');
            // Closing the folder picker is a decision, not a failure.
            if (error instanceof ExportCancelled) return;
            const { describeTelegramError } = await import(
                '@/lib/telegram/errors'
            );
            setScan({ phase: 'failed', error: describeTelegramError(error) });
        } finally {
            setStarting(false);
        }
    }, [mediaAvailable, onClose, options, planned]);

    useEffect(() => {
        if (!open) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    if (!open) return null;

    const toggleKind = (kind: ExportMediaKind, on: boolean) => {
        setKinds((current) =>
            on ? [...current, kind] : current.filter((value) => value !== kind),
        );
    };

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-label={`Export ${title}`}
            className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-6 backdrop-blur-sm"
            onClick={onClose}
        >
            <div
                className="border-border bg-card max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-3xl border p-6 shadow-lg"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h2 className="font-display text-xl font-bold tracking-tight">
                            Export chat
                        </h2>
                        <p className="text-muted-foreground mt-1 text-sm">
                            Everything is downloaded in this browser and saved
                            to your device. Nothing passes through our servers.
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

                {mediaAvailable ? (
                    <fieldset className="mt-5">
                        <legend className="text-sm font-medium">
                            Contents
                        </legend>
                        <div className="mt-2 grid gap-1">
                            {CONTENTS.map((option) => (
                                <ChoiceRow
                                    key={option.value}
                                    active={contents === option.value}
                                    label={option.label}
                                    hint={option.hint}
                                    onSelect={() => setContents(option.value)}
                                />
                            ))}
                        </div>
                    </fieldset>
                ) : null}

                <fieldset className="mt-5">
                    <legend className="text-sm font-medium">Range</legend>
                    <div className="mt-2 grid gap-1">
                        <ChoiceRow
                            active={scope === 'chat'}
                            label="Whole chat"
                            hint="Every message, back to the beginning."
                            onSelect={() => setScope('chat')}
                        />
                        <ChoiceRow
                            active={scope === 'filters'}
                            label="Current filters"
                            hint="Only what the grid is showing right now."
                            onSelect={() => setScope('filters')}
                        />
                    </div>
                </fieldset>

                {/*
                    When media cannot be written, the checkboxes go entirely
                    rather than standing there ticked and dead. A disabled
                    multi-select showing a selection nobody can change, for
                    files that are not coming, reads as a broken control — the
                    same reason DownloadButton keeps its word and swaps only
                    the glyph.
                */}
                {includeMedia ? (
                    <fieldset className="mt-5">
                        <legend className="text-sm font-medium">Media</legend>
                        <div className="mt-2 grid grid-cols-2 gap-2">
                            {KINDS.map((kind) => (
                                <Label
                                    key={kind.value}
                                    className="flex items-center gap-2 text-sm font-normal"
                                >
                                    <Checkbox
                                        checked={kinds.includes(kind.value)}
                                        onCheckedChange={(checked) =>
                                            toggleKind(
                                                kind.value,
                                                checked === true,
                                            )
                                        }
                                    />
                                    {kind.label}
                                </Label>
                            ))}
                        </div>
                    </fieldset>
                ) : (
                    <div className="border-border bg-muted/40 mt-5 flex items-start gap-3 rounded-xl border p-3">
                        <Lock className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                        <div className="min-w-0">
                            <p className="text-sm font-medium">
                                Conversation only
                            </p>
                            <p className="text-muted-foreground mt-1 text-xs">
                                This browser cannot be handed a folder, so only
                                the conversation can be saved. Chrome and Edge
                                export the media too.
                            </p>
                        </div>
                    </div>
                )}

                <fieldset className="mt-5">
                    <legend className="text-sm font-medium">Dates</legend>
                    <div className="mt-2 flex items-center gap-2">
                        <input
                            type="date"
                            value={since}
                            max={until || undefined}
                            onChange={(event) => setSince(event.target.value)}
                            aria-label="Earliest date"
                            className="border-input bg-background h-9 min-w-0 flex-1 rounded-md border px-2 text-sm"
                        />
                        <span className="text-muted-foreground text-xs">
                            to
                        </span>
                        <input
                            type="date"
                            value={until}
                            min={since || undefined}
                            onChange={(event) => setUntil(event.target.value)}
                            aria-label="Latest date"
                            className="border-input bg-background h-9 min-w-0 flex-1 rounded-md border px-2 text-sm"
                        />
                    </div>
                </fieldset>

                <Summary
                    scan={scan}
                    planned={planned}
                    includeMedia={includeMedia}
                    includeTranscript={includeTranscript}
                    onCancel={cancelScan}
                />

                <div className="mt-5 flex gap-2">
                    {/*
                        Two presses, because they ask for different things: the
                        first reads the chat, the second commits to writing it.
                        Folding them together would put an await between the
                        click and showDirectoryPicker(), which is exactly what
                        stops the picker from opening.
                    */}
                    {scan.phase === 'ready' ? (
                        <Button
                            className="flex-1"
                            disabled={!planned || starting || nothingToWrite}
                            title={
                                nothingToWrite
                                    ? 'Nothing matches — no files to export.'
                                    : undefined
                            }
                            onClick={() => void start()}
                        >
                            {includeMedia ? <FolderDown /> : <Download />}
                            {starting
                                ? 'Starting…'
                                : includeMedia
                                  ? 'Choose folder'
                                  : 'Download transcript'}
                        </Button>
                    ) : (
                        <Button
                            className="flex-1"
                            disabled={scan.phase === 'scanning'}
                            onClick={() => void runScan()}
                        >
                            <ScanSearch />
                            {scan.phase === 'scanning'
                                ? 'Reading chat…'
                                : scan.phase === 'failed'
                                  ? 'Try again'
                                  : 'Start export'}
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
}

function Summary({
    scan,
    planned,
    includeMedia,
    includeTranscript,
    onCancel,
}: {
    scan: ScanState;
    planned: ExportManifest | null;
    includeMedia: boolean;
    includeTranscript: boolean;
    onCancel: () => void;
}) {
    if (scan.phase === 'idle') {
        return (
            <p className="text-muted-foreground mt-5 text-sm">
                Nothing is read until you start. Mediagram reads the chat first
                to work out what the export holds, then asks where to save it.
            </p>
        );
    }

    if (scan.phase === 'failed') {
        return (
            <p className="mt-5 text-sm text-red-400" role="alert">
                {scan.error}
            </p>
        );
    }

    if (scan.phase === 'scanning') {
        return (
            <div className="mt-5 flex items-center justify-between gap-2">
                <p className="text-muted-foreground flex items-center gap-2 text-sm">
                    <Loader2 className="size-4 animate-spin" />
                    Reading the chat… {scan.scanned.toLocaleString()} messages,{' '}
                    {scan.found.toLocaleString()} media
                </p>
                <Button variant="ghost" size="sm" onClick={onCancel}>
                    Stop
                </Button>
            </div>
        );
    }

    if (!planned) return null;

    const size = planned.bytes > 0 ? formatBytes(planned.bytes) : null;

    // Only count what is actually going to be written. A media-only run that
    // announced "4,102 messages" would be describing a file nobody asked for.
    const parts = [
        includeTranscript
            ? `${planned.messages.length.toLocaleString()} messages`
            : null,
        includeMedia ? `${planned.items.toLocaleString()} files` : null,
        includeMedia && size
            ? `${planned.partial ? 'at least ' : ''}${size}`
            : null,
    ].filter(Boolean);

    return (
        <div className="bg-muted/50 mt-5 rounded-xl p-3 text-sm">
            <p>{parts.join(' · ')}</p>
        </div>
    );
}
