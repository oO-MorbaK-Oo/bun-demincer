import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import zlib from "zlib";
import { resolveInside } from "./path-guard.mjs";

const TRAILER = "\n---- Bun! ----\n";
const SECTION_HEADER_SIZE = 8; // u64 size header in front of the __BUN / .bun section data
const OFFSETS_SIZE = 32;

const binaryPath = process.argv[2];
if (!binaryPath) {
  console.error("Usage: node extract.mjs <bun-binary> [output-dir]");
  process.exit(1);
}
const outDir = process.argv[3] || "./extracted";

console.log(`Reading binary: ${binaryPath}`);
const buf = readFileSync(binaryPath);
const fileSize = buf.length;
console.log(`Binary size: ${(fileSize / 1024 / 1024).toFixed(1)} MB`);

// --- Step 1: Locate the Bun section (Mach-O __BUN/__bun or PE .bun) ---

/** Mach-O: look for a "__bun" section header in segment "__BUN" in the load commands. */
function findMachOSection() {
  for (let i = 0; i < Math.min(fileSize, 8192) - 56; i++) {
    if (buf[i] === 0x5f && buf[i+1] === 0x5f && buf[i+2] === 0x62 &&
        buf[i+3] === 0x75 && buf[i+4] === 0x6e && buf[i+5] === 0x00 &&
        buf[i+16] === 0x5f && buf[i+17] === 0x5f && buf[i+18] === 0x42 &&
        buf[i+19] === 0x55 && buf[i+20] === 0x4e) {
      // section_64: sectname(16) segname(16) addr(8) size(8) offset(4) ...
      return {
        format: "Mach-O",
        offset: buf.readUInt32LE(i + 48),
        size: Number(buf.readBigUInt64LE(i + 40)),
      };
    }
  }
  return null;
}

/** PE (Windows .exe): walk the section table and return the ".bun" section. */
function findPESection() {
  if (fileSize < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) return null; // "MZ"
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 > fileSize || buf.readUInt32LE(pe) !== 0x00004550) return null; // "PE\0\0"
  const numSections = buf.readUInt16LE(pe + 6);
  const sectionTable = pe + 24 + buf.readUInt16LE(pe + 20);
  for (let i = 0; i < numSections; i++) {
    const s = sectionTable + i * 40;
    if (s + 40 > fileSize) break;
    const name = buf.subarray(s, s + 8).toString("latin1").replace(/\0+$/, "");
    if (name === ".bun") {
      return {
        format: "PE",
        offset: buf.readUInt32LE(s + 20), // PointerToRawData
        size: buf.readUInt32LE(s + 16),   // SizeOfRawData (file-aligned)
      };
    }
  }
  return null;
}

/**
 * Detect the Bun runtime version statically (without running the binary) from
 * the banner string compiled into every Bun build: "Bun v1.3.14 (0d9b296a) Windows x64".
 * Falls back to the "Bun/1.3.14" user-agent string.
 */
function detectBunVersion() {
  const bannerRe = /^Bun v(\d+\.\d+\.\d+(?:-[\w.]+)?) \(([0-9a-f]{7,40})\)(?: ([\w .-]+))?/;
  const marker = Buffer.from("Bun v");
  for (let i = buf.indexOf(marker); i >= 0; i = buf.indexOf(marker, i + 1)) {
    const m = buf.subarray(i, i + 96).toString("latin1").match(bannerRe);
    if (m) return { version: m[1], revision: m[2], platform: m[3]?.trim() || null };
  }
  const uaRe = /^Bun\/(\d+\.\d+\.\d+(?:-[\w.]+)?)\0/;
  const ua = Buffer.from("Bun/");
  for (let i = buf.indexOf(ua); i >= 0; i = buf.indexOf(ua, i + 1)) {
    const m = buf.subarray(i, i + 40).toString("latin1").match(uaRe);
    if (m) return { version: m[1], revision: null, platform: null };
  }
  return null;
}

const bunVersion = detectBunVersion();
console.log(
  bunVersion
    ? `Bun runtime: v${bunVersion.version}${bunVersion.revision ? ` (${bunVersion.revision})` : ""}${bunVersion.platform ? ` ${bunVersion.platform}` : ""}`
    : "Bun runtime: version not found",
);

const section = findMachOSection() || findPESection();
if (section) {
  console.log(`Found ${section.format} Bun section: offset=${section.offset}, size=${section.size}`);
} else {
  console.log("No Mach-O/PE Bun section found (ELF or unknown), searching for trailer directly...");
}

// --- Step 2: Find the trailer ---
// Search inside the section when known (signed binaries may have data after it),
// otherwise the last occurrence in the whole file.
const trailerBuf = Buffer.from(TRAILER);
let trailerOffset = -1;
if (section) {
  const end = Math.min(fileSize, section.offset + section.size);
  const idx = buf.subarray(section.offset, end).lastIndexOf(trailerBuf);
  if (idx >= 0) trailerOffset = section.offset + idx;
}
if (trailerOffset === -1) trailerOffset = buf.lastIndexOf(trailerBuf);
if (trailerOffset < OFFSETS_SIZE) {
  console.error("Could not find Bun trailer!");
  process.exit(1);
}
console.log(`Trailer at offset: ${trailerOffset}`);

// --- Step 3: Read Offsets struct (32 bytes before trailer) ---
// Offsets = { byte_count: u64, modules_ptr: {u32,u32}, entry_point_id: u32,
//             exec_argv_ptr: {u32,u32}, flags: u32 }
const os = trailerOffset - OFFSETS_SIZE;
const byteCount = Number(buf.readBigUInt64LE(os));
const modOffset = buf.readUInt32LE(os + 8);
const modLength = buf.readUInt32LE(os + 12);
const entryPointId = buf.readUInt32LE(os + 16);
const flags = buf.readUInt32LE(os + 28);

console.log(`\nOffsets: byteCount=${byteCount}, modules={off:${modOffset},len:${modLength}}, entry=${entryPointId}, flags=0x${flags.toString(16)}`);

// --- Step 4: Calculate data_start and module entry layout ---
// StringPointer offsets are relative to the start of the data buffer. byte_count
// covers the data buffer only (not the Offsets struct nor the trailer), so
// data_start = offsets_start - byte_count. The section-based value is tried first.

// Virtual root prefixes: /$bunfs/root/ (POSIX) and B:/~BUN/root/ (Windows)
const BUNFS_ROOT_RE = /^(?:\/?\$bunfs[\\/]root[\\/]|[A-Za-z]:[\\/]~BUN[\\/]root[\\/])/;

function readModuleTable(dataStart, entrySize) {
  const numModules = Math.floor(modLength / entrySize);
  if (numModules === 0 || modLength % entrySize !== 0) return null;
  const inData = (off, len) => off + len <= byteCount && dataStart + off + len <= fileSize;
  const modules = [];
  for (let i = 0; i < numModules; i++) {
    const base = dataStart + modOffset + i * entrySize;
    if (base < 0 || base + entrySize > fileSize) return null;
    const ptr = (k) => ({ off: buf.readUInt32LE(base + k * 8), len: buf.readUInt32LE(base + k * 8 + 4) });
    const name = ptr(0), cont = ptr(1), smap = ptr(2), bc = ptr(3);
    if (![name, cont, smap, bc].every((p) => inData(p.off, p.len))) return null;
    const nameStr = buf.subarray(dataStart + name.off, dataStart + name.off + name.len).toString("utf-8");
    if (!BUNFS_ROOT_RE.test(nameStr)) return null;
    const flagsBase = base + entrySize - 4;
    modules.push({
      index: i,
      name: nameStr,
      contOff: cont.off, contLen: cont.len,
      smapOff: smap.off, smapLen: smap.len,
      bcOff: bc.off, bcLen: bc.len,
      encoding: buf[flagsBase],      // 0=binary, 1=latin1, 2=utf8
      loader: buf[flagsBase + 1],    // see LOADER_NAMES
      modFormat: buf[flagsBase + 2], // 0=none, 1=esm, 2=cjs
      side: buf[flagsBase + 3],      // 0=server, 1=client
      isEntry: i === entryPointId,
    });
  }
  return modules;
}

const dataStartCandidates = [];
if (section) dataStartCandidates.push(section.offset + SECTION_HEADER_SIZE);
dataStartCandidates.push(os - byteCount);
dataStartCandidates.push(trailerOffset + trailerBuf.length - byteCount); // legacy computation

let dataStart = -1;
let modules = null;
let entrySize = 0;
// 52-byte entries since Bun ~1.2 (two extra StringPointers), 36-byte entries before
outer: for (const candidate of dataStartCandidates) {
  for (const size of [52, 36]) {
    const parsed = readModuleTable(candidate, size);
    if (parsed) {
      dataStart = candidate;
      modules = parsed;
      entrySize = size;
      break outer;
    }
  }
}
if (!modules) {
  console.error("Could not locate a valid module table (unsupported Bun version or corrupted binary)");
  process.exit(1);
}
console.log(`Data starts at: ${dataStart} (module entry size: ${entrySize} bytes)`);

// --- Step 5: Report module table ---
// Loader enum values that are stable across Bun versions
const LOADER_NAMES = { 0: "jsx", 1: "js", 2: "ts", 3: "tsx", 4: "css", 5: "file", 6: "json", 9: "wasm", 10: "napi" };
const JS_LOADERS = new Set([0, 1, 2, 3]);
const formatNames = { 0: "none", 1: "esm", 2: "cjs" };
const encNames = { 0: "binary", 1: "latin1", 2: "utf8" };

console.log(`\nModules: ${modules.length}`);
for (const mod of modules) {
  console.log(`  [${mod.index}]${mod.isEntry ? " ENTRY" : ""} ${mod.name}`);
  console.log(`      source: ${(mod.contLen/1024).toFixed(1)}KB | bytecode: ${(mod.bcLen/1024).toFixed(1)}KB | loader: ${LOADER_NAMES[mod.loader] || mod.loader} | format: ${formatNames[mod.modFormat] || mod.modFormat} | enc: ${encNames[mod.encoding] || mod.encoding} | side: ${mod.side === 0 ? "server" : "client"}`);
}

mkdirSync(outDir, { recursive: true });

// --- Step 6: Extract files ---
console.log(`\nExtracting to ${outDir}/...`);

const slice = (off, len) => buf.subarray(dataStart + off, dataStart + off + len);
const sizeStr = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${(n / 1024).toFixed(1)}KB`);
const hasZstd = typeof zlib.zstdDecompressSync === "function";
let warnedNoZstd = false;

/**
 * Decode Bun's serialized sourcemap blob:
 *   u32 file_count, u32 mappings_len,
 *   file_count x StringPointer (file names), file_count x StringPointer (zstd sources),
 *   mappings bytes...
 * Returns [{ name, content }] with original (pre-bundle) sources, or null.
 */
function decodeSourceMapSources(smap) {
  if (smap.length < 8) return null;
  const count = smap.readUInt32LE(0);
  if (count === 0 || 8 + count * 16 > smap.length) return null;
  const sources = [];
  for (let i = 0; i < count; i++) {
    const nOff = smap.readUInt32LE(8 + i * 8), nLen = smap.readUInt32LE(12 + i * 8);
    const cOff = smap.readUInt32LE(8 + count * 8 + i * 8), cLen = smap.readUInt32LE(12 + count * 8 + i * 8);
    if (nOff + nLen > smap.length || cOff + cLen > smap.length) return null;
    const name = smap.subarray(nOff, nOff + nLen).toString("utf-8");
    let content = null;
    if (cLen > 0) {
      // Cap output size so a hostile blob cannot exhaust memory
      content = zlib.zstdDecompressSync(smap.subarray(cOff, cOff + cLen), { maxOutputLength: 256 * 1024 * 1024 });
    }
    sources.push({ name, content });
  }
  return sources;
}

const recoveredSources = [];
const usedPaths = new Set();

for (const mod of modules) {
  if (mod.contLen === 0) continue;

  // Strip the virtual root and normalize Windows separators
  let relPath = mod.name.replace(BUNFS_ROOT_RE, "").replace(/\\/g, "/");
  // On Windows the entry bundle is named after the executable (app.exe): give JS a .js name
  if (JS_LOADERS.has(mod.loader) && !/\.[cm]?[jt]sx?$/i.test(relPath)) {
    relPath = relPath.replace(/\.exe$/i, "") + ".js";
  }

  // Module names come from the binary itself: never let them escape outDir
  const outPath = resolveInside(outDir, relPath);
  if (!outPath) {
    console.warn(`  SKIPPED unsafe module path: ${JSON.stringify(mod.name)}`);
    continue;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  mod.file = relPath;
  usedPaths.add(outPath.toLowerCase());

  // Latin-1 encoded JS is re-encoded to UTF-8 so downstream tools read it correctly
  let content = slice(mod.contOff, mod.contLen);
  if (mod.encoding === 1 && JS_LOADERS.has(mod.loader) && content.some((b) => b >= 0x80)) {
    content = Buffer.from(content.toString("latin1"), "utf-8");
  }
  writeFileSync(outPath, content);
  console.log(`  ${relPath} (${sizeStr(mod.contLen)})`);

  // JavaScriptCore bytecode (--bytecode builds), kept for reference
  if (mod.bcLen > 0) {
    writeFileSync(outPath + ".jsc", slice(mod.bcOff, mod.bcLen));
    console.log(`  ${relPath}.jsc (${sizeStr(mod.bcLen)})`);
  }

  if (mod.smapLen > 0) {
    const smap = slice(mod.smapOff, mod.smapLen);
    // Raw blob is Bun's binary format, not a JSON .map
    writeFileSync(outPath + ".bunmap", smap);
    console.log(`  ${relPath}.bunmap (${sizeStr(mod.smapLen)})`);

    if (!hasZstd) {
      if (!warnedNoZstd) console.warn("  Warning: Node lacks zlib.zstdDecompressSync (needs >= 22.15), original sources not recovered");
      warnedNoZstd = true;
      continue;
    }
    let sources;
    try {
      sources = decodeSourceMapSources(smap);
    } catch (err) {
      console.warn(`  Warning: could not decode sourcemap of ${relPath}: ${err.message}`);
      continue;
    }
    for (const src of sources || []) {
      if (!src.content) continue;
      const srcRel = join("_sources", src.name.replace(/\\/g, "/").replace(/^(?:[A-Za-z]:)?\/+/, ""));
      const srcPath = resolveInside(outDir, srcRel);
      if (!srcPath || usedPaths.has(srcPath.toLowerCase())) {
        console.warn(`  SKIPPED unsafe source path: ${JSON.stringify(src.name)}`);
        continue;
      }
      usedPaths.add(srcPath.toLowerCase());
      mkdirSync(dirname(srcPath), { recursive: true });
      writeFileSync(srcPath, src.content);
      recoveredSources.push({ module: relPath, name: src.name, size: src.content.length });
    }
  }
}

if (recoveredSources.length > 0) {
  console.log(`\nRecovered ${recoveredSources.length} original source file(s) from sourcemaps into ${join(outDir, "_sources")}`);
}

// --- Step 7: Write manifest ---
const entry = modules[entryPointId];
const manifest = {
  binaryPath,
  format: section?.format || "unknown",
  bunVersion,
  entryPoint: entry?.name,
  entryFile: entry?.file,
  entryPointId,
  flags,
  moduleEntrySize: entrySize,
  modules: modules.map(m => ({
    index: m.index,
    name: m.name,
    file: m.file,
    sourceSize: m.contLen,
    bytecodeSize: m.bcLen,
    sourcemapSize: m.smapLen,
    isEntry: m.isEntry,
    encoding: m.encoding,
    loader: m.loader,
    format: m.modFormat,
    side: m.side,
  })),
  recoveredSources,
};
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`\nManifest: ${outDir}/manifest.json`);
if (entry?.file) console.log(`Entry bundle (input for resplit.mjs): ${join(outDir, entry.file)}`);
console.log("Done!");
