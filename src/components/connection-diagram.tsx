/**
 * How Mediagram actually works, drawn to scale with the truth.
 *
 * The whole product rests on one architectural fact: media moves between
 * Telegram and the browser and never passes through a Mediagram server. That
 * is a claim worth drawing rather than asserting — the thick live link is the
 * media path, and Mediagram hangs off to the side on a hairline, carrying only
 * an account and some tags.
 *
 * The travelling dashes are the page's one authored motion, and they stop for
 * anyone who has asked for reduced motion.
 */
export function ConnectionDiagram() {
    return (
        <svg
            viewBox="0 0 620 250"
            className="h-auto w-full"
            role="img"
            aria-labelledby="connection-diagram-title"
        >
            <title id="connection-diagram-title">
                Photos and video travel directly between Telegram and your
                browser. Mediagram's server is off to the side, holding only
                your account and your tags.
            </title>

            {/* The media path. Two strokes: a dim rail, and the dashes that
                travel along it. */}
            <line
                x1="150"
                y1="62"
                x2="470"
                y2="62"
                className="stroke-border"
                strokeWidth="2"
            />
            <line
                x1="150"
                y1="62"
                x2="470"
                y2="62"
                className="stroke-brand diagram-flow"
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray="2 14"
            />

            <Node x={80} y={62} label="Telegram" />
            <Node x={540} y={62} label="Your browser" accent />

            <text
                x="310"
                y="40"
                textAnchor="middle"
                className="fill-foreground font-sans text-[15px] font-semibold"
            >
                Every photo and video
            </text>
            <text
                x="310"
                y="88"
                textAnchor="middle"
                className="fill-muted-foreground font-sans text-[13px]"
            >
                over MTProto, in the tab
            </text>

            {/* Mediagram's own link: thin, dashed, and going nowhere near the
                media path. */}
            <path
                d="M540 92 L540 170 Q540 182 528 182 L360 182"
                fill="none"
                className="stroke-border"
                strokeWidth="1.5"
                strokeDasharray="4 5"
            />
            <Node x={290} y={182} label="Mediagram" muted />
            <text
                x="452"
                y="204"
                textAnchor="middle"
                className="fill-muted-foreground font-sans text-[13px]"
            >
                your account and your tags
            </text>
        </svg>
    );
}

function Node({
    x,
    y,
    label,
    accent = false,
    muted = false,
}: {
    x: number;
    y: number;
    label: string;
    accent?: boolean;
    muted?: boolean;
}) {
    return (
        <g>
            <rect
                x={x - 70}
                y={y - 21}
                width="140"
                height="42"
                rx="12"
                className={
                    accent
                        ? 'fill-accent stroke-brand'
                        : muted
                          ? 'fill-background stroke-border'
                          : 'fill-card stroke-border'
                }
                strokeWidth="1.5"
            />
            <text
                x={x}
                y={y + 5}
                textAnchor="middle"
                className={
                    accent
                        ? 'fill-foreground font-sans text-[14px] font-semibold'
                        : muted
                          ? 'fill-muted-foreground font-sans text-[14px]'
                          : 'fill-foreground font-sans text-[14px] font-semibold'
                }
            >
                {label}
            </text>
        </g>
    );
}
