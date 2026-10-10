/**
 * Where an MP4's `moov` box starts when it comes after `mdat`, read off the
 * top-level box headers in the first window; null when the index is already
 * in the head (a "fast start" file) or the file is not an MP4.
 */
export function trailingIndexOffset(head: Uint8Array, fileSize: number) {
    // A file of one window is fetched whole with its head anyway.
    if (fileSize <= head.byteLength) return null;
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let offset = 0;
    while (offset + 8 <= head.byteLength) {
        let size = view.getUint32(offset);
        const type = String.fromCharCode(
            head[offset + 4],
            head[offset + 5],
            head[offset + 6],
            head[offset + 7],
        );
        if (!/^[\x20-\x7e]{4}$/.test(type)) return null;
        if (type === 'moov') return null;
        if (size === 1) {
            if (offset + 16 > head.byteLength) return null;
            size = Number(view.getBigUint64(offset + 8));
        } else if (size === 0) {
            return null;
        }
        if (size < 8) return null;
        const next = offset + size;
        if (type === 'mdat') return next < fileSize ? next : null;
        offset = next;
    }
    return null;
}
