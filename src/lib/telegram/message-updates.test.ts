import assert from 'node:assert/strict';
import { test } from 'node:test';

import { markedPeerId, messageEventsFrom } from './message-updates.ts';

test('marks peers the way the rest of the app does', () => {
    assert.equal(markedPeerId({ _: 'peerUser', userId: 42 }), 42);
    assert.equal(markedPeerId({ _: 'peerChat', chatId: 42 }), -42);
    assert.equal(
        markedPeerId({ _: 'peerChannel', channelId: 42 }),
        -1_000_000_000_042,
    );
    assert.equal(markedPeerId(null), null);
});

test('reads a private short message', () => {
    assert.deepEqual(
        messageEventsFrom({
            _: 'updateShortMessage',
            userId: 7,
            id: 100,
            message: 'hi',
            out: false,
        }),
        [
            {
                type: 'new',
                chatId: 7,
                messageId: 100,
                outgoing: false,
                text: 'hi',
                silent: false,
                mentioned: false,
            },
        ],
    );
});

test('reads a basic group short message as a negative id', () => {
    const [event] = messageEventsFrom({
        _: 'updateShortChatMessage',
        chatId: 9,
        fromId: 7,
        id: 5,
        message: 'yo',
        out: true,
    });
    assert.equal(event?.type, 'new');
    assert.equal(event?.type === 'new' && event.chatId, -9);
    assert.equal(event?.type === 'new' && event.outgoing, true);
});

test('unpacks a batch of channel messages, edits and deletes', () => {
    const events = messageEventsFrom({
        _: 'updates',
        updates: [
            {
                _: 'updateNewChannelMessage',
                message: {
                    _: 'message',
                    id: 3,
                    peerId: { _: 'peerChannel', channelId: 1 },
                    message: 'post',
                    silent: true,
                },
            },
            {
                _: 'updateEditChannelMessage',
                message: {
                    _: 'message',
                    id: 2,
                    peerId: { _: 'peerChannel', channelId: 1 },
                },
            },
            { _: 'updateDeleteChannelMessages', channelId: 1, messages: [1] },
            { _: 'updateDeleteMessages', messages: [8, 9] },
            { _: 'updateUserTyping' },
        ],
    });

    assert.deepEqual(
        events.map((event) => event.type),
        ['new', 'edit', 'delete', 'delete'],
    );
    const [post] = events;
    assert.equal(post?.type === 'new' && post.silent, true);
    assert.equal(post?.type === 'new' && post.chatId, -1_000_000_000_001);
    const last = events[3];
    assert.equal(last?.type === 'delete' && last.chatId, null);
});

test('ignores service messages and unrelated pushes', () => {
    assert.deepEqual(
        messageEventsFrom({
            _: 'updateShort',
            update: {
                _: 'updateNewMessage',
                message: { _: 'messageService', id: 1 },
            },
        }),
        [],
    );
    assert.deepEqual(messageEventsFrom({ _: 'updatesTooLong' }), []);
});

test('reads the other side typing in a private chat', () => {
    assert.deepEqual(
        messageEventsFrom({
            _: 'updateShort',
            update: {
                _: 'updateUserTyping',
                userId: 7,
                action: { _: 'sendMessageTypingAction' },
            },
        }),
        [{ type: 'typing', chatId: 7, userId: 7, action: 'typing' }],
    );
});

test('reads a cancel as typing stopped, and names voice recording', () => {
    const [stopped] = messageEventsFrom({
        _: 'updateShort',
        update: {
            _: 'updateUserTyping',
            userId: 7,
            action: { _: 'sendMessageCancelAction' },
        },
    });
    assert.equal(stopped?.type === 'typing' && stopped.action, null);

    const [recording] = messageEventsFrom({
        _: 'updateShort',
        update: {
            _: 'updateChannelUserTyping',
            channelId: 42,
            fromId: { _: 'peerUser', userId: 9 },
            action: { _: 'sendMessageRecordAudioAction' },
        },
    });
    assert.deepEqual(recording, {
        type: 'typing',
        chatId: -1_000_000_000_042,
        userId: 9,
        action: 'recording-voice',
    });
});
