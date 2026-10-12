// code2pdf command lines for each kind of print. Pure, so the unit tests can check them.

import { argPath } from "./specs";

/** The settings that change code2pdf's command line. */
export interface PrintSettings {
  theme: string;
  include: readonly string[];
  exclude: readonly string[];
  /** From the settings of version 1, if the user set any. */
  legacy: LegacySettings;
}

/** Version 1's settings. Only values the user set are passed; their old defaults are now code2pdf's. */
export interface LegacySettings {
  blacklistedFolders?: readonly string[];
  blacklistedFolderPattern?: string;
  whitelistedFileExtensions?: readonly string[];
  whitelistedFileNames?: readonly string[];
}

/** code2pdf options with the same effect as version 1's settings. */
export function legacyArgs(legacy: LegacySettings): string[] {
  const args: string[] = [];
  const folders = clean(legacy.blacklistedFolders);
  if (folders.length) {
    args.push("--ignore-folders", folders.join(","));
  }
  const pattern = legacy.blacklistedFolderPattern?.trim();
  if (pattern && pattern !== "env*") {  // env* folders are skipped by default
    args.push("--exclude", pattern);
  }
  const extensions = clean(legacy.whitelistedFileExtensions).map((e) => e.replace(/^\*?\./, ""));
  if (extensions.length) {
    args.push("--include-types", extensions.join(","));
  }
  for (const name of clean(legacy.whitelistedFileNames)) {
    args.push("--include", name);
  }
  return args;
}

function clean(list: readonly string[] | undefined): string[] {
  return (list ?? []).map((s) => s.trim()).filter(Boolean);
}

function themeArgs(theme: string): string[] {
  const name = theme.trim();
  return name && name !== "paper" ? ["--theme", name] : [];
}

function excludeArgs(exclude: readonly string[]): string[] {
  return clean(exclude).flatMap((glob) => ["--exclude", glob]);
}

/** Options that choose a folder's files. */
export function selectionArgs(settings: PrintSettings): string[] {
  return [
    ...clean(settings.include).flatMap((glob) => ["--include", glob]),
    ...excludeArgs(settings.exclude),
    ...legacyArgs(settings.legacy),
  ];
}

/** One file, or part of one (`app.py:10-40`). */
export function fileArgs(spec: string, output: string, settings: PrintSettings): string[] {
  return ["-s", argPath(spec), "-o", output, ...themeArgs(settings.theme)];
}

/** A folder, with code2pdf's default selection and the include and exclude settings. */
export function folderArgs(folder: string, output: string, settings: PrintSettings): string[] {
  return ["-a", argPath(folder), "-o", output, ...themeArgs(settings.theme), ...selectionArgs(settings)];
}

/** The files `folderArgs` would print, without printing them. */
export function listArgs(folder: string, settings: PrintSettings): string[] {
  return ["-a", argPath(folder), "--list-files", ...selectionArgs(settings)];
}

/** Exactly the files given on stdin, relative to FOLDER, in that order. */
export function filesFromArgs(folder: string, output: string, settings: PrintSettings): string[] {
  return ["-a", argPath(folder), "--files-from", "-", "-o", output, ...themeArgs(settings.theme)];
}

/** What changed in FOLDER since REV, with the changed lines marked. */
export function changedArgs(rev: string, folder: string, output: string, settings: PrintSettings): string[] {
  return ["--changed", rev, "-a", argPath(folder), "-o", output, ...themeArgs(settings.theme),
    ...excludeArgs(settings.exclude)];
}

/** A command line for the output log, quoted the way a shell would need it. */
export function shellQuote(args: readonly string[]): string {
  return args.map((a) => (/^[\w@%+=:,./~-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}
