import { ideCliViews, navigation, prReviewViews } from "@/lib/nav";
import { workspaces } from "@/lib/session";

export interface Crumb {
  label: string;
  to?: string;
}

/** Route → label, assembled once from the nav tree so the two never drift. */
const labels = new Map<string, string>([["/", "Explore"]]);
const groupOf = new Map<string, { label: string; firstChild: string }>();

for (const entry of navigation) {
  if (entry.kind === "link") labels.set(entry.leaf.to, entry.leaf.label);
  if (entry.kind === "group") {
    for (const item of entry.group.items) {
      labels.set(item.to, item.label);
      groupOf.set(item.to, {
        label: entry.group.label,
        firstChild: entry.group.items[0].to,
      });
    }
  }
}

for (const view of [...prReviewViews, ...ideCliViews]) {
  if (!labels.has(view.to)) labels.set(view.to, view.label);
}

const extra: Record<string, string> = {
  "/integrations": "Integrations",
  "/plan/plans": "Plan List",
  "/reports": "Reports",
  "/reports/recurring/new": "Create Report",
  "/reports/ondemand/new": "Create Report",
  "/analytics/pr-reviews": "PR reviews",
  "/analytics/ide-cli-reviews": "IDE/CLI reviews",
  "/login": "Sign in",
};

export function buildCrumbs(pathname: string): Crumb[] {
  if (pathname === "/") return [{ label: "Explore" }];

  const crumbs: Crumb[] = [];
  const segments = pathname.split("/").filter(Boolean);

  // Organization settings is addressed by the org itself: "shrenil28 / Settings".
  if (segments[0] === "organization" && segments[1] === "settings") {
    return [
      { label: workspaces[0].name, to: "/" },
      { label: "Settings" },
    ];
  }

  // Nested dashboard views ( /analytics/pr-reviews/quality-metrics )
  if (segments.length === 3 && segments[0] === "analytics") {
    const parent = `/${segments[0]}/${segments[1]}`;
    crumbs.push({ label: "Analytics" });
    crumbs.push({ label: extra[parent] ?? segments[1], to: parent });
    crumbs.push({ label: labels.get(pathname) ?? titleCase(segments[2]) });
    return crumbs;
  }

  // Account pages are addressed the same way: "shrenil28 / Account / …".
  if (segments[0] === "settings") {
    const group = groupOf.get(pathname);
    return [
      { label: workspaces[0].name, to: "/" },
      { label: group?.label ?? "Account", to: group?.firstChild },
      { label: labels.get(pathname) ?? titleCase(segments[1] ?? "") },
    ];
  }

  const group = groupOf.get(pathname);
  if (group) {
    crumbs.push({ label: group.label, to: group.firstChild });
    crumbs.push({ label: labels.get(pathname)! });
    return crumbs;
  }

  const known = labels.get(pathname) ?? extra[pathname];
  if (known) {
    if (segments.length > 1) {
      const root = `/${segments[0]}`;
      crumbs.push({
        label: extra[root] ?? titleCase(segments[0]),
        to: labels.has(root) || extra[root] ? root : undefined,
      });
    }
    crumbs.push({ label: known });
    return crumbs;
  }

  // Detail routes ( /review/repositories/acalys ) keep the parent clickable.
  const parentPath = `/${segments.slice(0, -1).join("/")}`;
  const parentGroup = groupOf.get(parentPath);
  if (parentGroup) crumbs.push({ label: parentGroup.label, to: parentGroup.firstChild });
  if (labels.has(parentPath))
    crumbs.push({ label: labels.get(parentPath)!, to: parentPath });
  crumbs.push({ label: decodeURIComponent(segments[segments.length - 1]) });
  return crumbs;
}

function titleCase(segment: string) {
  return segment
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
