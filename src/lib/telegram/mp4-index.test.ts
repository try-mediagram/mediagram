import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { trailingIndexOffset } from './mp4-index.ts';

const MB = 1024 * 1024;

/** Top-level box headers only; the payloads are never read. */
function boxes(list: Array<[string, number]>, length = MB) {
    const head = new Uint8Array(length);
    const view = new DataView(head.buffer);
    let offset = 0;
    for (const [type, size] of list) {
        if (offset + 8 > length) break;
        view.setUint32(offset, size);
        for (let at = 0; at < 4; at++) {
            head[offset + 4 + at] = type.charCodeAt(at);
        }
        offset += size;
    }
    return head;
}

describe('trailingIndexOffset', () => {
    it('finds moov after mdat', () => {
        const head = boxes([
            ['ftyp', 32],
            ['free', 8],
            ['mdat', 30 * MB],
        ]);
        assert.equal(trailingIndexOffset(head, 31 * MB), 40 + 30 * MB);
    });

    it('says nothing for a fast-start file', () => {
        const head = boxes([
            ['ftyp', 32],
            ['moov', 4000],
            ['mdat', 30 * MB],
        ]);
        assert.equal(trailingIndexOffset(head, 31 * MB), null);
    });

    it('reads a 64-bit mdat size', () => {
        const head = boxes([['ftyp', 24]]);
        const view = new DataView(head.buffer);
        view.setUint32(24, 1);
        head.set([0x6d, 0x64, 0x61, 0x74], 28);
        view.setBigUint64(32, BigInt(5 * MB));
        assert.equal(trailingIndexOffset(head, 6 * MB), 24 + 5 * MB);
    });

    it('ignores what is not an MP4', () => {
        const head = new Uint8Array(MB).fill(0xff);
        assert.equal(trailingIndexOffset(head, 10 * MB), null);
    });

    it('ignores a file that fits in its head', () => {
        const head = boxes([['mdat', MB / 2]]);
        assert.equal(trailingIndexOffset(head, MB / 2 + 100), null);
    });
});
