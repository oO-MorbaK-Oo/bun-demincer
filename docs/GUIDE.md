# User guide

This guide explains what each step produces, how to read the output, and which steps you
actually need for a given binary. For Bun's internal formats, see [BUN.md](BUN.md).

Commands are shown with the single executable (`bun-demincer <command>`, see
[README](../README.md#single-executable-no-nodejs--npm-needed-on-the-target-machine)). From
source, replace `bun-demincer` with `node src/cli.mjs`; every command accepts `--help`.

> **Safety.** Everything here is static analysis. Never run the binary you are analyzing, and
> never run the extracted or reassembled code unless you trust it.

## 1. Extract

```bash
bun-demincer extract app.exe work/extracted
```

The console reports the target format (PE, Mach-O, ELF), the **Bun runtime version**
(`Bun runtime: v1.3.14 (0d9b296a) Windows x64`) and every embedded file. The output directory
usually contains many files. Only a few matter:

```
work/extracted/
  manifest.json          what was found — start here
  app.js                 the entry bundle: ALL the JavaScript, in one file ("entryFile")
  app.js.jsc             JavaScriptCore bytecode (--bytecode builds; not decompilable, not needed)
  app.js.bunmap          raw embedded sourcemap (Bun binary format)
  _sources/              ORIGINAL source files, when the binary embeds sourcemaps
  <assets>               images, .wasm, .node addons, JSON, fonts... with their real names
```

### Reading `manifest.json`

| Field | Use |
|---|---|
| `bunVersion` | Bun version, git revision and platform of the runtime |
| `entryFile` | the file to pass to `resplit` |
| `modules[]` | every embedded file: virtual `name`, extracted `file`, `loader` (`1` = js, `5` = file asset), sizes |
| `recoveredSources[]` | files decoded into `_sources/` |

Quick summary in PowerShell, from the extraction directory:

```powershell
$m = Get-Content manifest.json -Raw | ConvertFrom-Json
"Bun $($m.bunVersion.version) | entry: $($m.entryFile) | embedded: $($m.modules.Count) | recovered sources: $($m.recoveredSources.Count)"
```

### Decision: do you need the rest of the pipeline?

- **`recoveredSources` is not empty** — the binary was built with `--sourcemap`, and
  `_sources/` holds the original tree (TypeScript, real file names, `node_modules`). Read your
  app code there (typically `_sources/src/`). The remaining steps are optional: they only
  rebuild a readable version of what you already have.
- **`recoveredSources` is empty** — the only JavaScript is the minified entry bundle. Continue
  with steps 2 to 4.

Thousands of extracted files usually mean either a large `_sources/` tree or many assets.
Neither is input for `resplit`: only `entryFile` is.

## 2. Split the bundle (`resplit`)

Bun merges all modules into the entry bundle and wraps the ones that must stay separate
(CommonJS packages, lazily loaded ESM) in small runtime helpers. `resplit` finds those wrappers
and writes one file per module:

```bash
bun-demincer resplit work/extracted/app.js work/resplit
```

```
work/resplit/
  00-runtime.js          Bun runtime helpers (+ any code placed before the first module)
  0001.js ...            one module per file
  0042_SomeExport.js     modules named after their main export when one is known
  99-main.js             top-level code executed at startup
  manifest.json          modules, original positions, exports, dependencies, detected helpers
  graph.json             module dependency graph
```

Bun inlines plain ESM code instead of wrapping it. A small application may therefore produce
only a few modules, with most code in `00-runtime.js` or `99-main.js`. Large applications split
into thousands of modules.

`Export helper: MR() (default, not detected)` means the bundle has no ESM export helper
(CommonJS only). This is not an error.

## 3. Separate npm code (`match-vendors`)

```bash
bun-demincer match-vendors work/resplit --classify
```

Matches each module against a fingerprint database of 1,668 npm packages, then propagates:
a module only called by vendor code is vendor too. Vendor modules move to
`work/resplit/vendor/<package>/`. The modules left at the root of `work/resplit/` are the
application code: focus on them.

The DB `data/vendor-fingerprints-1000.json` is found automatically (repository or next to the
executable). Use `--db <path>` otherwise.

## 4. Deobfuscate (`deobfuscate`)

It works **in place**, so run it on a copy:

```bash
cp -r work/resplit work/decoded          # PowerShell: Copy-Item work/resplit work/decoded -Recurse
bun-demincer deobfuscate --dir work/decoded
```

| Stage | Effect |
|---|---|
| wakaru | `!0` → `true`, `void 0` → `undefined`, and similar syntax cleanup |
| extract | names recovered from Bun's `__export()` maps (`c` → `addNumbers`) |
| extract-names | names recovered from `this.name = "..."` and `displayName = "..."` |
| rename | AST-aware rename of those identifiers across files |
| prettier | formatting |

Vendor files are only touched where a renamed app identifier is referenced.

### Renaming what you understood

```bash
bun-demincer rename oldName newName --dir work/decoded --dry-run
bun-demincer deobfuscate --dir work/decoded --batch my-renames.json --only rename
```

`my-renames.json` is a flat map `{ "minified": "readableName" }`. Renames to invalid
identifiers, reserved words or globals are refused.

`ai-rename` and `ai-rename-scoped` propose names with an LLM. They send the code to Google's
Gemini API (`GEMINI_API_KEY`). Do not use them on confidential code.

## 5. Optional steps

### Organize into directories (large apps)

```bash
bun-demincer extract-deps work/decoded --out deps-graph.json
bun-demincer cluster-graph deps-graph.json --sweep                       # compare resolutions
bun-demincer cluster-graph deps-graph.json --pick 1.5 --out clusters-core
# write cluster-labels.json: {"clusters":{"0":{"directory":"ui","label":"UI rendering"}}}
bun-demincer organize work/decoded                                       # → work/decoded-organized/
```

`organize` reads the three JSON files from the current directory. `cluster-graph --png` needs
the native `canvas` package: run it from source (`node src/cluster-graph.mjs ... --png`).

### Compare two versions

Extract each version into `<version-dir>/extracted/`, then:

```bash
bun-demincer diff-versions v1-dir v2-dir --stats --changelog --out report.json
```

Modules are matched by content (strings, properties, exports), not by minified names.
`--show-diff` adds normalized diffs, `--include-vendor` includes npm code. It needs `diff` or
`git` on the PATH.

### Reassemble

```bash
bun-demincer resplit --reassemble work/decoded work/reassembled.js
```

This rebuilds a single bundle from the module files, in the original order.

## Troubleshooting

| Message | Meaning |
|---|---|
| `Could not find Bun trailer!` | Not a Bun-compiled binary, or it was packed/compressed afterwards |
| `Could not locate a valid module table` | Unsupported Bun graph layout or corrupted file |
| `SKIPPED unsafe module path` | The binary contains path-traversal names (`../`); they were not written. Treat the binary as hostile |
| `original sources not recovered` | Running from source on Node older than 22.15 (no zstd); the executable is not affected |
| `Extracted 0 auto-renames` | Normal for CommonJS-only bundles |
| `refusing to delete ...` (organize) | `--out` points to the input, a root, or a folder that is not a previous `organize` output |
