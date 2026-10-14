/**
 * Child-process invocation of other pipeline scripts.
 *
 * From source, a script is run as `<runtime> src/<name>.mjs ...`. Inside the
 * single executable built by `bun build --compile` (see package.json), script
 * files do not exist on disk: the executable itself dispatches subcommands,
 * so the same call becomes `<exe> <name> ...`.
 */

import path from "path";

/** True when running from a `bun build --compile` executable (virtual /$bunfs or B:/~BUN root). */
export function isCompiledExecutable() {
  return /[\\/](?:~BUN|\$bunfs)[\\/]/.test(decodeURIComponent(import.meta.url));
}

/** Directory holding user-facing files (data/, versions/): the exe's folder when compiled. */
export function resourceRoot(scriptDir) {
  return isCompiledExecutable() ? path.dirname(process.execPath) : path.resolve(scriptDir, "..");
}

/**
 * Return [command, argsPrefix] to run pipeline script `name` (without .mjs).
 * `scriptDir` is the caller's directory, used when running from source.
 */
export function scriptCommand(scriptDir, name) {
  if (isCompiledExecutable()) return [process.execPath, [name]];
  return [process.execPath, [path.join(scriptDir, `${name}.mjs`)]];
}
