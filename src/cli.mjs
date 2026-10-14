#!/usr/bin/env node
/**
 * bun-demincer — single entry point.
 *
 *   node src/cli.mjs <command> [args...]
 *   bun-demincer.exe <command> [args...]      (built with `npm run build:exe`)
 *
 * Each command runs the matching src/<command>.mjs script with the remaining
 * arguments, exactly as if it had been launched directly.
 */

// String-literal imports so that `bun build --compile` embeds every script
const COMMANDS = {
  extract: () => import("./extract.mjs"),
  resplit: () => import("./resplit.mjs"),
  "match-vendors": () => import("./match-vendors.mjs"),
  deobfuscate: () => import("./deobfuscate.mjs"),
  rename: () => import("./rename.mjs"),
  "extract-exports": () => import("./extract-exports.mjs"),
  "extract-names": () => import("./extract-names.mjs"),
  "extract-tools": () => import("./extract-tools.mjs"),
  "extract-errors": () => import("./extract-errors.mjs"),
  "extract-deps": () => import("./extract-deps.mjs"),
  "cluster-graph": () => import("./cluster-graph.mjs"),
  organize: () => import("./organize.mjs"),
  "diff-versions": () => import("./diff-versions.mjs"),
  "transfer-artifacts": () => import("./transfer-artifacts.mjs"),
  "apply-reference-layout": () => import("./apply-reference-layout.mjs"),
  "ai-rename": () => import("./ai-rename.mjs"),
  "ai-rename-scoped": () => import("./ai-rename-scoped.mjs"),
};

function printUsage() {
  console.log(`Usage: bun-demincer <command> [args...]

Commands:
  ${Object.keys(COMMANDS).join("\n  ")}

Run "bun-demincer <command> --help" for the options of a command.
Typical pipeline:
  bun-demincer extract app.exe extracted
  bun-demincer resplit extracted/app.js resplit
  bun-demincer match-vendors resplit --classify
  bun-demincer deobfuscate --dir decoded`);
}

const [command, ...rest] = process.argv.slice(2);

if (!command || command === "-h" || command === "--help") {
  printUsage();
  process.exit(command ? 0 : 1);
}
if (!Object.hasOwn(COMMANDS, command)) {
  console.error(`Unknown command: ${command}\n`);
  printUsage();
  process.exit(1);
}

// Scripts read their arguments from process.argv.slice(2)
process.argv = [process.argv[0], command, ...rest];
await COMMANDS[command]();
