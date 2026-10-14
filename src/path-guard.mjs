/**
 * Path containment helpers.
 *
 * File and directory names in this pipeline come from untrusted sources
 * (module names embedded in the analyzed binary, manifests, layout JSON).
 * Every write/move derived from such names must stay inside its output root.
 */

import path from "path";

/**
 * Resolve `rel` under `root` and return the absolute path, or null if the
 * result would escape `root` (via "..", an absolute path or a drive letter).
 */
export function resolveInside(root, rel) {
  const absRoot = path.resolve(root);
  const target = path.resolve(absRoot, String(rel));
  const relative = path.relative(absRoot, target);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return target;
}

/** Same as resolveInside(), but throws instead of returning null. */
export function assertInside(root, rel, label = "path") {
  const target = resolveInside(root, rel);
  if (!target) {
    throw new Error(`Refusing ${label} outside of ${path.resolve(root)}: ${rel}`);
  }
  return target;
}
