/**
 * The two readable halves of an export: `messages.json` and `index.html`.
 *
 * Pure on purpose — no imports at all, not even from plan.ts — so it runs
 * under `node --test` the way chat-target.ts does, and so nothing here can
 * reach a Telegram client by accident. Everything it needs is passed in.
 *
 * The types are declared rather than imported for the same reason.
 * `ThreadMessage` satisfies `TranscriptMessage` structurally.
 */

export type TranscriptReaction = {
    emoji: string;
    count: number;
};

/** A `ThreadMessage` is assignable to this as-is. */
export type TranscriptMessage = {
    id: number;
    /** ISO 8601. */
    date: string;
    senderId?: number;
    senderName: string;
    senderUsername?: string;
    /** Already a data URL when present, so it inlines with no extra work. */
    senderAvatarPreview?: string;
    text: string;
    replyToId?: number;
    kind: string;
    isOutgoing: boolean;
    reactions: readonly TranscriptReaction[];
    duration?: number;
    fileName?: string;
    mimeType?: string;
    audioTitle?: string;
    audioPerformer?: string;
};

export type ExportedFileStatus =
    | 'written'
    | 'filtered'
    | 'unsupported'
    | 'omitted'
    | 'failed';

export type ExportedFile = {
    /** Relative path inside the export folder, set only when written. */
    path?: string;
    status: ExportedFileStatus;
    /** What went wrong, for `failed`. */
    reason?: string;
};

export type TranscriptChat = {
    id: number;
    title: string;
    username?: string;
};

export type TranscriptInput = {
    chat: TranscriptChat;
    /** Oldest first — the order a person reads a chat in. */
    messages: readonly TranscriptMessage[];
    /** Keyed by message id. Messages with no media are simply absent. */
    files: ReadonlyMap<number, ExportedFile>;
    exportedAt: Date;
};

/**
 * Why a file is not beside the transcript, said in the reader's terms.
 */
const MISSING: Record<Exclude<ExportedFileStatus, 'written'>, string> = {
    filtered: 'Not exported — outside the range you chose.',
    unsupported: 'Not exported — Mediagram cannot yet save this kind of file.',
    omitted: 'Not exported — this export covers the conversation only.',
    failed: 'Could not be downloaded.',
};

export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

/** `YYYY-MM-DD` in the reader's own timezone. */
function dayStamp(at: Date): string {
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** `HH:MM`, 24-hour, so the transcript does not depend on a locale. */
function timeStamp(at: Date): string {
    return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function parseDate(value: string): Date | null {
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * `messages.json` — the half meant for a program rather than a person.
 *
 * Avatars are deliberately left out. They are per-sender, not per-message, and
 * repeating a data URL on every row turns a readable file into megabytes of
 * base64 that no consumer of this JSON wants.
 */
export function buildMessagesJson(input: TranscriptInput): string {
    const payload = {
        chat: {
            id: input.chat.id,
            title: input.chat.title,
            username: input.chat.username ?? null,
        },
        exportedAt: input.exportedAt.toISOString(),
        messageCount: input.messages.length,
        // Named so a reader of the file knows this is a client-side export and
        // that the gaps in it are Telegram's rules, not missing data.
        generator: 'Mediagram',
        messages: input.messages.map((message) => {
            const file = input.files.get(message.id);
            return {
                id: message.id,
                date: message.date,
                senderId: message.senderId ?? null,
                senderName: message.senderName,
                senderUsername: message.senderUsername ?? null,
                isOutgoing: message.isOutgoing,
                replyToId: message.replyToId ?? null,
                kind: message.kind,
                text: message.text,
                duration: message.duration ?? null,
                fileName: message.fileName ?? null,
                mimeType: message.mimeType ?? null,
                audioTitle: message.audioTitle ?? null,
                audioPerformer: message.audioPerformer ?? null,
                reactions: message.reactions.map((reaction) => ({
                    emoji: reaction.emoji,
                    count: reaction.count,
                })),
                media: file
                    ? {
                          status: file.status,
                          path: file.path ?? null,
                          reason: file.reason ?? null,
                      }
                    : null,
            };
        }),
    };

    return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * One CSS class per sender rather than a data URL per message.
 *
 * A chat of ten thousand messages has a handful of senders. Inlining the same
 * avatar on every row is what turns a 2 MB transcript into a 200 MB one.
 */
function collectAvatars(messages: readonly TranscriptMessage[]) {
    const byKey = new Map<string, { className: string; url: string }>();
    let next = 0;

    for (const message of messages) {
        if (!message.senderAvatarPreview) continue;
        const key = String(message.senderId ?? message.senderName);
        if (byKey.has(key)) continue;
        next += 1;
        byKey.set(key, {
            className: `av-${next}`,
            url: message.senderAvatarPreview,
        });
    }

    return byKey;
}

function avatarKey(message: TranscriptMessage): string {
    return String(message.senderId ?? message.senderName);
}

/** Two letters to stand in when a sender has no photo. */
function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function renderMedia(message: TranscriptMessage, file: ExportedFile): string {
    if (file.status !== 'written' || !file.path) {
        const note =
            MISSING[file.status as Exclude<ExportedFileStatus, 'written'>];
        const detail = file.reason ? ` ${escapeHtml(file.reason)}` : '';
        return `<p class="missing">${escapeHtml(note ?? 'Not exported.')}${detail}</p>`;
    }

    const src = escapeHtml(file.path);
    const label = escapeHtml(message.fileName ?? message.kind);

    if (message.kind === 'photo') {
        return `<a class="media" href="${src}"><img src="${src}" alt="${label}" loading="lazy"></a>`;
    }

    if (message.kind === 'video' || message.kind === 'gif') {
        // A Telegram "gif" is a silent mp4, so it plays as a looping video.
        const extra = message.kind === 'gif' ? ' loop muted' : '';
        return `<video class="media" src="${src}" controls playsinline preload="none"${extra}></video>`;
    }

    if (message.kind === 'audio' || message.kind === 'voice') {
        return `<audio class="media" src="${src}" controls preload="none"></audio>`;
    }

    return `<p><a href="${src}">${label}</a></p>`;
}

function renderReactions(reactions: readonly TranscriptReaction[]): string {
    if (reactions.length === 0) return '';
    const chips = reactions
        .map(
            (reaction) =>
                `<span class="reaction">${escapeHtml(reaction.emoji)} ${reaction.count}</span>`,
        )
        .join('');
    return `<div class="reactions">${chips}</div>`;
}

function renderMessage(
    message: TranscriptMessage,
    file: ExportedFile | undefined,
    avatars: ReturnType<typeof collectAvatars>,
): string {
    const at = parseDate(message.date);
    const avatar = avatars.get(avatarKey(message));
    const face = avatar
        ? `<div class="avatar ${avatar.className}"></div>`
        : `<div class="avatar">${escapeHtml(initials(message.senderName))}</div>`;

    const who = message.senderUsername
        ? `${message.senderName} (@${message.senderUsername})`
        : message.senderName;

    const parts = [
        `<div class="meta"><span class="who">${escapeHtml(who)}</span><span class="time">${at ? timeStamp(at) : ''}</span></div>`,
    ];

    if (message.replyToId !== undefined) {
        parts.push(
            `<div class="reply">In reply to message #${message.replyToId}</div>`,
        );
    }

    if (file) parts.push(renderMedia(message, file));

    if (message.text) {
        parts.push(`<p class="text">${escapeHtml(message.text)}</p>`);
    }

    parts.push(renderReactions(message.reactions));

    const outgoing = message.isOutgoing ? ' out' : '';
    return `<article class="msg${outgoing}" id="m${message.id}">${face}<div class="bubble">${parts.join('')}</div></article>`;
}

const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  background: #0a0a0a;
  color: #ededed;
  font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
header {
  position: sticky; top: 0; z-index: 1;
  padding: 20px 24px;
  background: #111;
  border-bottom: 1px solid #262626;
}
h1 { margin: 0; font-size: 20px; letter-spacing: -0.01em; }
header p { margin: 4px 0 0; color: #a1a1a1; font-size: 13px; }
main { max-width: 780px; margin: 0 auto; padding: 24px 16px 64px; }
.day {
  margin: 28px 0 16px;
  text-align: center;
  color: #a1a1a1;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.msg { display: flex; gap: 10px; margin: 0 0 16px; align-items: flex-start; }
.msg.out { flex-direction: row-reverse; }
.avatar {
  flex: 0 0 34px; width: 34px; height: 34px; border-radius: 50%;
  background: #262626 center/cover no-repeat;
  display: grid; place-items: center;
  font-size: 11px; font-weight: 600; color: #a1a1a1;
}
.bubble {
  min-width: 0; max-width: 78%;
  background: #171717; border: 1px solid #262626; border-radius: 14px;
  padding: 10px 12px;
}
.msg.out .bubble { background: #14263a; border-color: #1e3a5c; }
.meta { display: flex; gap: 8px; align-items: baseline; margin-bottom: 4px; }
.who { font-weight: 600; font-size: 13px; }
.time { color: #737373; font-size: 11px; }
.reply {
  margin: 0 0 6px; padding-left: 8px;
  border-left: 2px solid #3f3f3f; color: #a1a1a1; font-size: 12px;
}
.text { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.media { display: block; max-width: 100%; border-radius: 10px; margin: 2px 0; }
img.media { height: auto; }
audio.media { width: 320px; max-width: 100%; }
.missing {
  margin: 2px 0; padding: 8px 10px;
  background: #1c1917; border: 1px dashed #44403c; border-radius: 10px;
  color: #a8a29e; font-size: 12px;
}
.reactions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.reaction {
  background: #262626; border-radius: 999px;
  padding: 1px 8px; font-size: 12px; color: #d4d4d4;
}
footer {
  max-width: 780px; margin: 0 auto; padding: 0 16px 48px;
  color: #737373; font-size: 12px; text-align: center;
}
`;

/**
 * `index.html` — the half meant to be opened and read.
 *
 * Self-contained apart from the `media/` folder beside it, so the whole export
 * survives being moved, copied to a drive, or opened with no network.
 */
export function buildIndexHtml(input: TranscriptInput): string {
    const avatars = collectAvatars(input.messages);

    const avatarCss = [...avatars.values()]
        .map(
            (avatar) =>
                `.${avatar.className}{background-image:url("${avatar.url.replace(/"/g, '&quot;')}")}`,
        )
        .join('\n');

    const rows: string[] = [];
    let day = '';

    for (const message of input.messages) {
        const at = parseDate(message.date);
        const stamp = at ? dayStamp(at) : '';
        if (stamp && stamp !== day) {
            day = stamp;
            rows.push(`<div class="day">${escapeHtml(stamp)}</div>`);
        }
        rows.push(renderMessage(message, input.files.get(message.id), avatars));
    }

    const written = [...input.files.values()].filter(
        (file) => file.status === 'written',
    ).length;

    const subtitle = [
        input.chat.username ? `@${input.chat.username}` : null,
        `${input.messages.length} messages`,
        `${written} files`,
        `exported ${dayStamp(input.exportedAt)}`,
    ]
        .filter(Boolean)
        .join(' · ');

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.chat.title)} — Mediagram export</title>
<style>${STYLE}${avatarCss}
</style>
</head>
<body>
<header>
<h1>${escapeHtml(input.chat.title)}</h1>
<p>${escapeHtml(subtitle)}</p>
</header>
<main>
${rows.join('\n')}
</main>
<footer>Exported from Mediagram. Everything here was downloaded in your browser — no message or file passed through a server.</footer>
</body>
</html>
`;
}
