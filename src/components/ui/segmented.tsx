import { cn } from "@/lib/utils";

export type SegmentedOption<T extends string> = {
	value: T;
	label: string;
	title?: string;
	disabled?: boolean;
};

/**
 * A one-of-many control.
 *
 * The chosen option is marked with colour and weight rather than elevation.
 * That is not a style preference: --background is the darkest colour in the
 * dark theme, so a "raised" chip would be darker than the track it sits on and
 * read as a hole punched through the control. Colour works the same way in
 * both themes, and weight gives a second cue that survives colour blindness.
 *
 * The track is deliberately almost invisible — it exists to say "these belong
 * together and only one can win", not to draw a slab across the page.
 */
export function Segmented<T extends string>({
	value,
	onChange,
	options,
	className,
}: {
	value: T;
	onChange: (value: T) => void;
	options: SegmentedOption<T>[];
	className?: string;
}) {
	return (
		<div
			className={cn(
				"ring-border/60 inline-flex max-w-full flex-wrap gap-0.5 rounded-lg bg-muted/60 p-1 ring-1 ring-inset",
				className,
			)}
		>
			{options.map((option) => {
				const active = option.value === value;
				return (
					<button
						key={option.value}
						type="button"
						aria-pressed={active}
						disabled={option.disabled}
						title={option.title}
						onClick={() => onChange(option.value)}
						className={cn(
							"h-7 rounded-md px-2.5 text-sm transition-colors duration-150",
							"outline-none focus-visible:ring-2 focus-visible:ring-ring",
							"disabled:pointer-events-none disabled:opacity-40",
							active
								? "bg-accent text-accent-foreground ring-border font-medium ring-1 ring-inset"
								: "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground font-medium",
						)}
					>
						{option.label}
					</button>
				);
			})}
		</div>
	);
}
