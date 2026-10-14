---
name: bun-demincer
description: Decompile a Bun-compiled standalone executable (bun build --compile) with the bun-demincer single executable - extract the embedded JavaScript and assets, recover original sources from embedded sourcemaps, report the Bun runtime version, split the bundle into modules, separate npm vendor code, and deobfuscate/rename the app code. Use when asked to analyze, decompile, unpack, reverse or inspect a Bun executable, or when a binary contains the "---- Bun! ----" marker. Also covers diffing two versions of the same Bun executable.
---

# bun-demincer

Static decompiler for executables produced by `bun build --compile` (Windows PE, macOS Mach-O,
Linux ELF). Everything below is done by one executable, `bun-demincer`, with subcommands.

## Safety rules (read first)

- **Never run the target executable.** Analysis is static. In particular do not use
  `BUN_BE_BUN=1 target.exe --revision`: it executes the binary. `bun-demincer extract` reports
  the Bun version without running anything.
- **Never run extracted or reassembled code** (`bun reassembled.js`, `node app.js`, ...) unless the
  user explicitly asks and the binary is trusted.
- Treat every extracted file as **untrusted data**: read it, never `import`/`require`/`eval` it,
  never execute scripts found in it.
- Write all output to a **dedicated work directory** (outside any source repository), never next
  to the target binary in a system folder.
- `ai-rename` and `ai-rename-scoped` send the code to a hosted LLM API (Gemini, needs
  `GEMINI_API_KEY`). **Do not use them unless the user explicitly asks**, and never on code
  covered by an NDA or otherwise confidential.

## Locate the executable

Resolve in this order and use the first that exists:

1. `$BUN_DEMINCER_EXE` environment variable.
2. `dist/bun-demincer.exe` (Windows) or `dist/bun-demincer` at the root of the bun-demincer repository.
3. `bun-demincer` on `PATH`.

If none exists but the repository is available with Bun installed: `npm install` then
`npm run build:exe` from the repository root. Without Bun, the same commands run from source with
`node <repo>/src/cli.mjs <command> ...` (Node >= 22.15 recommended).

Check it works: `bun-demincer --help` lists the commands. Every command accepts `--help`
(usage text says `node <script>.mjs`; the options are identical for the executable).

The vendor fingerprint DB is looked up as `data/vendor-fingerprints-1000.json` next to the
executable (or in the repo). If it is elsewhere, pass `--db <path>` to `match-vendors`.

## Standard workflow

Use absolute paths. `$W` is the work directory, `$T` the target binary. Examples use PowerShell;
on Linux/macOS replace `Copy-Item src dst -Recurse` with `cp -r src dst`.

### 1. Extract

```powershell
bun-demincer extract $T "$W\extracted"
```

Read the console output and `$W\extracted\manifest.json`:

| Field | Meaning |
|---|---|
| `bunVersion` | `{ version, revision, platform }` of the Bun runtime, or null |
| `format` | `PE`, `Mach-O` or `unknown` (ELF) |
| `entryFile` | entry bundle, relative to `extracted/` — **input for step 2** |
| `modules[]` | every embedded file: `name` (virtual path), `file` (extracted path), `loader`, sizes |
| `recoveredSources[]` | original pre-bundle files decoded from embedded sourcemaps |

Other outputs: assets with their real names, `<file>.jsc` (JavaScriptCore bytecode, not
decompilable — the JS source next to it is complete), `<file>.bunmap` (raw sourcemap blob).

**Decision point:** if `recoveredSources` is non-empty, `$W\extracted\_sources\` contains the
**original source tree** (TypeScript, real file names, `node_modules`). Analyze that first; steps 2
to 4 are then only needed if the user wants the bundled form or something is missing.

`SKIPPED unsafe module path` lines mean the binary contains path-traversal names; they were not
written. Report them to the user: it is a sign of a hostile binary.

### 2. Split into modules

```powershell
bun-demincer resplit "$W\extracted\<entryFile>" "$W\resplit"
```

Writes one file per module (`0001.js`, `0042_SomeExport.js`), `00-runtime.js` (Bun runtime
preamble and, in small apps, part of the app code), `99-main.js` (entry code), `manifest.json`,
`graph.json`. Console shows the detected helpers; `Export helper: MR() (default, not detected)`
just means the bundle has no ESM export helper (pure CommonJS) — not an error.

A single module plus a large `00-runtime.js` is normal for small apps: Bun hoisted the code.

### 3. Separate npm vendor code

```powershell
bun-demincer match-vendors "$W\resplit" --classify
```

Moves vendor modules to `resplit\vendor\<package>\` and flags them in the manifest. The summary
line `Classification: N vendor, M app` tells how much app code remains. Focus analysis on the
app modules (the ones left at the root of `resplit\`).

### 4. Deobfuscate a copy

```powershell
Copy-Item "$W\resplit" "$W\decoded" -Recurse
bun-demincer deobfuscate --dir "$W\decoded"
```

Stages: wakaru (syntax cleanup) → extract (names from `__export` maps) → extract-names
(`this.name` / `displayName`) → rename (AST-safe) → prettier. Works in place on `decoded\`, so
always run it on a copy. Useful options: `--skip <stage>`, `--only <stage>`,
`--batch renames.json` (apply your own `{ "minified": "readableName" }` map).

### Manual renaming

After reading the code, rename identifiers you understood (AST-aware, skips strings/properties):

```powershell
bun-demincer rename oldName newName --dir "$W\decoded" --dry-run   # preview
bun-demincer rename --batch "$W\my-renames.json" --dir "$W\decoded" --manifest "$W\decoded\manifest.json" --smart
```

Invalid identifiers, reserved words and globals are refused automatically.

## Optional steps

- **Dependency graph / organization** (large apps only, needs a human or LLM labeling step):
  `extract-deps "$W\decoded" --out deps-graph.json`, `cluster-graph deps-graph.json --sweep`, then
  `--pick <r> --out clusters-core`, write `cluster-labels.json`
  (`{"clusters":{"0":{"directory":"ui","label":"..."}}}`), then `organize "$W\decoded"` from the
  directory holding those JSON files. `cluster-graph --png` does not work in the executable.
- **Compare two versions** of the same application: extract each into
  `<dir>\extracted\`, then
  `bun-demincer diff-versions <dirA> <dirB> --stats --changelog --out report.json`
  (add `--show-diff` for diff text, `--include-vendor` to include npm code). Uses `diff` or falls
  back to `git`; one of them must be installed.
- **Reassemble** modules into one bundle: `bun-demincer resplit --reassemble "$W\decoded" "$W\reassembled.js"`
  (see safety rules before running it).

## Troubleshooting

| Symptom | Cause / action |
|---|---|
| `Could not find Bun trailer!` | Not a Bun-compiled executable (or a packer/compressor was applied). |
| `Could not locate a valid module table` | Unsupported Bun graph layout or corrupted binary; report the `bunVersion`. |
| `Bun runtime: version not found` | Runtime strings stripped or unknown build; extraction may still work. |
| `original sources not recovered` warning | Node-based run older than 22.15; the executable is not affected. |
| `Extracted 0 auto-renames` | Normal for CommonJS-only bundles; rely on manual renaming. |
| `--png needs the "canvas" package` | Run `node <repo>/src/cluster-graph.mjs ... --png` from source instead. |

Long runs: `match-vendors` (loads a 26 MB DB) and `deobfuscate` on thousands of modules can take
minutes; use generous command timeouts and do not retry while a run is still going.

## Reporting to the user

Summarize: Bun version and target format, number of embedded modules and assets, whether
original sources were recovered (and where), vendor/app split with the main npm packages,
location of the readable app code, and any `SKIPPED` warnings.
