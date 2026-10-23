import type { MouseEvent, ReactNode } from "react";
import { useLocation } from "../router";
import { type SessionAgent, sessionSearch } from "./state";

export interface SessionLinkProps {
  /** Query changes; period and every other parameter are kept (spec §8.1). */
  patch: { id?: string | undefined; agent?: SessionAgent | undefined };
  className?: string;
  children: ReactNode;
}

/** In-app link to /session. Unlike Link, it rewrites the query instead of copying it. */
export function SessionLink({ patch, className, children }: SessionLinkProps) {
  const { search } = useLocation();
  const href = `/session${sessionSearch(search, patch)}`;
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
    if (event.defaultPrevented || event.button !== 0 || modified) return;
    event.preventDefault();
    window.history.pushState(null, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  return (
    <a href={href} className={className} onClick={onClick}>
      {children}
    </a>
  );
}
