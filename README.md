# bun-demincer

Decompiler, deminifier, and deobfuscator for [Bun](https://bun.sh)-compiled standalone JavaScript binaries.

Extracts embedded JavaScript source from Bun's binary format, splits it into individual modules, identifies vendor (npm) packages, recovers original identifiers, and organizes everything into a readable, structured codebase — from a single compiled binary.

## What it does

```
Bun binary (opaque executable)
  → extract embedded JS + assets
  → split into individual modules (1 file per module)
  → classify vendor vs app modules (fingerprint DB + flood-fill)
  → deobfuscate (structural transforms + name recovery + formatting)
  → cluster modules by dependency graph (Louvain community detection)
  → organize into semantic directories
  → readable, organized source code
  → reassemble back into a working binary (round-trip)
```

The deobfuscated code is not just readable — it's **runnable**. You can modify individual module files and reassemble them back into a working Bun binary.

## Quick start

```bash
npm install
```

### Full pipeline (cold-start — no prior knowledge of the binary)

```bash
# 1. Extract JS from a Bun binary (macOS, Linux or Windows .exe)
node src/extract.mjs /path/to/bun-binary extracted/
#    → prints the entry bundle path (also "entryFile" in extracted/manifest.json)
#    → extracted/_sources/ if the binary embeds sourcemaps (original pre-bundle sources)

# 2. Split into individual modules (use the entry bundle printed by step 1)
node src/resplit.mjs extracted/<entry>.js resplit/

# 3. Classify vendor packages via fingerprint DB
node src/match-vendors.mjs resplit/ --db data/vendor-fingerprints-1000.json --classify

# 4. Deobfuscate (structural transforms + auto-extract renames + format)
cp -r resplit/ decoded/
node src/deobfuscate.mjs --dir decoded/

# 5. Build dependency graph
node src/extract-deps.mjs decoded/ --out deps-graph.json

# 6. Cluster modules (sweep resolutions, pick the best one)
node src/cluster-graph.mjs deps-graph.json --sweep
node src/cluster-graph.mjs deps-graph.json --pick 1.5 --png --out clusters-core
#    → clusters-core.json (cluster membership)
#    → clusters.png (visualization)

# 7. Label clusters (create cluster-labels.json with directory names)
#    Use the PNG + top functions per cluster to name them.
#    See "Organizing modules" below for the format.

# 8. Organize into semantic directories
#    (reads deps-graph.json, clusters-core.json, cluster-labels.json from the current directory)
node src/organize.mjs decoded/
#    → decoded-organized/ with named directories + INDEX.md
#    An existing --out directory is only replaced if it is a previous organize.mjs output.
```

On Windows (PowerShell), replace `cp -r resplit/ decoded/` with `Copy-Item resplit decoded -Recurse`.

Steps 1-4 are fully automated. Steps 5-8 organize the output into directories — step 7 requires manual labeling (or an LLM).

### Round-trip: reassemble and run

After deobfuscating (and optionally modifying) individual module files, reassemble them back into a working binary:

```bash
# Reassemble deobfuscated modules into a runnable bundle
node scripts/build.mjs <version-dir> --source decoded --no-bun-cjs

# Run it
cd <version-dir>/extracted && bun run.js --version
```

The `--no-bun-cjs` flag wraps the code as a self-executing IIFE instead of relying on Bun's strict `@bun-cjs` CJS loader, which requires byte-exact formatting incompatible with any code transformation.

### With AI-assisted renaming (optional, improves readability)

After step 4, before organizing:

```bash
# Batch rename: send each module to an LLM, get all renames at once
node src/ai-rename.mjs --dir decoded/ --out renames-ai.json
node src/deobfuscate.mjs --dir decoded/ --batch renames-ai.json --only rename

# Scoped rename: per-identifier with AST context (higher quality, more API calls)
node src/ai-rename-scoped.mjs --dir decoded/ --out renames-scoped.json
node src/deobfuscate.mjs --dir decoded/ --batch renames-scoped.json --only rename
```

### Incremental pipeline (updating to a new version)

If you already have a decoded version and want to update to a newer binary:

```bash
# Transfer all artifacts (renames, vendor flags, layout) via content-based matching
node src/transfer-artifacts.mjs new-version/ --reference old-version/

# Or apply the old version's file layout directly
node src/apply-reference-layout.mjs new-decoded/ --reference old-decoded-organized/
```

### Single executable (no Node.js / npm needed on the target machine)

```bash
npm install
npm run build:exe            # requires Bun → dist/bun-demincer(.exe)

bun-demincer extract app.exe extracted
bun-demincer resplit extracted/app.js resplit
bun-demincer match-vendors resplit --classify
bun-demincer deobfuscate --dir decoded
```

Every script is available as a subcommand (`bun-demincer --help`). From source, the same
dispatcher is `node src/cli.mjs <command>` (or `bun src/cli.mjs`). Notes:
- Put `data/vendor-fingerprints-1000.json` in a `data/` folder next to the executable to use it
  as the default `--db` for `match-vendors`.
- `cluster-graph --png` needs the native `canvas` addon, which cannot be embedded: run
  `node src/cluster-graph.mjs ... --png` from source for the PNG.
- The executable targets the build machine's platform; use `bun build --target=bun-linux-x64`
  (etc.) in the `build:exe` script to cross-compile.

## Prerequisites

- **Node.js** (v18+; v22.15+ to recover original sources from embedded sourcemaps)
- **Bun** (optional — only needed to *run* the extracted code, not to decompile it)

## How it works

### Binary format

Bun standalone executables embed all JavaScript in a `__BUN` Mach-O section (macOS), appended ELF data (Linux), or `.bun` PE section (Windows). The section contains a `StandaloneModuleGraph`:

```
[8-byte size header (u64 LE)]           (Mach-O and PE sections)
[data buffer: source code, bytecode, native addons, wasm modules...]
[module table: array of CompiledModuleGraphFile structs (52 bytes each, 36 in older Bun)]
[Offsets struct (32 bytes)]             byte_count = size of data buffer only
[\n---- Bun! ----\n]
```

Module names live under a virtual root: `/$bunfs/root/` on macOS/Linux, `B:/~BUN/root/` on Windows.
On Windows the entry bundle is named after the executable (`app.exe` → extracted as `app.js`).

`extract.mjs` also reports the Bun runtime version statically, from the banner compiled into
every Bun build (`Bun v1.3.14 (0d9b296a) Windows x64`), and stores it as `bunVersion` in
`extracted/manifest.json`. On Windows the PE version resource usually holds it too, but it can be
overridden at compile time (`--windows-version`).

Embedded sourcemaps (`--sourcemap`) use Bun's binary format: a file count, the original file
names and their **zstd-compressed original sources**. `extract.mjs` decodes them into
`extracted/_sources/` (requires Node ≥ 22.15 for `zlib.zstdDecompressSync`) and keeps the raw blob
as `<file>.bunmap`. Bytecode (`--bytecode`) is written as `<file>.jsc`.

Even with `--bytecode` compilation, the full JavaScript source is always stored alongside the bytecode (JSC requires it). The `--bytecode` flag is a startup optimization, not obfuscation.

See [docs/BUN.md](docs/BUN.md) for comprehensive Bun bundler internals.

### Module splitting

`resplit.mjs` detects Bun's module wrapper patterns:
- **`y((exports, module) => { ... })`** — CJS modules (`__commonJS`)
- **`h(() => { ... })`** — ESM lazy initializers (`__esm`)

Outputs one flat file per module with a dependency graph and export mappings.

### Vendor classification

`match-vendors.mjs --classify` identifies npm packages using a fingerprint database of property names and string literals (these survive minification). A reverse-caller flood-fill then propagates: if all callers of a module are already vendor, that module is vendor too.

The fingerprint DB (`data/vendor-fingerprints-1000.json`, 26MB) covers 23,746 files from 1,668 npm packages. It can be extended with `--rebuild-db --npm-dir /path/to/node_modules`.

### Deobfuscation pipeline

1. **wakaru** — structural transforms: `!0`→`true`, `void 0`→`undefined`, comma splitting
2. **lebab** — ES5→ES6+ modernization (skipped by default — `var`→`let/const` causes cross-file collisions when reassembled)
3. **extract** — auto-generate rename maps from `MR()` export mappings + `this.name`/`displayName` patterns
4. **rename** — format-preserving AST rename via recast (only identifier bytes change, everything else stays byte-identical)
5. **prettier** — consistent formatting

Runtime files (`00-runtime.js`, `99-main.js`) are automatically excluded from wakaru/lebab/prettier. Identifiers declared in runtime files (Bun's module system globals like `h`, `v`, `y`, `MR`) are auto-excluded from renames — they're referenced by all modules including vendor.

### Name recovery

Bun's `__export()` pattern — `MR(target, { exportName: () => minifiedVar })` — preserves original export names as string keys. The helper is renamed in every build (`MR`, `u`, `gR`…), so it is detected by structure (`src/bun-runtime.mjs`), recorded as `_meta.exportHelper` in the resplit manifest, and can be forced with `extract-exports.mjs --export-fn <name>`. This is the single biggest source of name recovery. Additional patterns: `this.name = "X"` in class constructors, `displayName = "X"` assignments, and 20+ mapped Bun runtime helpers.

For remaining identifiers, AI-assisted renaming (`ai-rename.mjs`, `ai-rename-scoped.mjs`) uses LLMs to infer semantic names from context.

### Organizing modules

After deobfuscation, modules are flat numbered files. The organization pipeline turns them into a meaningful directory structure:

1. **`extract-deps.mjs`** builds a function-level dependency graph (which module calls which)
2. **`cluster-graph.mjs --sweep`** runs Louvain community detection at 14 resolutions and shows a comparison table — modularity score, cluster count, size distribution
3. **`cluster-graph.mjs --pick <r>`** picks a resolution and outputs `clusters-core.json` (membership) + a PNG visualization
4. **You create `cluster-labels.json`** — naming each cluster based on its top functions:
   ```json
   {
     "clusters": {
       "0": { "directory": "ui", "label": "UI rendering" },
       "1": { "directory": "api", "label": "API client" }
     }
   }
   ```
5. **`organize.mjs`** assigns modules to directories using a 4-layer algorithm:
   - **Layer 1:** Direct cluster membership
   - **Layer 2:** Function-level affinity (majority vote from cross-module callers/callees)
   - **Layer 3:** Manifest-level affinity (majority vote from import/export deps)
   - **Layer 4:** Remaining modules go to `uncategorized/`

### Cross-version support

`diff-versions.mjs` and `transfer-artifacts.mjs` use content-based fingerprinting (strings + properties + exports — never variable names) to match modules across versions and carry over rename artifacts, vendor classifications, and file layout.

## Tools

### Core Pipeline

| Script | Description |
|--------|-------------|
| `src/extract.mjs` | Parse Bun binary format, extract all embedded modules |
| `src/resplit.mjs` | Split bundle into 1-module-per-file |
| `src/match-vendors.mjs` | Vendor classification: fingerprint DB + flood-fill. `--classify`, `--no-move` |
| `src/deobfuscate.mjs` | Full pipeline: wakaru → lebab → extract → rename → prettier |
| `build.mjs` (in project) | Reassemble modules into runnable bundle. `--no-bun-cjs`, `--run` |

### Name Recovery

| Script | Description |
|--------|-------------|
| `src/rename.mjs` | Format-preserving AST rename (recast). Single, batch JSON, `--dry-run` |
| `src/extract-exports.mjs` | Auto-extract `MR()` export mappings → rename JSON |
| `src/extract-names.mjs` | Extract renames from `this.name="X"` + `displayName="X"` patterns |
| `src/extract-tools.mjs` | Extract names from `userFacingName()` patterns |
| `src/extract-errors.mjs` | Extract error class names from factory patterns |
| `src/ai-rename.mjs` | AI semantic renaming (Gemini). Resumable, concurrent |
| `src/ai-rename-scoped.mjs` | Scope-ordered per-identifier AI rename (humanify-style) |

### Organization

| Script | Description |
|--------|-------------|
| `src/extract-deps.mjs` | Function-level dependency graph. `--query`, `--stats`, `--dot` |
| `src/cluster-graph.mjs` | Louvain clustering + PNG visualization. `--sweep`, `--pick`, `--png` |
| `src/organize.mjs` | Assign modules to directories via cluster membership + affinity voting |

### Cross-Version

| Script | Description |
|--------|-------------|
| `src/diff-versions.mjs` | Cross-version diffing: fingerprint → match → normalize → diff |
| `src/transfer-artifacts.mjs` | Transfer artifacts to new versions via content-based module matching |
| `src/apply-reference-layout.mjs` | Apply reference version's file layout (dirs, filenames, vendor flags) |

## Platform notes

- **macOS**: `__BUN`/`__bun` Mach-O segment. Code signature after trailer (~1.7MB padding).
- **Linux**: Data appended to ELF binary. Trailer at very end.
- **Windows**: `.bun` PE section (8-byte size header, like Mach-O). Virtual root `B:/~BUN/root/`.
  All scripts run natively on Windows; `diff-versions.mjs` falls back to `git diff --no-index`
  when `diff` is not installed.
- Native `.node` addons are platform-specific. JS and WASM are portable.

## Project structure

```
src/                    pipeline scripts (standalone, sharing path-guard.mjs, bun-runtime.mjs, subcommand.mjs)
  cli.mjs               single entry point / subcommand dispatcher (used by the executable)
data/
  vendor-fingerprints-1000.json   Vendor fingerprint DB (26MB, 1,668 packages)
docs/
  BUN.md                Bun bundler internals & deobfuscation strategies
```

## License

MIT
