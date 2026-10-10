import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    buildIndexHtml,
    buildMessagesJson,
    escapeHtml,
    type ExportedFile,
    type TranscriptInput,
    type TranscriptMessage,
} from './transcript.ts';

function message(over: Partial<TranscriptMessage> = {}): TranscriptMessage {
    return {
        id: 10,
        date: '2026-03-04T10:00:00.000Z',
        senderName: 'Ada',
        text: 'hello',
        kind: 'text',
        isOutgoing: false,
        reactions: [],
        ...over,
    };
}

function input(over: Partial<TranscriptInput> = {}): TranscriptInput {
    return {
        chat: { id: -100123, title: 'Weekend' },
        messages: [message()],
        files: new Map<number, ExportedFile>(),
        exportedAt: new Date(2026, 8, 2),
        ...over,
    };
}

describe('escapeHtml', () => {
    it('escapes every character that could close a tag or an attribute', () => {
        assert.equal(
            escapeHtml(`<script>&"'`),
            '&lt;script&gt;&amp;&quot;&#39;',
        );
    });

    it('escapes the ampersand first so entities are not doubled wrongly', () => {
        assert.equal(escapeHtml('&lt;'), '&amp;lt;');
    });
});

describe('buildIndexHtml', () => {
    it('never lets message text reach the page as markup', () => {
        const html = buildIndexHtml(
            input({
                messages: [message({ text: '<img src=x onerror=alert(1)>' })],
            }),
        );
        assert.ok(!html.includes('<img src=x'));
        assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    });

    it('escapes a sender name and the chat title too', () => {
        const html = buildIndexHtml(
            input({
                chat: { id: 1, title: '</title><script>' },
                messages: [message({ senderName: '<b>Ada</b>' })],
            }),
        );
        assert.ok(!html.includes('</title><script>'));
        assert.ok(html.includes('&lt;b&gt;Ada&lt;/b&gt;'));
    });

    it('links a written file and shows the media inline', () => {
        const files = new Map<number, ExportedFile>([
            [10, { status: 'written', path: 'media/0000010-photo.jpg' }],
        ]);
        const html = buildIndexHtml(
            input({ messages: [message({ kind: 'photo' })], files }),
        );
        assert.ok(html.includes('<img src="media/0000010-photo.jpg"'));
    });

    it('plays a video with controls rather than embedding it as an image', () => {
        const files = new Map<number, ExportedFile>([
            [10, { status: 'written', path: 'media/0000010-clip.mp4' }],
        ]);
        const html = buildIndexHtml(
            input({ messages: [message({ kind: 'video' })], files }),
        );
        assert.ok(
            html.includes('<video class="media" src="media/0000010-clip.mp4"'),
        );
        assert.ok(html.includes('controls'));
    });

    it('reports a failed download with its reason', () => {
        const files = new Map<number, ExportedFile>([
            [10, { status: 'failed', reason: 'Connection lost.' }],
        ]);
        const html = buildIndexHtml(
            input({ messages: [message({ kind: 'photo' })], files }),
        );
        assert.ok(html.includes('Could not be downloaded.'));
        assert.ok(html.includes('Connection lost.'));
    });

    it('writes one avatar rule per sender, not one per message', () => {
        const avatar = 'data:image/jpeg;base64,AAAA';
        const messages = [
            message({ id: 1, senderId: 7, senderAvatarPreview: avatar }),
            message({ id: 2, senderId: 7, senderAvatarPreview: avatar }),
            message({ id: 3, senderId: 7, senderAvatarPreview: avatar }),
        ];
        const html = buildIndexHtml(input({ messages }));
        const occurrences = html.split(avatar).length - 1;
        assert.equal(occurrences, 1);
        assert.equal(html.split('class="avatar av-1"').length - 1, 3);
    });

    it('falls back to initials when a sender has no photo', () => {
        const html = buildIndexHtml(
            input({ messages: [message({ senderName: 'Ada Lovelace' })] }),
        );
        assert.ok(html.includes('>AL</div>'));
    });

    it('breaks the transcript into days once per day', () => {
        const messages = [
            message({ id: 1, date: '2026-03-04T10:00:00.000Z' }),
            message({ id: 2, date: '2026-03-04T11:00:00.000Z' }),
            message({ id: 3, date: '2026-03-06T11:00:00.000Z' }),
        ];
        const html = buildIndexHtml(input({ messages }));
        assert.equal(html.split('class="day"').length - 1, 2);
    });

    it('renders reactions with their counts', () => {
        const messages = [message({ reactions: [{ emoji: '❤', count: 3 }] })];
        const html = buildIndexHtml(input({ messages }));
        assert.ok(html.includes('❤ 3'));
    });

    it('is a complete document so it opens straight off the disk', () => {
        const html = buildIndexHtml(input());
        assert.ok(html.startsWith('<!doctype html>'));
        assert.ok(html.includes('<meta charset="utf-8">'));
        assert.ok(html.trimEnd().endsWith('</html>'));
    });
});

describe('buildMessagesJson', () => {
    it('is valid JSON carrying every message', () => {
        const messages = [message({ id: 1 }), message({ id: 2 })];
        const parsed = JSON.parse(buildMessagesJson(input({ messages })));
        assert.equal(parsed.messageCount, 2);
        assert.equal(parsed.messages.length, 2);
        assert.equal(parsed.chat.title, 'Weekend');
    });

    it('records where a file landed', () => {
        const files = new Map<number, ExportedFile>([
            [10, { status: 'written', path: 'media/0000010-photo.jpg' }],
        ]);
        const parsed = JSON.parse(buildMessagesJson(input({ files })));
        assert.deepEqual(parsed.messages[0].media, {
            status: 'written',
            path: 'media/0000010-photo.jpg',
            reason: null,
        });
    });

    it('leaves media null for a message that had none', () => {
        const parsed = JSON.parse(buildMessagesJson(input()));
        assert.equal(parsed.messages[0].media, null);
    });

    it('keeps avatars out, so the file does not balloon with base64', () => {
        const avatar = 'data:image/jpeg;base64,AAAA';
        const json = buildMessagesJson(
            input({ messages: [message({ senderAvatarPreview: avatar })] }),
        );
        assert.ok(!json.includes(avatar));
    });

    it('does not need escaping to survive a round trip', () => {
        const text = '</script>"\'\\ ❤';
        const parsed = JSON.parse(
            buildMessagesJson(input({ messages: [message({ text })] })),
        );
        assert.equal(parsed.messages[0].text, text);
    });
});
