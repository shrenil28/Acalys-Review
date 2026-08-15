/**
 * A small, closed glob dialect for path instructions (P0.txt §40, §64).
 *
 * This is deliberately **not** a full glob implementation and deliberately not
 * a dependency. Path instructions decide which review rules apply to a file,
 * so the failure mode of a mismatch is not "no result" — it is *the wrong
 * rules applied to the wrong code, silently*. A pattern the platform does not
 * fully understand must therefore be **rejected at authoring time**, never
 * approximated at match time.
 *
 * A third-party matcher gives the opposite trade: it accepts everything and
 * quietly picks an interpretation. Two libraries disagree about `**`, about
 * whether `*` crosses a slash, about `[!a-z]` versus `[^a-z]` — and swapping
 * one for another would change which rules apply to which files without any
 * contract changing. A closed dialect the platform owns cannot drift.
 *
 * # Supported
 *
 * | Syntax | Matches |
 * | --- | --- |
 * | `*` | any run of characters within one segment, never `/` |
 * | `?` | exactly one character, never `/` |
 * | `**` | zero or more whole segments (as a complete segment only) |
 * | `{a,b}` | alternation, expanded before compiling |
 *
 * # Rejected, with a message naming the syntax
 *
 * `[abc]` character classes, `!` negation, `\` escapes, `a**b` (a `**` that is
 * not a whole segment), absolute patterns, `.`/`..` segments, empty segments.
 * Every one of these is something another glob dialect *does* support, which
 * is exactly why silently ignoring them would be dangerous.
 *
 * Matching is case-sensitive: Git paths are.
 */

import { z } from "zod";
import { unsafeBrand, type Brand } from "../primitives/brand.js";
import { TEXT_LIMITS } from "../primitives/limits.js";
import { quoteValue } from "../primitives/format.js";

/** A validated pattern in the dialect above. */
export type GlobPattern = Brand<string, "GlobPattern">;

/**
 * Cap on brace expansion.
 *
 * `{a,b}{c,d}{e,f}…` multiplies, so an unbounded expansion is a denial of
 * service written in eight characters. 64 is far more than any real
 * instruction needs and far less than any expansion that could hurt.
 */
export const MAX_GLOB_EXPANSIONS = 64;

/** Thrown when a pattern uses syntax outside the supported dialect. */
export class GlobSyntaxError extends Error {
  public override readonly name = "GlobSyntaxError";

  public constructor(
    public readonly pattern: string,
    reason: string,
  ) {
    super(`Invalid glob ${quoteValue(pattern)}: ${reason}`);
  }
}

// A NUL byte truncates the string in any C-based syscall, so a pattern
// carrying one can pass this check and then be interpreted differently
// downstream. Matching control characters is the entire purpose here.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

/** Characters that are regex-special and carry no meaning in this dialect. */
const REGEX_SPECIALS = /[.+^$|()\-\][]/g;

function escapeLiteral(text: string): string {
  return text.replace(REGEX_SPECIALS, "\\$&");
}

/**
 * Expands `{a,b}` alternation into concrete patterns.
 *
 * Done before compiling rather than as a regex group, because the expansion is
 * also what {@link globSpecificity} scores — `src/{a,b}.ts` is two patterns
 * with two literal segments each, not one pattern with a wildcard segment.
 */
export function expandBraces(pattern: string): readonly string[] {
  const open = pattern.indexOf("{");
  if (open === -1) {
    if (pattern.includes("}")) {
      throw new GlobSyntaxError(pattern, "unbalanced '}'");
    }
    return [pattern];
  }

  let depth = 0;
  let close = -1;
  const alternatives: string[] = [];
  let current = "";

  for (let index = open; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "{") {
      depth += 1;
      if (depth === 1) continue;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        alternatives.push(current);
        break;
      }
    } else if (char === "," && depth === 1) {
      alternatives.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  if (close === -1) {
    throw new GlobSyntaxError(pattern, "unbalanced '{'");
  }
  if (alternatives.length < 2) {
    // `{ts}` is not alternation, it is a typo that would otherwise compile to
    // a literal-looking pattern that matches nothing a human expected.
    throw new GlobSyntaxError(
      pattern,
      "brace alternation needs at least two alternatives, e.g. '{ts,tsx}'",
    );
  }

  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const expanded: string[] = [];

  for (const alternative of alternatives) {
    for (const tail of expandBraces(`${prefix}${alternative}${suffix}`)) {
      expanded.push(tail);
      if (expanded.length > MAX_GLOB_EXPANSIONS) {
        throw new GlobSyntaxError(
          pattern,
          `brace expansion exceeds ${String(MAX_GLOB_EXPANSIONS)} patterns`,
        );
      }
    }
  }

  return expanded;
}

function compileSegment(pattern: string, segment: string): string {
  if (segment.includes("**")) {
    // `src/**test/` has no agreed meaning across dialects — some treat it as
    // `*`, some as `**`. Refusing is the only interpretation that cannot be
    // silently wrong.
    throw new GlobSyntaxError(
      pattern,
      "'**' must be a whole path segment, as in 'src/**/x.ts'",
    );
  }

  let compiled = "";
  let literal = "";

  const flush = (): void => {
    if (literal !== "") {
      compiled += escapeLiteral(literal);
      literal = "";
    }
  };

  for (const char of segment) {
    switch (char) {
      case "*":
        flush();
        compiled += "[^/]*";
        break;
      case "?":
        flush();
        compiled += "[^/]";
        break;
      case "[":
      case "]":
        throw new GlobSyntaxError(
          pattern,
          "character classes are not supported; list the alternatives as '{a,b}'",
        );
      case "!":
        throw new GlobSyntaxError(
          pattern,
          "negation is not supported; express exclusions as separate configuration",
        );
      case "\\":
        throw new GlobSyntaxError(
          pattern,
          "escapes are not supported; every character except '*', '?' and '{' is already literal",
        );
      case "{":
      case "}":
        // Expansion runs first, so a surviving brace is unbalanced.
        throw new GlobSyntaxError(pattern, `unbalanced ${quoteValue(char)}`);
      default:
        literal += char;
    }
  }

  flush();
  return compiled;
}

/** A pattern compiled to a matcher. */
export interface CompiledGlob {
  /** The pattern this was compiled from, after brace expansion. */
  readonly pattern: GlobPattern;
  readonly test: (path: string) => boolean;
}

/**
 * Compiles one brace-free pattern.
 *
 * @throws {GlobSyntaxError} on any syntax outside the supported dialect.
 */
export function compileGlob(pattern: string): CompiledGlob {
  if (pattern.length === 0) {
    throw new GlobSyntaxError(pattern, "a pattern must not be empty");
  }
  if (pattern.length > TEXT_LIMITS.glob) {
    throw new GlobSyntaxError(
      pattern,
      `longer than ${String(TEXT_LIMITS.glob)} characters`,
    );
  }
  if (pattern.startsWith("/")) {
    throw new GlobSyntaxError(
      pattern,
      "patterns are relative to the repository root and must not start with '/'",
    );
  }
  if (pattern.includes("\\")) {
    throw new GlobSyntaxError(
      pattern,
      "escapes and backslash separators are not supported; use '/'",
    );
  }
  if (CONTROL_CHARACTERS.test(pattern)) {
    throw new GlobSyntaxError(
      pattern,
      "contains control characters or a NUL byte",
    );
  }

  const segments = pattern.split("/");
  const parts: string[] = [];

  for (const [index, segment] of segments.entries()) {
    const isLast = index === segments.length - 1;

    if (segment === "") {
      throw new GlobSyntaxError(
        pattern,
        isLast ? "must not end with '/'" : "contains an empty path segment",
      );
    }
    if (segment === "." || segment === "..") {
      throw new GlobSyntaxError(
        pattern,
        `${quoteValue(segment)} segments are not allowed; patterns are already root-relative`,
      );
    }

    if (segment === "**") {
      if (segments[index + 1] === "**") {
        throw new GlobSyntaxError(
          pattern,
          "'**/**' is redundant; use a single '**'",
        );
      }
      // Trailing `**` covers everything below this point; a non-trailing one
      // consumes whole segments *including* their separator, which is what
      // makes `src/**/x.ts` match `src/x.ts` with zero directories between.
      parts.push(isLast ? ".+" : "(?:[^/]+/)*");
      continue;
    }

    parts.push(compileSegment(pattern, segment));
    if (!isLast) parts.push("/");
  }

  const matcher = new RegExp(`^${parts.join("")}$`);

  return {
    pattern: unsafeBrand<GlobPattern>(pattern),
    test: (path: string): boolean => matcher.test(path),
  };
}

/**
 * Compiles a pattern including any brace alternation.
 *
 * Returns one matcher per expanded pattern; a path matches the original if it
 * matches any of them.
 */
export function compileGlobPattern(pattern: string): readonly CompiledGlob[] {
  return expandBraces(pattern).map(compileGlob);
}

/** Whether `path` matches `pattern`. */
export function matchesGlob(pattern: string, path: string): boolean {
  return compileGlobPattern(pattern).some((compiled) => compiled.test(path));
}

/** Whether the pattern is valid in this dialect. */
export function isValidGlob(pattern: string): boolean {
  try {
    compileGlobPattern(pattern);
    return true;
  } catch (error) {
    if (error instanceof GlobSyntaxError) return false;
    throw error;
  }
}

/**
 * How specific a pattern is, used to order path instructions (§40).
 *
 * Specificity is the count of **literal** segments — segments containing no
 * wildcard. `src/auth/session.ts` scores 3, `src/auth/*.ts` scores 2, and
 * `**` scores 0, so the more precisely a rule names its target the later it
 * gets to speak and the more it can override.
 *
 * Counting literal segments rather than pattern length is what makes this
 * behave the way an author expects: `src/a.ts` must beat
 * `**\/{a,b,c,d,e,f}.ts` even though the latter is a longer string.
 *
 * For a braced pattern the score is the minimum across its expansions — the
 * weakest alternative, since any of them may be the one that matched.
 */
export function globSpecificity(pattern: string): number {
  const scores = expandBraces(pattern).map((expanded) => {
    let literals = 0;
    for (const segment of expanded.split("/")) {
      if (!segment.includes("*") && !segment.includes("?")) literals += 1;
    }
    return literals;
  });
  return Math.min(...scores);
}

export const globPatternSchema: z.ZodType<GlobPattern> = z
  .string()
  .max(TEXT_LIMITS.glob)
  .superRefine((value, ctx) => {
    try {
      compileGlobPattern(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message:
          error instanceof GlobSyntaxError
            ? error.message
            : "Invalid glob pattern",
      });
    }
  })
  .transform((value) => unsafeBrand<GlobPattern>(value));
