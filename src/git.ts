// The choices for "Print Changes to PDF…", read from git. No vscode imports.

import { execFile } from "node:child_process";
import * as path from "node:path";
import { fileNamePart } from "./specs";

export class GitError extends Error {}

/** Runs git in CWD and returns its output, without the final newline. */
export function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        reject(new GitError(code === "ENOENT" ? "git isn't installed" : stderr.trim() || error.message));
      } else {
        resolve(stdout.replace(/\n$/, ""));
      }
    });
  });
}

/** git's answer, or undefined if git says no. */
async function maybe(cwd: string, args: readonly string[]): Promise<string | undefined> {
  try {
    return await git(cwd, args);
  } catch (error) {
    if (error instanceof GitError && error.message === "git isn't installed") {
      throw error;
    }
    return undefined;
  }
}

/** The top folder of the repository FOLDER is in, or undefined if it isn't in one. */
export function repositoryRoot(folder: string): Promise<string | undefined> {
  return maybe(folder, ["rev-parse", "--show-toplevel"]);
}

/** Whether REV names a commit (a hash, tag, branch, HEAD~2, …). */
export async function isCommit(folder: string, rev: string): Promise<boolean> {
  return !rev.startsWith("-") && (await maybe(folder, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])) !== undefined;
}

export interface ChangeChoice {
  label: string;
  description?: string;
  detail?: string;
  /** For `code2pdf --changed`: changes made since this commit are printed. */
  rev: string;
  /** For the PDF's file name. */
  name: string;
}

export interface Commit {
  hash: string;
  short: string;
  subject: string;
  when: string;
  /** The first parent's hash, or undefined for a root commit. */
  parent?: string;
}

/** Recent commits, newest first. */
export async function recentCommits(folder: string, count = 30): Promise<Commit[]> {
  const out = await maybe(folder, ["log", `-n${count}`, "--format=%H%x1f%h%x1f%s%x1f%cr%x1f%P"]);
  if (!out) {
    return [];
  }
  return out.split("\n").map((line) => {
    const [hash, short, subject, when, parents] = line.split("\x1f");
    return { hash, short, subject, when, parent: parents.split(" ")[0] || undefined };
  });
}

/** The branch this one was made from: origin's default branch, or a local main or master. */
async function baseBranch(folder: string): Promise<string | undefined> {
  const remoteHead = await maybe(folder, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead) {
    return remoteHead;
  }
  for (const name of ["main", "master"]) {
    if (await maybe(folder, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])) {
      return name;
    }
  }
  return undefined;
}

export interface Choices {
  /** The fixed choices: uncommitted changes, the last commit, this branch. */
  main: ChangeChoice[];
  /** Recent commits: picking one prints it and everything after it. */
  commits: ChangeChoice[];
}

/** What FOLDER's repository offers to print. Empty when it has no commits yet. */
export async function changeChoices(folder: string): Promise<Choices> {
  const repo = fileNamePart(path.basename((await repositoryRoot(folder)) ?? folder));
  const commits = await recentCommits(folder);
  if (!commits.length) {
    return { main: [], commits: [] };
  }
  const head = commits[0];
  const main: ChangeChoice[] = [];

  // Changes to tracked files only: code2pdf leaves untracked files out, with a note
  const status = (await maybe(folder, ["status", "--porcelain", "--", "."])) ?? "";
  const lines = status.split("\n").filter(Boolean);
  const untracked = lines.filter((l) => l.startsWith("??")).length;
  const changed = lines.length - untracked;
  if (changed) {
    const stat = (await maybe(folder, ["diff", "HEAD", "--shortstat", "--", "."]))?.trim();
    main.push({
      label: "Uncommitted changes",
      description: stat,
      detail: untracked ? `New files that aren't added to git yet are left out (${untracked}); git add them to include them` : undefined,
      rev: "HEAD",
      name: `${repo}-uncommitted`,
    });
  }

  if (head.parent) {
    main.push({
      label: "The last commit",
      description: `${head.short} ${head.subject}`,
      detail: changed ? "With your uncommitted changes too: code2pdf compares with the files as they are now" : undefined,
      rev: head.parent,
      name: `${repo}-${head.short}`,
    });
  }

  const branch = await maybe(folder, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const base = await baseBranch(folder);
  if (branch && branch !== "HEAD" && base && base !== branch && base.replace(/^origin\//, "") !== branch) {
    const fork = await maybe(folder, ["merge-base", "HEAD", base]);
    const ahead = fork && fork !== head.hash ? Number(await maybe(folder, ["rev-list", "--count", `${fork}..HEAD`])) : 0;
    if (fork && ahead > 0) {
      main.push({
        label: `This branch, ${branch}`,
        description: `${ahead} commit${ahead === 1 ? "" : "s"} since it left ${base}`,
        rev: fork,
        name: `${repo}-${fileNamePart(branch)}`,
      });
    }
  }

  const fromCommits = commits
    .filter((c) => c.parent)
    .map((c) => ({
      label: c.subject,
      description: `${c.short}, ${c.when}`,
      rev: c.parent as string,
      name: `${repo}-from-${c.short}`,
    }));
  return { main, commits: fromCommits };
}
