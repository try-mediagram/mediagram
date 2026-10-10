import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fitPhotoQuality } from './photo-fit.ts';
import type { MediaQuality } from './types.ts';

/** Telegram's usual photo ladder for a 2560x1440 landscape original. */
const ladder: MediaQuality[] = [
    [320, 180, 'p-m'],
    [800, 450, 'p-x'],
    [1280, 720, 'p-y'],
    [2560, 1440, 'full'],
].map(([width, height, id]) => ({
    id: String(id),
    label: `${height}p`,
    width: Number(width),
    height: Number(height),
    hasHls: false,
}));

describe('fitPhotoQuality', () => {
    it('takes the smallest size that fills the window', () => {
        assert.equal(fitPhotoQuality(ladder, 2560, 1440, 1280, 800)?.id, 'p-y');
    });

    it('lets the height limit a wide picture in a tall box', () => {
        // 600px tall shows a 1067px-wide picture: 1280 still, not 2560.
        assert.equal(fitPhotoQuality(ladder, 2560, 1440, 3000, 600)?.id, 'p-y');
        // 400px tall shows 711px: 800 is enough.
        assert.equal(fitPhotoQuality(ladder, 2560, 1440, 3000, 400)?.id, 'p-x');
    });

    it('accepts a size a few percent short', () => {
        assert.equal(fitPhotoQuality(ladder, 2560, 1440, 880, 2000)?.id, 'p-x');
    });

    it('goes to the original for a retina full screen', () => {
        assert.equal(
            fitPhotoQuality(ladder, 2560, 1440, 3024, 1964)?.id,
            'full',
        );
    });

    it('never asks for more than the original', () => {
        assert.equal(
            fitPhotoQuality(ladder, 2560, 1440, 8000, 8000)?.id,
            'full',
        );
    });

    it('answers nothing when no size fills the box', () => {
        assert.equal(
            fitPhotoQuality(ladder.slice(0, 2), 2560, 1440, 3000, 2000),
            undefined,
        );
    });
});
