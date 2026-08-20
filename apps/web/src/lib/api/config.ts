/**
 * Where the backend is, if there is one.
 *
 * The API is not deployed yet, so a build with no `VITE_ACALYS_API_URL`
 * continues to render the fixtures this app has always rendered. That is the
 * only fallback in the system, and it is chosen at **configuration** time.
 *
 * What must never happen is a fallback at *failure* time. If an API is
 * configured and the request fails, the surface says so — it does not quietly
 * show fixtures, because a UI that substitutes plausible data for a failed
 * request is lying in the most convincing way available to it.
 */

export function apiBaseUrl(): string | undefined {
  const configured: unknown = import.meta.env["VITE_ACALYS_API_URL"];
  return typeof configured === "string" && configured !== ""
    ? configured
    : undefined;
}
