import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { navigate } from "../router";

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  /** Path inside the app; the current query string (filters, range) is kept. */
  to: string;
  current?: boolean;
}

export function Link({ to, current = false, onClick, className, children, ...rest }: LinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
    if (event.defaultPrevented || event.button !== 0 || modified) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a
      {...rest}
      href={`${to}${window.location.search}`}
      className={className}
      aria-current={current ? "page" : undefined}
      onClick={handleClick}
    >
      {children}
    </a>
  );
}
