// Pure helpers for what to print and what to call it. Nothing here imports vscode, so the unit
// tests run in plain Node.

import * as path from "node:path";

/** Lines START to END, counted from 1, both included. */
export interface LineRange {
  start: number;
  end: number;
}

/** The parts of a VS Code selection that matter here (lines counted from 0, as VS Code does). */
export interface SelectionLike {
  startLine: number;
  endLine: number;
  endCharacter: number;
  isEmpty: boolean;
}

/**
 * The lines to print for an editor's selections: counted from 1, sorted, overlaps merged.
 * A selection that ends at the very start of a line (as when whole lines are selected by
 * dragging down) doesn't include that line.
 */
export function selectionRanges(selections: readonly SelectionLike[]): LineRange[] {
  const ranges = selections
    .filter((s) => !s.isEmpty)
    .map((s) => {
      const last = s.endCharacter === 0 && s.endLine > s.startLine ? s.endLine - 1 : s.endLine;
      return { start: s.startLine + 1, end: last + 1 };
    })
    .sort((a, b) => a.start - b.start);
  const merged: LineRange[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** code2pdf's way to name part of a file: `src/app.py:10-40,90-120`. */
export function rangeSpec(file: string, ranges: readonly LineRange[]): string {
  const parts = ranges.map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`));
  return `${file}:${parts.join(",")}`;
}

/** A path as code2pdf should see it: forward slashes, and never taken for an option. */
export function argPath(p: string): string {
  const slashed = p.split(path.sep).join("/");
  return slashed.startsWith("-") ? `./${slashed}` : slashed;
}

/** FILE relative to ROOT with forward slashes ("." for ROOT itself). */
export function relativePath(root: string, file: string): string {
  const rel = path.relative(root, file);
  return rel === "" ? "." : rel.split(path.sep).join("/");
}

/** Whether FILE is ROOT or inside it. */
export function isInside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The deepest folder that contains all of PATHS (each a file or folder). */
export function commonFolder(paths: readonly string[], isFolder: (p: string) => boolean): string {
  const folders = paths.map((p) => (isFolder(p) ? p : path.dirname(p)));
  let common = folders[0] ?? "";
  for (const folder of folders.slice(1)) {
    while (!isInside(common, folder)) {
      const parent = path.dirname(common);
      if (parent === common) {
        break;
      }
      common = parent;
    }
  }
  return common;
}

/** Sorts relative paths as code2pdf walks a folder: depth first, each folder's entries by name. */
export function treeOrder(a: string, b: string): number {
  const pa = a.split("/");
  const pb = b.split("/");
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return pa.length - pb.length;
}

/** The items of LIST in order, without repeats. */
export function unique<T>(list: readonly T[]): T[] {
  return [...new Set(list)];
}

/** A safe file name: letters, digits, dots, dashes and underscores only. */
export function fileNamePart(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "code";
}

/** The file's name without its last extension, as code2pdf names a single file's PDF. */
export function stem(file: string): string {
  const base = path.basename(file);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** The PDF name for part of FILE: `app-lines-10-40.pdf`. */
export function selectionPdfName(file: string, ranges: readonly LineRange[]): string {
  const first = ranges[0]?.start ?? 1;
  const last = ranges[ranges.length - 1]?.end ?? first;
  return `${fileNamePart(stem(file))}-lines-${first}-${last}.pdf`;
}

/** Expands a leading `~` to HOME. */
export function expandHome(p: string, home: string): string {
  return p === "~" ? home : p.replace(/^~(?=[/\\])/, home);
}
