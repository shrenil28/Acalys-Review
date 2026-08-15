/**
 * A validated repository-relative file path (P0.txt §63, §64).
 *
 * This is the most security-sensitive primitive in the package. Every path in
 * these contracts originates outside the platform — a provider's file list, a
 * tool's finding, a model's suggested fix — and later phases hand paths to a
 * sandbox that reads and writes real files. A path that escapes the repository
 * root is arbitrary file access.
 *
 * Canonical form is a relative POSIX path with no leading `./`:
 *
 *     src/auth/session.ts        ✓
 *     ./src/auth/session.ts      ✓ normalized to the above
 *     /etc/passwd                ✗ absolute
 *     ../../etc/passwd           ✗ traversal
 *     src/../../etc/passwd       ✗ traversal after a legitimate prefix
 *     src\auth\session.ts        ✗ backslash separator
 *     C:/repo/file.ts            ✗ drive-qualified
 *     src//auth.ts               ✗ empty segment
 *     src/auth/                  ✗ trailing slash
 *     src/a\u0000.ts             ✗ NUL byte
 *
 * The type is branded, so a raw `string` cannot reach a filesystem API by
 * accident — it must pass through {@link repositoryPath} first. That is the
 * property later sandbox code will depend on.
 *
 * Validation is **syntactic, not filesystem-resolving**: it never touches disk
 * and never follows symlinks. Symlink escape is a real risk, but it can only
 * be checked against a materialized working tree, which is the snapshot
 * service's job in a later phase. This layer guarantees that the *string* is
 * well-formed and traversal-free.
 */

import { z } from "zod";
import { unsafeBrand, type Brand } from "./brand.js";
import { ValidationError } from "../errors/errors.js";
import { TEXT_LIMITS } from "./limits.js";
import { truncateForDetails } from "./format.js";

/** A repository-relative POSIX path in canonical form. */
export type RepositoryPath = Brand<string, "RepositoryPath">;

/** Longest accepted path. Comfortably above real repositories, far below abuse. */
export const MAX_REPOSITORY_PATH_LENGTH = 1_024;

// C0 controls, DEL, and NUL. A NUL byte truncates the string in any C-based
// syscall, so "src/ok.ts\u0000/../../etc/passwd" can pass a naive check and
// then open a different file entirely.
// Matching control characters is the entire purpose here: a NUL byte
// truncates the string in any C-based syscall, so "src/ok.ts\u0000/../.." can
// pass a naive check and then open a different file.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

// Defence in depth: these are the percent-encodings of `.`, `/`, and `\`. A
// literal `%2e` in a filename is legal-but-bizarre; a downstream component
// that decodes before use would turn `%2e%2e%2f` back into `../`. Rejecting
// costs nothing real and closes the hole regardless of what decodes later.
const ENCODED_TRAVERSAL = /%2e|%2f|%5c/i;

const WINDOWS_DRIVE = /^[A-Za-z]:/;

function reject(path: string, reason: string): never {
  throw new ValidationError(`Invalid repository path: ${reason}`, {
    // The path is echoed because it is repository content, not a credential,
    // and a validation error without the offending value is unactionable (§96).
    details: { path: truncateForDetails(path), reason },
  });
}

/**
 * Validates and normalizes an untrusted string into a {@link RepositoryPath}.
 *
 * The single normalization applied is stripping one leading `./`, since
 * providers and tools commonly emit it. Everything else must already be
 * canonical — silently repairing `a//b` or `a/./b` would mean two different
 * inputs collapse to one path, and paths feed fingerprints (§28, §58).
 *
 * @throws {ValidationError} with a specific reason for every rejection
 */
export function repositoryPath(value: string): RepositoryPath {
  if (value.length === 0) {
    reject(value, "path is empty");
  }
  if (value.length > MAX_REPOSITORY_PATH_LENGTH) {
    reject(
      value,
      `path exceeds ${String(MAX_REPOSITORY_PATH_LENGTH)} characters`,
    );
  }
  if (CONTROL_CHARACTERS.test(value)) {
    reject(value, "path contains control characters or a NUL byte");
  }
  if (ENCODED_TRAVERSAL.test(value)) {
    reject(value, "path contains percent-encoded separators or dots");
  }
  if (value.includes("\\")) {
    reject(value, "path contains a backslash; use POSIX separators");
  }
  if (value.startsWith("/")) {
    reject(value, "path is absolute; repository paths are relative");
  }
  if (WINDOWS_DRIVE.test(value)) {
    reject(value, "path is drive-qualified; repository paths are relative");
  }

  const normalized = value.startsWith("./") ? value.slice(2) : value;

  if (normalized.length === 0) {
    reject(value, "path resolves to the repository root");
  }
  if (normalized.endsWith("/")) {
    reject(value, "path has a trailing slash; expected a file path");
  }

  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      reject(value, "path contains an empty segment");
    }
    if (segment === ".") {
      reject(value, "path contains a '.' segment; expected canonical form");
    }
    if (segment === "..") {
      reject(value, "path contains a '..' segment; traversal is not permitted");
    }
  }

  return unsafeBrand<RepositoryPath>(normalized);
}

/** Non-throwing predicate, for filtering untrusted lists. */
export function isRepositoryPath(value: unknown): value is RepositoryPath {
  if (typeof value !== "string") return false;
  try {
    // Also demands canonical form: "./a.ts" is *accepted* by the factory but
    // is not itself canonical, so it is not a RepositoryPath until normalized.
    return repositoryPath(value) === value;
  } catch {
    return false;
  }
}

/** The file name, or the whole path when there is no directory component. */
export function pathBasename(value: RepositoryPath): string {
  const index = value.lastIndexOf("/");
  return index === -1 ? value : value.slice(index + 1);
}

/** Lowercase extension without the dot, or `undefined` when there is none. */
export function pathExtension(value: RepositoryPath): string | undefined {
  const base = pathBasename(value);
  const dot = base.lastIndexOf(".");
  // A leading dot is a dotfile (".gitignore"), not an extension.
  if (dot <= 0 || dot === base.length - 1) return undefined;
  return base.slice(dot + 1).toLowerCase();
}

/** Directory portion, or `undefined` for a file at the repository root. */
export function pathDirname(value: RepositoryPath): RepositoryPath | undefined {
  const index = value.lastIndexOf("/");
  if (index === -1) return undefined;
  return unsafeBrand<RepositoryPath>(value.slice(0, index));
}

/**
 * Number of literal path segments — the specificity signal used to order
 * path-instruction matches (§40).
 */
export function pathDepth(value: RepositoryPath): number {
  return value.split("/").length;
}

/**
 * Runtime schema. Applies the same normalization as the factory, so a
 * provider payload carrying `./src/a.ts` parses to `src/a.ts`.
 */
export const repositoryPathSchema = z
  .string()
  .max(TEXT_LIMITS.url)
  .transform((value, ctx) => {
    try {
      return repositoryPath(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message:
          error instanceof ValidationError ? error.message : "Invalid path",
      });
      return z.NEVER;
    }
  });
