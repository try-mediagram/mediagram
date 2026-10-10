import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { choosePreview, resolveVideoDuration } from './preview.ts';

describe('choosePreview', () => {
    it('uses the file own thumbnail whenever there is one', () => {
        for (const kind of ['photo', 'video', 'audio', 'voice'] as const) {
            assert.equal(
                choosePreview(kind, { hasThumbnail: true, hasCover: false }),
                'thumbnail',
                kind,
            );
        }
    });

    it('falls to the post cover photo when the file has no thumbnail', () => {
        assert.equal(
            choosePreview('video', { hasThumbnail: false, hasCover: true }),
            'cover',
        );
    });

    it('prefers the thumbnail over the cover', () => {
        assert.equal(
            choosePreview('video', { hasThumbnail: true, hasCover: true }),
            'thumbnail',
        );
    });

    it('lets a photo stand in for its own preview', () => {
        assert.equal(
            choosePreview('photo', { hasThumbnail: false, hasCover: false }),
            'source',
        );
    });

    it('never downloads a whole document to paint a tile', () => {
        for (const kind of ['video', 'audio', 'voice'] as const) {
            assert.equal(
                choosePreview(kind, { hasThumbnail: false, hasCover: false }),
                'none',
                kind,
            );
        }
    });
});

describe('resolveVideoDuration', () => {
    it('takes the document own duration when it has one', () => {
        assert.equal(resolveVideoDuration(221), 221);
    });

    it('reads an alt rendition when the uploader never measured it', () => {
        const alts = [
            {
                _: 'document',
                attributes: [
                    { _: 'documentAttributeFilename' },
                    { _: 'documentAttributeVideo', duration: 94 },
                ],
            },
        ];

        assert.equal(resolveVideoDuration(0, alts), 94);
        assert.equal(resolveVideoDuration(undefined, alts), 94);
    });

    it('skips the HLS playlist alt, which has no video attribute', () => {
        assert.equal(
            resolveVideoDuration(0, [
                {
                    _: 'document',
                    attributes: [{ _: 'documentAttributeAudio' }],
                },
                {
                    _: 'document',
                    attributes: [{ _: 'documentAttributeVideo', duration: 12 }],
                },
            ]),
            12,
        );
    });

    it('ignores an empty alt and an alt that also says zero', () => {
        assert.equal(
            resolveVideoDuration(0, [
                { _: 'documentEmpty' },
                {
                    _: 'document',
                    attributes: [{ _: 'documentAttributeVideo', duration: 0 }],
                },
            ]),
            0,
        );
    });

    it('answers zero when nobody knows, which every caller reads as absent', () => {
        assert.equal(resolveVideoDuration(undefined), 0);
        assert.equal(resolveVideoDuration(0, []), 0);
    });
});
