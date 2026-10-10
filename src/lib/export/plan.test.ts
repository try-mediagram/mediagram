import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    type ExportEntry,
    exportFolderName,
    extensionFor,
    localDateStamp,
    mediaFileName,
    mediaFilePath,
    sanitizeSegment,
    selectForExport,
    summarize,
} from './plan.ts';

function entry(over: Partial<ExportEntry> = {}): ExportEntry {
    return {
        messageId: 1234,
        date: '2026-03-04T10:00:00.000Z',
        type: 'photo',
        ...over,
    };
}

describe('sanitizeSegment', () => {
    it('replaces path separators so a title cannot escape the folder', () => {
        assert.equal(sanitizeSegment('../../etc/passwd'), 'etc-passwd');
        assert.equal(sanitizeSegment('a/b\\c'), 'a-b-c');
    });

    it('strips the characters Windows reserves', () => {
        assert.equal(sanitizeSegment('why? *this* <one>'), 'why-this-one');
        assert.equal(sanitizeSegment('a:b|c"d'), 'a-b-c-d');
    });

    it('drops control characters rather than writing them to disk', () => {
        assert.equal(sanitizeSegment('a\u0000b\u001fc\u007f'), 'a-b-c');
    });

    it('never leaves a leading dot or a trailing dot or space', () => {
        assert.equal(sanitizeSegment('.hidden'), 'hidden');
        assert.equal(sanitizeSegment('trailing.'), 'trailing');
        assert.equal(sanitizeSegment('  padded  '), 'padded');
    });

    it('falls back when nothing survives', () => {
        assert.equal(sanitizeSegment('///'), 'chat');
        assert.equal(sanitizeSegment('', 'photo'), 'photo');
    });

    it('renames the device names Windows refuses', () => {
        assert.equal(sanitizeSegment('CON'), 'CON-file');
        assert.equal(sanitizeSegment('lpt9'), 'lpt9-file');
    });

    it('caps the length so long titles cannot blow the path limit', () => {
        assert.ok(sanitizeSegment('x'.repeat(200)).length <= 60);
    });
});

describe('exportFolderName', () => {
    it('names the folder for the chat and the day', () => {
        const at = new Date(2026, 8, 2);
        assert.equal(
            exportFolderName('Weekend Photos', at),
            'export-Weekend-Photos-2026-09-02',
        );
    });

    it('uses the local day, not the UTC one', () => {
        // 23:30 local on the 2nd is the 3rd in UTC; the reader means the 2nd.
        const at = new Date(2026, 8, 2, 23, 30);
        assert.ok(exportFolderName('c', at).endsWith('2026-09-02'));
        assert.equal(localDateStamp(at), '2026-09-02');
    });
});

describe('extensionFor', () => {
    it("prefers the sender's own filename over the mime type", () => {
        const item = entry({
            type: 'video',
            fileName: 'holiday.mkv',
            mimeType: 'video/mp4',
        });
        assert.equal(extensionFor(item), 'mkv');
    });

    it('falls back to the mime type, ignoring parameters', () => {
        const item = entry({
            type: 'audio',
            mimeType: 'audio/ogg; codecs=opus',
        });
        assert.equal(extensionFor(item), 'ogg');
    });

    it('falls back to the kind when Telegram says nothing useful', () => {
        assert.equal(extensionFor(entry({ type: 'photo' })), 'jpg');
        assert.equal(extensionFor(entry({ type: 'voice' })), 'ogg');
        // Telegram's "gif" is a silent mp4.
        assert.equal(extensionFor(entry({ type: 'gif' })), 'mp4');
    });

    it('ignores a dot in a filename that is not an extension', () => {
        const item = entry({ type: 'video', fileName: 'clip.from.2019' });
        assert.equal(extensionFor(item), 'mp4');
    });
});

describe('mediaFileName', () => {
    it('leads with a padded message id so names sort in chat order', () => {
        const names = [
            mediaFileName(entry({ messageId: 9 })),
            mediaFileName(entry({ messageId: 100 })),
            mediaFileName(entry({ messageId: 1000 })),
        ];
        assert.deepEqual([...names].sort(), names);
        assert.ok(names[0].startsWith('0000009-'));
    });

    it('uses the filename without doubling its extension', () => {
        const name = mediaFileName(
            entry({ type: 'video', fileName: 'holiday.mp4' }),
        );
        assert.equal(name, '0001234-holiday.mp4');
    });

    it('names a track from its own tags when there is no filename', () => {
        const name = mediaFileName(
            entry({
                type: 'audio',
                audioPerformer: 'Nina Simone',
                audioTitle: 'Feeling Good',
                mimeType: 'audio/mpeg',
            }),
        );
        assert.equal(name, '0001234-Nina-Simone-Feeling-Good.mp3');
    });

    it('falls back to the kind when there is nothing to describe it', () => {
        assert.equal(mediaFileName(entry()), '0001234-photo.jpg');
    });

    it('gives two items from one album distinct names', () => {
        const a = mediaFileName(entry({ messageId: 10 }));
        const b = mediaFileName(entry({ messageId: 11 }));
        assert.notEqual(a, b);
    });

    it('puts files under media/', () => {
        assert.equal(mediaFilePath(entry()), 'media/0001234-photo.jpg');
    });
});

describe('selectForExport', () => {
    const all = { kinds: ['photo', 'video', 'gif', 'audio', 'voice'] } as const;

    it('includes media from chats that restrict saving', () => {
        const result = selectForExport([entry()], all);
        assert.equal(result.included.length, 1);
        assert.equal(result.skipped.length, 0);
    });

    it('drops kinds the dialog did not ask for', () => {
        const result = selectForExport(
            [entry({ type: 'photo' }), entry({ type: 'video' })],
            { kinds: ['photo'] },
        );
        assert.equal(result.included.length, 1);
        assert.equal(result.included[0].type, 'photo');
        assert.equal(result.skipped[0].reason, 'filtered');
    });

    it('reports a kind it cannot write as unsupported, not filtered', () => {
        const item = entry({ type: 'file' as never });
        const result = selectForExport([item], all);
        assert.equal(result.skipped[0].reason, 'unsupported');
    });

    it('keeps the bounds inclusive on both ends', () => {
        const items = [
            entry({ messageId: 1, date: '2026-03-03T12:00:00.000Z' }),
            entry({ messageId: 2, date: '2026-03-04T12:00:00.000Z' }),
            entry({ messageId: 3, date: '2026-03-05T12:00:00.000Z' }),
        ];
        const result = selectForExport(items, {
            kinds: ['photo'],
            since: '2026-03-04',
            until: '2026-03-05',
        });
        assert.deepEqual(
            result.included.map((item) => item.messageId),
            [2, 3],
        );
    });

    it('keeps an item whose date cannot be read rather than losing it', () => {
        const item = entry({ date: 'not a date' });
        const result = selectForExport([item], {
            kinds: ['photo'],
            since: '2026-01-01',
        });
        assert.equal(result.included.length, 1);
    });
});

describe('summarize', () => {
    it('adds up the sizes it was given', () => {
        const result = summarize([
            entry({ fileSize: 100 }),
            entry({ fileSize: 250 }),
        ]);
        assert.deepEqual(result, { items: 2, bytes: 350, partial: false });
    });

    it('flags the total as short when an item has no size', () => {
        const result = summarize([entry({ fileSize: 100 }), entry()]);
        assert.equal(result.bytes, 100);
        assert.equal(result.partial, true);
    });

    it('counts nothing as nothing', () => {
        assert.deepEqual(summarize([]), {
            items: 0,
            bytes: 0,
            partial: false,
        });
    });
});
