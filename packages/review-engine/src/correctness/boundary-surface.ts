/**
 * P1-M.3.5 — what a consumer can reach through a public boundary, as a fact.
 *
 * M.3.4's verifier judged reachability at the declared public boundary. Its
 * analyzer did not: it compared a *module's* export-set delta, and
 * `resolvePublicBoundary` was never called from the proposal side at all. So a
 * capability whose claim is defined at the boundary could not see edits to the
 * boundary, and Epoch 4's most important witness — a manifest withdrawing a
 * subpath while no source file changes — produced nothing.
 *
 * # Why this is a surface and not a manifest check
 *
 * ```
 * WRONG   if package.json exports changed -> propose
 * RIGHT   surface(BASE) vs surface(HEAD)  -> propose on the delta
 * ```
 *
 * The first is a proxy: correct for the shape that motivated it and silently
 * wrong for barrels, re-export topology, and entrypoint moves. It is the same
 * mistake as matching `UndefinedKeyword`, counting parameters, and treating a
 * different return value as a replacement. A manifest is one *provenance* for
 * a name being reachable, never the definition of reachability.
 *
 * # Completeness is not decoration
 *
 * A surface this cannot fully establish must never license "X is gone". That
 * is M.3.0's absence rule one layer up:
 *
 * ```
 * established   every name was resolved; a missing name is genuinely missing
 * partial       some path could not be followed; absence proves nothing
 * unavailable   the boundary itself could not be read
 * ```
 *
 * Nothing here compiles anything or resolves types. It reads syntax and
 * follows re-exports between files it was given, which is a fact-gathering
 * job. The verifier still decides whether a proposed loss is real.
 */

import ts from "typescript";

/** How a name came to be reachable through the boundary. */
export type ReachabilityProvenance =
  | "declared_at_entry"
  | "named_reexport"
  | "wholesale_reexport"
  | "manifest_subpath";

export interface ReachableName {
  readonly name: string;
  readonly namespace: "value" | "type";
  readonly provenance: ReachabilityProvenance;
  /** The file whose syntax established it, for anchoring and evidence. */
  readonly establishedIn: string;
}

/**
 * Four states, and none of them is `reachableNames === []`.
 *
 * ```
 * established   every path was followed; a missing name is genuinely missing
 * empty         followed completely, and the boundary exposes nothing
 * partial       a path could not be followed; absence proves nothing
 * unavailable   the boundary's own entry could not be read
 * ```
 *
 * `empty` and `partial` both yield zero reachable names and mean opposite
 * things. Collapsing them would recreate the absence problem M.3.0 froze, one
 * layer further out — and `absent`, a boundary that is no longer declared at
 * all, is a fifth thing again, carried on the surface's presence rather than
 * inside it.
 */
export type SurfaceCompleteness =
  | { readonly kind: "established" }
  | { readonly kind: "empty" }
  | { readonly kind: "partial"; readonly because: string }
  | { readonly kind: "unavailable"; readonly because: string };

export interface PublicBoundarySurface {
  /** What a consumer writes in an import. */
  readonly boundaryIdentity: string;
  /** The file that entry resolves to, when one could be resolved. */
  readonly consumerEntry: string | undefined;
  readonly reachableNames: readonly ReachableName[];
  readonly completeness: SurfaceCompleteness;
}

const hasExportModifier = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );

const parse = (path: string, content: string): ts.SourceFile =>
  ts.createSourceFile(path, content, ts.ScriptTarget.ES2022, true);

/** Resolves a relative specifier against the directory of `from`. */
function resolveSpecifier(
  from: string,
  specifier: string,
  has: (path: string) => boolean,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const directory = from.split("/").slice(0, -1);
  const parts = specifier.split("/");

  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") directory.pop();
    else directory.push(part);
  }

  const base = directory.join("/").replace(/\.js$/, "");
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
  ]) {
    if (has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Every boundary a repository declares, from its package manifests.
 *
 * A manifest with an `exports` map declares several: one per subpath. Losing
 * one of them is a reachability loss even when every source file is untouched,
 * which is the case M.3.4 could not see.
 */
export function declaredBoundaries(
  files: ReadonlyMap<string, string>,
): readonly {
  readonly identity: string;
  readonly entry: string | undefined;
}[] {
  const found: { identity: string; entry: string | undefined }[] = [];

  for (const [path, content] of files) {
    if (!path.endsWith("package.json")) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;

    const record = parsed as Record<string, unknown>;
    const name = typeof record["name"] === "string" ? record["name"] : path;
    const directory = path.split("/").slice(0, -1).join("/");
    const resolve = (target: string): string | undefined => {
      const relative = target.replace(/^\.\//, "").replace(/\.js$/, ".ts");
      for (const suffix of ["", ".ts", ".tsx", "/index.ts"]) {
        const joined =
          directory === ""
            ? `${relative}${suffix}`
            : `${directory}/${relative}${suffix}`;
        if (files.has(joined)) return joined;
      }
      return undefined;
    };

    const exportsField = record["exports"];
    if (typeof exportsField === "string") {
      found.push({ identity: name, entry: resolve(exportsField) });
    } else if (exportsField !== null && typeof exportsField === "object") {
      for (const [subpath, target] of Object.entries(
        exportsField as Record<string, unknown>,
      )) {
        const identity =
          subpath === "." ? name : `${name}/${subpath.replace(/^\.\//, "")}`;
        if (typeof target === "string") {
          found.push({ identity, entry: resolve(target) });
        } else if (target !== null && typeof target === "object") {
          const first = Object.values(target as Record<string, unknown>).find(
            (value) => typeof value === "string",
          );
          found.push({
            identity,
            entry: typeof first === "string" ? resolve(first) : undefined,
          });
        }
      }
    } else {
      for (const key of ["main", "types"]) {
        const value = record[key];
        if (typeof value === "string") {
          found.push({ identity: name, entry: resolve(value) });
          break;
        }
      }
    }
  }

  return found.sort((left, right) =>
    left.identity < right.identity
      ? -1
      : left.identity > right.identity
        ? 1
        : 0,
  );
}

/**
 * What a consumer can reach through one boundary, in one revision.
 *
 * Follows named re-exports and `export *` between files it was given, one hop
 * at a time, and records where the trail ran out rather than treating the end
 * of its knowledge as the end of the surface.
 */
export function boundarySurface(
  files: ReadonlyMap<string, string>,
  boundary: { readonly identity: string; readonly entry: string | undefined },
): PublicBoundarySurface {
  if (boundary.entry === undefined) {
    return {
      boundaryIdentity: boundary.identity,
      consumerEntry: undefined,
      reachableNames: [],
      completeness: {
        kind: "unavailable",
        because: `no entry file for ${boundary.identity} exists in this revision`,
      },
    };
  }

  const names = new Map<string, ReachableName>();
  const unfollowed: string[] = [];
  const visited = new Set<string>();

  const walk = (path: string, depth: number): void => {
    // A cycle or an over-deep graph stops the walk, and stopping is not the
    // same as finishing. Returning quietly here would report an `established`
    // surface built from a traversal that gave up, so the reason is recorded
    // and completeness degrades.
    if (visited.has(path)) {
      unfollowed.push(`${path} (already visited: re-export cycle)`);
      return;
    }
    if (depth > 8) {
      unfollowed.push(`${path} (re-export depth limit)`);
      return;
    }
    visited.add(path);

    const content = files.get(path);
    if (content === undefined) {
      unfollowed.push(path);
      return;
    }
    const source = parse(path, content);

    const localKinds = new Map<string, "value" | "type">();
    for (const statement of source.statements) {
      if (
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)
      ) {
        localKinds.set(statement.name.text, "type");
      } else if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isEnumDeclaration(statement)) &&
        statement.name !== undefined
      ) {
        localKinds.set(statement.name.text, "value");
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            localKinds.set(declaration.name.text, "value");
          }
        }
      }
    }

    const remember = (entry: ReachableName): void => {
      if (!names.has(entry.name)) names.set(entry.name, entry);
    };

    for (const statement of source.statements) {
      if (hasExportModifier(statement)) {
        const namespace =
          ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement)
            ? "type"
            : "value";
        if (
          (ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement) ||
            ts.isEnumDeclaration(statement) ||
            ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement)) &&
          statement.name !== undefined
        ) {
          remember({
            name: statement.name.text,
            namespace,
            provenance: "declared_at_entry",
            establishedIn: path,
          });
        } else if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) {
              remember({
                name: declaration.name.text,
                namespace: "value",
                provenance: "declared_at_entry",
                establishedIn: path,
              });
            }
          }
        }
        continue;
      }

      if (!ts.isExportDeclaration(statement)) continue;

      const specifier =
        statement.moduleSpecifier !== undefined &&
        ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : undefined;

      if (
        statement.exportClause !== undefined &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const element of statement.exportClause.elements) {
          const exposed = element.name.text;
          const local = element.propertyName?.text ?? exposed;
          remember({
            name: exposed,
            namespace:
              statement.isTypeOnly || element.isTypeOnly
                ? "type"
                : (localKinds.get(local) ?? "value"),
            provenance:
              specifier === undefined ? "declared_at_entry" : "named_reexport",
            establishedIn: path,
          });
        }
        continue;
      }

      // `export * from "..."` — the names live in another file, and the surface
      // is only as complete as our ability to reach it.
      if (specifier !== undefined && statement.exportClause === undefined) {
        const target = resolveSpecifier(path, specifier, (candidate) =>
          files.has(candidate),
        );
        if (target === undefined) {
          unfollowed.push(`${path} -> ${specifier}`);
          continue;
        }
        const before = new Set(names.keys());
        walk(target, depth + 1);
        for (const [name, entry] of names) {
          if (!before.has(name) && entry.establishedIn === target) {
            names.set(name, { ...entry, provenance: "wholesale_reexport" });
          }
        }
      }
    }
  };

  walk(boundary.entry, 0);

  return {
    boundaryIdentity: boundary.identity,
    consumerEntry: boundary.entry,
    reachableNames: [...names.values()].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    ),
    completeness:
      unfollowed.length > 0
        ? {
            kind: "partial",
            because: `could not follow ${[...new Set(unfollowed)].sort().join(", ")}`,
          }
        : names.size === 0
          ? { kind: "empty" }
          : { kind: "established" },
  };
}
