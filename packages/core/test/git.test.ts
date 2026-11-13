import { describe, expect, it } from "vitest";
import { parseGitLog } from "../src/git/log";

const record = (fields: string[], numstat: string[] = []) =>
  `\x1e${fields.join("\x1f")}\n\n${numstat.join("\n")}\n`;
const a = "a".repeat(40);
const b = "b".repeat(40);
const m = "c".repeat(40);

describe("parseGitLog", () => {
  it("keeps the user's non-merge commits with subject, lines and binary files as 0", () => {
    const output = [
      record([
        m,
        `${a} ${b}`,
        "2026-03-02T10:35:00+01:00",
        "me@x.invalid",
        "Merge pull request #7 from x/y",
      ]),
      record(
        [b, a, "2026-03-02T10:30:00+00:00", "me@x.invalid", "feat: two \x1f odd"],
        ["2\t1\tc.txt", "-\t-\tbin.dat"],
      ),
      record([a, "", "2026-03-02T10:20:00Z", "other@x.invalid", "feat: other"], ["5\t0\tb.txt"]),
      "garbage\x1fonly",
    ].join("");
    expect(parseGitLog(output, "/synthetic/repo", "me@x.invalid")).toEqual({
      commits: [
        {
          repo: "/synthetic/repo",
          sha: b,
          authored_at: "2026-03-02T10:30:00.000Z",
          author: null,
          message: "feat: two \x1f odd",
          additions: 2,
          deletions: 1,
        },
      ],
      merges: [
        {
          sha: m,
          pullRequest: 7,
          firstParent: a,
          secondParent: b,
          authoredAt: "2026-03-02T09:35:00.000Z",
        },
      ],
    });
  });

  it("ignores merges that are not pull requests", () => {
    const output = record([
      m,
      `${a} ${b}`,
      "2026-03-02T10:35:00Z",
      "me@x.invalid",
      "Merge branch 'x'",
    ]);
    expect(parseGitLog(output, "/synthetic/repo", "me@x.invalid")).toEqual({
      commits: [],
      merges: [],
    });
  });
});
