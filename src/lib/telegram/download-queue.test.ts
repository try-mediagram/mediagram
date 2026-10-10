import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDownloadQueue } from './download-queue.ts';

/** A job that runs until released, recording when it started. */
function gate(log: string[], name: string) {
    let open = () => {};
    const done = new Promise<void>((resolve) => {
        open = resolve;
    });
    return {
        work: async () => {
            log.push(name);
            await done;
            return name;
        },
        open: () => open(),
    };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('createDownloadQueue', () => {
    it('keeps background work to its share of the slots', async () => {
        const queue = createDownloadQueue(4, 2);
        const log: string[] = [];
        const jobs = ['a', 'b', 'c'].map((name) => gate(log, name));
        const runs = jobs.map((job, at) =>
            queue.run(job.work, false, `bg${at}`),
        );
        await tick();
        assert.deepEqual(log, ['a', 'b']);
        for (const job of jobs) job.open();
        await Promise.all(runs);
        assert.deepEqual(log, ['a', 'b', 'c']);
        assert.equal(queue.busy(), 0);
    });

    it('lets urgent work past a full background share', async () => {
        const queue = createDownloadQueue(4, 2);
        const log: string[] = [];
        const bg = ['a', 'b', 'c'].map((name) => gate(log, name));
        bg.forEach((job, at) => void queue.run(job.work, false, `bg${at}`));
        const urgent = gate(log, 'u');
        void queue.run(urgent.work, true, 'u');
        await tick();
        assert.deepEqual(log, ['a', 'b', 'u']);
    });

    it('serves waiting urgent work before waiting background work', async () => {
        const queue = createDownloadQueue(2, 1);
        const log: string[] = [];
        const first = gate(log, 'u1');
        const second = gate(log, 'u2');
        void queue.run(first.work, true, 'u1');
        void queue.run(second.work, true, 'u2');
        const bg = gate(log, 'bg');
        const late = gate(log, 'u3');
        void queue.run(bg.work, false, 'bg');
        void queue.run(late.work, true, 'u3');
        await tick();
        first.open();
        await tick();
        assert.deepEqual(log, ['u1', 'u2', 'u3']);
    });

    it('promotes a parked background job the player now needs', async () => {
        const queue = createDownloadQueue(4, 2);
        const log: string[] = [];
        const bg = ['a', 'b', 'c'].map((name) => gate(log, name));
        bg.forEach((job, at) => void queue.run(job.work, false, `w${at}`));
        await tick();
        assert.deepEqual(log, ['a', 'b']);
        queue.promote('w2');
        await tick();
        assert.deepEqual(log, ['a', 'b', 'c']);
        assert.equal(queue.busy(), 3);
    });

    it('frees the slot when work fails', async () => {
        const queue = createDownloadQueue(1, 1);
        await assert.rejects(
            queue.run(() => Promise.reject(new Error('x')), true, 'k'),
        );
        assert.equal(await queue.run(async () => 'ok', true, 'k'), 'ok');
        assert.equal(queue.busy(), 0);
    });
});
