#!/usr/bin/env node
/**
 * Extract Export Rename Map from MR() Calls
 *
 * Scans split bundle files for MR(target, { exportName: () => minifiedVar, ... })
 * patterns and produces a JSON rename map: { "minifiedVar": "exportName" }.
 *
 * Usage:
 *   node extract-exports.mjs [inputDir] [--out FILE] [--stats] [--min-name-length N]
 *
 * Examples:
 *   node extract-exports.mjs                                    # scan default dir, print to stdout
 *   node extract-exports.mjs ./split/ --out renames-auto.json   # write to file
 *   node extract-exports.mjs --stats                            # print summary statistics
 *   node extract-exports.mjs --no-skip-generic                  # include "call", "default", etc.
 */

import fs from "fs";
import path from "path";
import { DEFAULT_EXPORT_HELPER, detectExportHelper, extractExportPairs } from "./bun-runtime.mjs";

const DEFAULT_INPUT_DIR = null; // require explicit path
const DEFAULT_GENERIC_NAMES = new Set([
  "call",
  "default",
  "get",
  "set",
  "init",
  "run",
  "exec",
  "then",
  "next",
  "done",
]);

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    inputDir: null,
    outFile: null,
    stats: false,
    skipGeneric: true,
    minNameLength: 3,
    exportFn: null,
  };

  let i = 0;
  while (i < args.length) {
    if (args[i] === "--out") {
      opts.outFile = args[++i];
      i++;
    } else if (args[i] === "--stats") {
      opts.stats = true;
      i++;
    } else if (args[i] === "--skip-generic") {
      opts.skipGeneric = true;
      i++;
    } else if (args[i] === "--no-skip-generic") {
      opts.skipGeneric = false;
      i++;
    } else if (args[i] === "--min-name-length") {
      opts.minNameLength = parseInt(args[++i], 10);
      if (isNaN(opts.minNameLength) || opts.minNameLength < 0) {
        console.error("Error: --min-name-length must be a non-negative integer");
        process.exit(1);
      }
      i++;
    } else if (args[i] === "--export-fn") {
      opts.exportFn = args[++i];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      printUsage();
      process.exit(0);
    } else if (!args[i].startsWith("--")) {
      opts.inputDir = args[i];
      i++;
    } else {
      console.error(`Unknown option: ${args[i]}`);
      process.exit(1);
    }
  }

  if (!opts.inputDir) {
    console.error("Error: input directory is required (pass as first argument)");
    printUsage();
    process.exit(1);
  }

  return opts;
}

function printUsage() {
  console.log(`Usage: node extract-exports.mjs [inputDir] [options]

Scans split bundle files for __export(target, { exportName: () => minifiedVar })
calls (helper name auto-detected, historically "MR") and outputs a JSON rename
map { "minifiedVar": "exportName" }.

Arguments:
  inputDir                   Directory containing .js files to scan (required)

Options:
  --out FILE                 Write JSON output to FILE instead of stdout
  --stats                    Print summary statistics to stderr
  --skip-generic             Skip generic names like "call", "default" (default)
  --no-skip-generic          Include generic names
  --min-name-length N        Minimum export name length to include (default: 3)
  --export-fn NAME           __export helper name (default: auto-detected, "MR" as last resort)
  -h, --help                 Show this help message`);
}

/**
 * Resolve the __export helper name for a split directory:
 * --export-fn, then resplit manifest metadata, then structural detection in
 * 00-runtime.js / the files themselves, then the historical "MR".
 */
function resolveExportHelper(opts, files) {
  if (opts.exportFn) return { name: opts.exportFn, source: "--export-fn" };
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(opts.inputDir, "manifest.json"), "utf-8"));
    if (manifest?._meta?.exportHelper) return { name: manifest._meta.exportHelper, source: "manifest" };
  } catch {}
  const ordered = files.includes("00-runtime.js") ? ["00-runtime.js", ...files] : files;
  for (const file of ordered) {
    const name = detectExportHelper(fs.readFileSync(path.join(opts.inputDir, file), "utf-8"));
    if (name) return { name, source: `detected in ${file}` };
  }
  return { name: DEFAULT_EXPORT_HELPER, source: "default" };
}

function main() {
  const opts = parseArgs();

  if (!fs.existsSync(opts.inputDir)) {
    console.error(`Error: input directory not found: ${opts.inputDir}`);
    process.exit(1);
  }

  const stat = fs.statSync(opts.inputDir);
  if (!stat.isDirectory()) {
    console.error(`Error: not a directory: ${opts.inputDir}`);
    process.exit(1);
  }

  // Collect all .js files (app only — skip vendor/)
  const files = fs
    .readdirSync(opts.inputDir)
    .filter((f) => f.endsWith(".js") && fs.statSync(path.join(opts.inputDir, f)).isFile())
    .sort();

  if (files.length === 0) {
    console.error(`Error: no .js files found in ${opts.inputDir}`);
    process.exit(1);
  }

  const exportHelper = resolveExportHelper(opts, files);

  // Stats counters
  let totalPairs = 0;
  let skippedGeneric = 0;
  let skippedShort = 0;
  let skippedSameName = 0;
  let skippedConflicts = 0;
  let skippedUnderscorePrefix = 0;
  const warnings = [];

  // varMap: minifiedVar -> [{ exportName, file }]
  // Used for conflict detection across all files
  const varMap = new Map();

  for (const file of files) {
    const filePath = path.join(opts.inputDir, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const pairs = extractExportPairs(content, exportHelper.name);

    for (const { exportName, minifiedVar } of pairs) {
      totalPairs++;

      // Skip if exportName === minifiedVar (already correctly named)
      if (exportName === minifiedVar) {
        skippedSameName++;
        continue;
      }

      // Skip generic names
      if (opts.skipGeneric && DEFAULT_GENERIC_NAMES.has(exportName)) {
        skippedGeneric++;
        continue;
      }

      // Skip short export names
      if (exportName.length < opts.minNameLength) {
        skippedShort++;
        continue;
      }

      // Skip underscore-prefixed variants (e.g. _uppercase when uppercase also exists)
      if (exportName.startsWith("_")) {
        skippedUnderscorePrefix++;
        continue;
      }

      if (!varMap.has(minifiedVar)) {
        varMap.set(minifiedVar, []);
      }
      varMap.get(minifiedVar).push({ exportName, file });
    }
  }

  // Build the final rename map, handling conflicts
  const renameMap = {};

  for (const [minifiedVar, entries] of varMap) {
    // Deduplicate: same exportName from multiple files is fine
    const uniqueNames = [...new Set(entries.map((e) => e.exportName))];

    if (uniqueNames.length === 1) {
      renameMap[minifiedVar] = uniqueNames[0];
    } else {
      // Conflict: same minifiedVar maps to different export names
      skippedConflicts++;
      const details = entries
        .map((e) => `${e.exportName} (${e.file})`)
        .join(", ");
      warnings.push(
        `CONFLICT: ${minifiedVar} -> ${details}`
      );
    }
  }

  // Print warnings to stderr
  if (warnings.length > 0) {
    console.error(`\n--- Warnings (${warnings.length}) ---`);
    for (const w of warnings) {
      console.error(`  ${w}`);
    }
    console.error("");
  }

  // Print stats to stderr if requested
  if (opts.stats) {
    const included = Object.keys(renameMap).length;
    console.error("--- Export Extraction Stats ---");
    console.error(`  Files scanned:           ${files.length}`);
    console.error(`  Export helper:           ${exportHelper.name}() (${exportHelper.source})`);
    console.error(`  Total export pairs:      ${totalPairs}`);
    console.error(`  Skipped (same name):     ${skippedSameName}`);
    console.error(`  Skipped (generic):       ${skippedGeneric}`);
    console.error(`  Skipped (short name):    ${skippedShort}`);
    console.error(`  Skipped (_prefixed):     ${skippedUnderscorePrefix}`);
    console.error(`  Skipped (conflicts):     ${skippedConflicts}`);
    console.error(`  Included in output:      ${included}`);
    console.error("-------------------------------");
  }

  // Output the rename map
  const output = JSON.stringify(renameMap, null, 2) + "\n";

  if (opts.outFile) {
    fs.writeFileSync(opts.outFile, output, "utf-8");
    console.error(`Wrote ${Object.keys(renameMap).length} renames to ${opts.outFile}`);
  } else {
    process.stdout.write(output);
  }
}

main();
