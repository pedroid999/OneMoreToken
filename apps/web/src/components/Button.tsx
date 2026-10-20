import type { ButtonHTMLAttributes, MouseEvent } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed"> {
  variant?: ButtonVariant;
  /** Keeps the button focusable but inert and announces aria-busy. */
  loading?: boolean;
  /** Toggle buttons expose their state with aria-pressed. */
  pressed?: boolean;
}

export function Button({
  variant = "secondary",
  loading = false,
  pressed,
  type = "button",
  className,
  onClick,
  children,
  ...rest
}: ButtonProps) {
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (loading) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
  return (
    <button
      {...rest}
      type={type}
      className={className ? `button ${className}` : "button"}
      data-variant={variant}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      aria-pressed={pressed}
      onClick={handleClick}
    >
      {loading ? <span className="button__spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
