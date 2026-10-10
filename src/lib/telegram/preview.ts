/**
 * What a grid tile shows before anything is downloaded, and how long a video
 * says it runs.
 *
 * Both answers used to be inlined in media.ts, where they could only be checked
 * against a live Telegram session. They are decisions, not requests — so they
 * live here, importing nothing, and are tested under `node --test` the same way
 * `chat-target.ts` and `reactions.ts` are.
 */

/** The kinds mtcute hands back for media we can show. */
export type PreviewKind = 'photo' | 'video' | 'audio' | 'voice';

/**
 * Where a tile's picture comes from.
 *
 * - `thumbnail` — Telegram published a preview on the file itself.
 * - `cover` — the post carries its own cover photo instead
 *   (`messageMediaDocument.video_cover`), which the file's thumbnail ladder
 *   never mentions.
 * - `source` — the file *is* the picture. Only ever right for a photo.
 * - `none` — nothing to show without downloading the whole file, so show a
 *   glyph and download nothing.
 */
export type PreviewChoice = 'thumbnail' | 'cover' | 'source' | 'none';

/**
 * Which of those four applies.
 *
 * The interesting case is the last one. Falling back to the whole file is right
 * for a photo and ruinous for anything document-backed: a 40 MB track with no
 * cover art, or a video Telegram never made a thumbnail for, would be pulled
 * down whole over MTProto to paint a 200px tile — and those bytes are not a
 * JPEG, so the `<img>` handed them fails anyway. The tile ends up blank either
 * way; `none` just gets there without the download.
 */
export function choosePreview(
    kind: PreviewKind,
    available: { hasThumbnail: boolean; hasCover: boolean },
): PreviewChoice {
    if (available.hasThumbnail) return 'thumbnail';
    if (available.hasCover) return 'cover';
    if (kind === 'photo') return 'source';
    return 'none';
}

/** The shape of a document attribute this module needs, and nothing more. */
type DurationAttribute = { _: string; duration?: number };

/** The shape of an alt rendition this module needs, and nothing more. */
type AltDocument = { _: string; attributes?: readonly DurationAttribute[] };

/**
 * How long a video runs, taking the answer from an alt rendition when the main
 * document does not carry one.
 *
 * `documentAttributeVideo.duration` is filled in by whoever uploaded the file,
 * and plenty of channel posts — anything sent by a script that never measured
 * it — carry a zero. Telegram's own transcoded renditions do know, so they are
 * asked before a tile gives up and says "Video".
 *
 * Zero is the "not told" answer here, not a real length: Telegram has no
 * zero-second video, and every caller treats 0 as absent.
 */
export function resolveVideoDuration(
    own: number | undefined,
    alts: readonly AltDocument[] = [],
): number {
    if (own) return own;

    for (const alt of alts) {
        if (alt._ !== 'document') continue;
        for (const attr of alt.attributes ?? []) {
            if (attr._ === 'documentAttributeVideo' && attr.duration) {
                return attr.duration;
            }
        }
    }

    return 0;
}
