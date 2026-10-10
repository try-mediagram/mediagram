import { useSyncExternalStore } from 'react';

/**
 * The chat's sounds, made rather than shipped.
 *
 * A short synthesised chime needs no asset, no decoding and no network, and it
 * plays the same in the browser and in the Tauri shell. Three cues: a message
 * arriving in the chat you are reading (soft), one arriving anywhere else
 * (brighter, two notes), and your own message leaving.
 */

export type SoundCue = 'incoming' | 'background' | 'sent';

export type SoundSettings = {
    enabled: boolean;
    /** 0–1. */
    volume: number;
};

const SETTINGS_KEY = 'mediagram:sounds';
const DEFAULTS: SoundSettings = { enabled: true, volume: 0.6 };

/** Bursts closer than this are one sound: twenty messages are not twenty dings. */
const MIN_GAP_MS = 900;

let settings: SoundSettings = readSettings();
const subscribers = new Set<() => void>();
let context: AudioContext | null = null;
let lastPlayed = 0;

function readSettings(): SoundSettings {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return DEFAULTS;
        const parsed = JSON.parse(raw) as Partial<SoundSettings>;
        return {
            enabled:
                typeof parsed.enabled === 'boolean'
                    ? parsed.enabled
                    : DEFAULTS.enabled,
            volume:
                typeof parsed.volume === 'number'
                    ? Math.min(1, Math.max(0, parsed.volume))
                    : DEFAULTS.volume,
        };
    } catch {
        return DEFAULTS;
    }
}

export function getSoundSettings(): SoundSettings {
    return settings;
}

export function setSoundSettings(next: Partial<SoundSettings>): void {
    settings = { ...settings, ...next };
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
        // Private mode: the choice lasts for this tab only.
    }
    for (const notify of subscribers) notify();
}

export function useSoundSettings(): SoundSettings {
    return useSyncExternalStore(
        (notify) => {
            subscribers.add(notify);
            return () => subscribers.delete(notify);
        },
        getSoundSettings,
        getSoundSettings,
    );
}

function audio(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
    if (!Ctor) return null;
    context ??= new Ctor();
    // Browsers start a context suspended until the page has been touched.
    if (context.state === 'suspended') void context.resume();
    return context;
}

/** Notes per cue, as [frequency Hz, start s, length s]. */
const CUES: Record<SoundCue, Array<[number, number, number]>> = {
    incoming: [[880, 0, 0.16]],
    background: [
        [784, 0, 0.14],
        [1175, 0.11, 0.22],
    ],
    sent: [[1320, 0, 0.07]],
};

/** Play a cue, unless sounds are off or one just played. */
export function playSound(cue: SoundCue, { force = false } = {}): void {
    if (!settings.enabled && !force) return;
    const now = Date.now();
    if (!force && now - lastPlayed < MIN_GAP_MS) return;
    lastPlayed = now;

    const ctx = audio();
    if (!ctx) return;

    const level = cue === 'sent' ? settings.volume * 0.4 : settings.volume;
    const at = ctx.currentTime;

    for (const [frequency, start, length] of CUES[cue]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = frequency;
        gain.gain.setValueAtTime(0, at + start);
        gain.gain.linearRampToValueAtTime(level * 0.35, at + start + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + start + length);
        osc.connect(gain).connect(ctx.destination);
        osc.start(at + start);
        osc.stop(at + start + length + 0.02);
    }
}
