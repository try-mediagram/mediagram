import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    ALBUM_MAX,
    CAPTION_MAX,
    chunkMessageIds,
    FILE_MAX,
    mediaClassOf,
    type PickedFile,
    planUpload,
    sendKindFor,
    TAG_BULK_MAX,
    type UploadPlanInput,
} from './plan.ts';

function file(over: Partial<PickedFile> = {}): PickedFile {
    return {
        id: 'f1',
        name: 'photo.jpg',
        size: 1000,
        type: 'image/jpeg',
        ...over,
    };
}

function photos(count: number): PickedFile[] {
    return Array.from({ length: count }, (_, index) =>
        file({ id: `p${index}`, name: `p${index}.jpg` }),
    );
}

function input(over: Partial<UploadPlanInput> = {}): UploadPlanInput {
    return {
        files: [file()],
        captionMode: 'none',
        sharedCaption: '',
        captions: {},
        delivery: 'album',
        ...over,
    };
}

describe('sendKindFor', () => {
    it('never sends a photo as a document, which is what auto would do', () => {
        assert.equal(sendKindFor(file({ type: 'image/jpeg' })), 'photo');
        assert.equal(sendKindFor(file({ type: 'image/png' })), 'photo');
    });

    it('sends a GIF as a document so Telegram keeps the animation', () => {
        assert.equal(
            sendKindFor(file({ name: 'cat.gif', type: 'image/gif' })),
            'document',
        );
    });

    it('reads video and audio from the mime type', () => {
        assert.equal(sendKindFor(file({ type: 'video/mp4' })), 'video');
        assert.equal(sendKindFor(file({ type: 'audio/mpeg' })), 'audio');
    });

    it('falls back to the extension when the browser reports no mime', () => {
        assert.equal(sendKindFor(file({ name: 'a.mov', type: '' })), 'video');
        assert.equal(sendKindFor(file({ name: 'a.flac', type: '' })), 'audio');
        assert.equal(sendKindFor(file({ name: 'a.png', type: '' })), 'photo');
    });

    it('treats anything it cannot place as a document', () => {
        assert.equal(
            sendKindFor(file({ name: 'a.xyz', type: '' })),
            'document',
        );
        assert.equal(
            sendKindFor(file({ name: 'noext', type: '' })),
            'document',
        );
    });

    it('ignores mime parameters', () => {
        assert.equal(
            sendKindFor(file({ type: 'video/mp4; codecs=avc1' })),
            'video',
        );
    });
});

describe('mediaClassOf', () => {
    it('lets photos and video share an album, and nothing else', () => {
        assert.equal(mediaClassOf('photo'), 'visual');
        assert.equal(mediaClassOf('video'), 'visual');
        assert.equal(mediaClassOf('audio'), 'audio');
        assert.equal(mediaClassOf('document'), 'document');
    });
});

describe('planUpload — grouping', () => {
    it('puts one album in one message', () => {
        const plan = planUpload(input({ files: photos(4) }));
        assert.equal(plan.batches.length, 1);
        assert.equal(plan.batches[0].items.length, 4);
        assert.equal(plan.messages, 1);
    });

    it('never builds an album larger than Telegram accepts', () => {
        const plan = planUpload(input({ files: photos(23) }));
        assert.equal(plan.batches.length, 3);
        assert.deepEqual(
            plan.batches.map((batch) => batch.items.length),
            [ALBUM_MAX, ALBUM_MAX, 3],
        );
    });

    it('does not mix families Telegram refuses to group', () => {
        const files = [
            file({ id: 'a', name: 'a.jpg', type: 'image/jpeg' }),
            file({ id: 'b', name: 'b.pdf', type: 'application/pdf' }),
            file({ id: 'c', name: 'c.mp4', type: 'video/mp4' }),
            file({ id: 'd', name: 'd.mp3', type: 'audio/mpeg' }),
        ];
        const plan = planUpload(input({ files }));

        // visual (a, c), document (b), audio (d)
        assert.equal(plan.batches.length, 3);
        assert.deepEqual(
            plan.batches[0].items.map((item) => item.fileId),
            ['a', 'c'],
        );
        assert.deepEqual(
            plan.batches[1].items.map((item) => item.fileId),
            ['b'],
        );
        assert.deepEqual(
            plan.batches[2].items.map((item) => item.fileId),
            ['d'],
        );
    });

    it('gives every file its own message when asked to send separately', () => {
        const plan = planUpload(
            input({ files: photos(4), delivery: 'separate' }),
        );
        assert.equal(plan.batches.length, 4);
        assert.ok(plan.batches.every((batch) => batch.items.length === 1));
    });

    it('keeps the picked order when sending separately', () => {
        const files = [
            file({ id: 'a', name: 'a.pdf', type: 'application/pdf' }),
            file({ id: 'b', name: 'b.jpg', type: 'image/jpeg' }),
        ];
        const plan = planUpload(input({ files, delivery: 'separate' }));
        assert.deepEqual(
            plan.batches.map((batch) => batch.items[0].fileId),
            ['a', 'b'],
        );
    });
});

describe('planUpload — captions', () => {
    it('sends nothing when the mode is none', () => {
        const plan = planUpload(
            input({
                files: photos(3),
                captionMode: 'none',
                sharedCaption: 'ignored',
            }),
        );
        assert.ok(
            plan.batches[0].items.every((item) => item.caption === undefined),
        );
    });

    it('puts a shared caption on the first item of an album only', () => {
        const plan = planUpload(
            input({
                files: photos(3),
                captionMode: 'shared',
                sharedCaption: 'Weekend',
            }),
        );
        const captions = plan.batches[0].items.map((item) => item.caption);
        assert.deepEqual(captions, ['Weekend', undefined, undefined]);
    });

    it('repeats a shared caption once per message when sending separately', () => {
        const plan = planUpload(
            input({
                files: photos(3),
                captionMode: 'shared',
                sharedCaption: 'Weekend',
                delivery: 'separate',
            }),
        );
        assert.deepEqual(
            plan.batches.map((batch) => batch.items[0].caption),
            ['Weekend', 'Weekend', 'Weekend'],
        );
    });

    it('captions every item in an album when each has its own', () => {
        const files = photos(2);
        const plan = planUpload(
            input({
                files,
                captionMode: 'each',
                captions: { p0: 'first', p1: 'second' },
            }),
        );
        assert.deepEqual(
            plan.batches[0].items.map((item) => item.caption),
            ['first', 'second'],
        );
    });

    it('leaves an item uncaptioned when its own box was left blank', () => {
        const plan = planUpload(
            input({
                files: photos(2),
                captionMode: 'each',
                captions: { p0: 'first', p1: '   ' },
            }),
        );
        assert.deepEqual(
            plan.batches[0].items.map((item) => item.caption),
            ['first', undefined],
        );
    });
});

describe('planUpload — limits', () => {
    it('drops a file too large to upload but keeps the rest', () => {
        const files = [
            file({ id: 'big', size: FILE_MAX + 1 }),
            file({ id: 'ok', size: 10 }),
        ];
        const plan = planUpload(input({ files }));

        assert.equal(plan.files, 1);
        assert.deepEqual(
            plan.batches[0].items.map((item) => item.fileId),
            ['ok'],
        );
        assert.deepEqual(plan.issues, [
            { kind: 'too-large', fileId: 'big', limit: FILE_MAX },
        ]);
    });

    it('does not block the send just because one file was too large', () => {
        const files = [
            file({ id: 'big', size: FILE_MAX + 1 }),
            file({ id: 'ok', size: 10 }),
        ];
        assert.equal(planUpload(input({ files })).blocked, false);
    });

    it('blocks on a caption too long rather than truncating it', () => {
        const plan = planUpload(
            input({
                captionMode: 'shared',
                sharedCaption: 'x'.repeat(CAPTION_MAX + 1),
            }),
        );
        assert.equal(plan.blocked, true);
        assert.equal(plan.issues[0].kind, 'caption-too-long');
    });

    it('names the file whose own caption is too long', () => {
        const plan = planUpload(
            input({
                files: photos(2),
                captionMode: 'each',
                captions: { p1: 'x'.repeat(CAPTION_MAX + 1) },
            }),
        );
        assert.deepEqual(plan.issues, [
            { kind: 'caption-too-long', fileId: 'p1', limit: CAPTION_MAX },
        ]);
    });

    it('reports an empty selection and sends nothing', () => {
        const plan = planUpload(input({ files: [] }));
        assert.deepEqual(plan.issues, [{ kind: 'empty' }]);
        assert.equal(plan.batches.length, 0);
        assert.equal(plan.blocked, true);
    });

    it('counts what will be sent', () => {
        const files = [
            file({ id: 'a', size: 100 }),
            file({ id: 'b', size: 250 }),
        ];
        const plan = planUpload(input({ files }));
        assert.equal(plan.files, 2);
        assert.equal(plan.bytes, 350);
        assert.equal(plan.messages, 1);
    });
});

describe('chunkMessageIds', () => {
    it('sends one request when everything fits', () => {
        assert.deepEqual(chunkMessageIds([1, 2, 3]), [[1, 2, 3]]);
    });

    it('cuts at the bulk ceiling, keeping every id exactly once', () => {
        const ids = Array.from({ length: TAG_BULK_MAX * 2 + 7 }, (_, i) => i);
        const chunks = chunkMessageIds(ids);

        assert.equal(chunks.length, 3);
        assert.equal(chunks[0].length, TAG_BULK_MAX);
        assert.equal(chunks[1].length, TAG_BULK_MAX);
        assert.equal(chunks[2].length, 7);
        assert.deepEqual(chunks.flat(), ids);
    });

    it('is nothing at all for an empty run', () => {
        // A cancelled upload that landed nothing must make no request, not one
        // with an empty array the server would reject.
        assert.deepEqual(chunkMessageIds([]), []);
    });

    it('never loops forever on a nonsense size', () => {
        assert.deepEqual(chunkMessageIds([1, 2], 0), [[1], [2]]);
    });
});
