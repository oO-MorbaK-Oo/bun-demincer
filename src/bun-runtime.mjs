/**
 * Detection of Bun runtime helpers in a bundle.
 *
 * Bun's minifier renames its runtime helpers differently in every build
 * (e.g. the __export helper was "MR" in one build, "u" or "gR" in others),
 * and their parameter names vary too. Helpers are therefore recognized by
 * structure, never by name.
 */

const ID = "[A-Za-z_$][\\w$]*";

/** Name used by older tooling when nothing is detected (historical builds). */
export const DEFAULT_EXPORT_HELPER = "MR";

/**
 * Find the __export helper:
 *   NAME = (target, all) => { for (var name in all) defineProperty(target, name, { get: all[name], ..., configurable: true, ... }) }
 * Arrow and function-declaration forms are accepted. Returns the helper name or null.
 */
export function detectExportHelper(code) {
  const forIn = `\\{\\s*for\\s*\\(\\s*(?:var|let|const)\\s+${ID}\\s+in\\s+\\3\\s*\\)`;
  const patterns = [
    new RegExp(`(?:^|[^\\w$.])(${ID})\\s*=\\s*\\(\\s*(${ID})\\s*,\\s*(${ID})\\s*\\)\\s*=>\\s*${forIn}`, "g"),
    new RegExp(`function\\s+(${ID})\\s*\\(\\s*(${ID})\\s*,\\s*(${ID})\\s*\\)\\s*${forIn}`, "g"),
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(code)) !== null) {
      const body = code.slice(m.index, m.index + 400);
      if (/configurable\s*:/.test(body) && /get\s*:/.test(body)) return m[1];
    }
  }
  return null;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Regex matching the start of a helper call `NAME(target, {` (global flag).
 * The match ends right after the opening brace of the export object.
 */
export function exportCallRegex(helperName) {
  return new RegExp(`(?<![\\w$.])${escapeRegExp(helperName)}\\(\\s*[^,()]+,\\s*\\{`, "g");
}

/**
 * Extract { exportName: localVar } pairs from every `helper(target, { name: () => local })`
 * call in `content`.
 */
export function extractExportPairs(content, helperName) {
  const pairs = [];
  const callRe = exportCallRegex(helperName);
  let match;
  while ((match = callRe.exec(content)) !== null) {
    // Find the matching closing brace, handling nested braces (bodies can be 100K+ chars)
    const startIdx = match.index + match[0].length;
    let depth = 1;
    let endIdx = startIdx;
    while (endIdx < content.length && depth > 0) {
      const ch = content[endIdx];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      endIdx++;
    }
    if (depth !== 0) continue; // unmatched brace, skip

    const body = content.substring(startIdx, endIdx - 1);
    const pairRe = /([A-Za-z_$][\w$]*)\s*:\s*\(\)\s*=>\s*([A-Za-z_$][\w$]*)/g;
    let pairMatch;
    while ((pairMatch = pairRe.exec(body)) !== null) {
      pairs.push({ exportName: pairMatch[1], minifiedVar: pairMatch[2] });
    }
  }
  return pairs;
}
