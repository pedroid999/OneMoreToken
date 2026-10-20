import { type KeyboardEvent, useRef } from "react";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  /** Accessible name of the group, already translated. */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}

const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** Radio group with a roving tabindex: Tab enters on the checked option, arrows move it. */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const select = (index: number) => {
    const option = options[index];
    if (!option) return;
    refs.current[index]?.focus();
    if (option.value !== value) onChange(option.value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = options.length - 1;
    let next: number | undefined;
    const step = STEP[event.key];
    if (step !== undefined) next = (index + step + options.length) % options.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next === undefined) return;
    event.preventDefault();
    select(next);
  };

  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA APG radio group pattern; buttons keep the segmented styling and the tested roving tabindex
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            className="segmented__option"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            onClick={() => select(index)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
