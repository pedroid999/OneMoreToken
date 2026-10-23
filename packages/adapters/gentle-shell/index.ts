import type { SourceParser } from "@omt/core";
import { parsePi } from "../pi";

export const GENTLE_SHELL_ADAPTER_VERSION = "gentle-shell-v3/2";
export const parseGentleShell: SourceParser = (content, context) => parsePi(content, context);
