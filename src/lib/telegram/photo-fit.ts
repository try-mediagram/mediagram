import type { MediaQuality } from './types.ts';

/**
 * The smallest size in `ladder` (smallest first) that fills a box of
 * `boxWidth` by `boxHeight` pixels at the photo's own aspect ratio, or
 * undefined when none does and the original is what is left.
 *
 * The picture is shown contained, so what it occupies is the narrower of the
 * box's width and its height times the aspect — and never more than the
 * original, which no amount of window makes bigger.
 */
export function fitPhotoQuality(
    ladder: MediaQuality[],
    photoWidth: number,
    photoHeight: number,
    boxWidth: number,
    boxHeight: number,
): MediaQuality | undefined {
    const aspect =
        photoWidth > 0 && photoHeight > 0 ? photoWidth / photoHeight : 1;
    const shownWidth = Math.min(
        boxWidth,
        boxHeight * aspect,
        photoWidth > 0 ? photoWidth : Number.POSITIVE_INFINITY,
    );
    // A few percent short is invisible, and saves a whole step up the ladder.
    const enough = shownWidth * 0.9;
    return ladder.find((quality) => quality.width >= enough);
}
