/**
 * slugify: Convert a title string into a URL-safe slug.
 *
 * Rules:
 *   1. Lowercase all characters
 *   2. Replace spaces with hyphens
 *   3. Remove non-alphanumeric characters (except hyphens)
 *   4. Collapse multiple consecutive hyphens into one
 *   5. Trim leading/trailing hyphens
 *
 * BUG (intentional): Line 22 uses `+` instead of `-` to join words,
 *      producing "helloworld" instead of "hello-world" (the + is stripped by
 *      the [^a-z0-9\-] filter). The test for spaces therefore fails.
 *
 * To reproduce a fresh RED state, change line 18 back to: .replace(/\s+/g, "+")
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/\s+/g, "+")        // BUG: should be "-" not "+"
    .replace(/[^a-z0-9\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}
