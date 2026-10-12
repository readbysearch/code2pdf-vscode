// Reads what code2pdf writes while it works. It reports on stderr, one line per step:
//
//   code2pdf: 11 files, 2,918 lines (~62 pages)
//     [1/3] Preparing layout…  0:00 elapsed
//     [2/3] Laying out page 7 of ~62 (10%), 0:02 elapsed
//     [3/3] Writing PDF…  0:05 elapsed, ~0:02 left
//   Done: 61 pages in 0:07 → /path/to/out.pdf
//
// plus "Warning: …", "Note: …" and "Error: …" lines. `-s` prints "Converting to a PDF file for X"
// and "PDF created at X" on stdout instead.

export interface ProgressUpdate {
  /** Shown under the progress title. */
  message?: string;
  /** How much is done, from 0 to 1. */
  fraction?: number;
}

/** Minutes and seconds: 75 -> "1:15". */
export function clock(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The progress message with the time so far: "Laying out page 7 of ~62 (0:21)". */
export function withElapsed(message: string | undefined, seconds: number): string {
  return message ? `${message} (${clock(seconds)})` : `${clock(seconds)} elapsed`;
}

const ELAPSED = /[,\s]+\d+:\d\d elapsed.*$/;

/** What one line of code2pdf output says about progress, if anything. */
export function parseProgress(line: string): ProgressUpdate | undefined {
  const text = line.trim();
  let m = text.match(/^code2pdf: ([\d,]+ files?), [\d,]+ lines? \((~[\d,]+ pages?)\)/);
  if (m) {
    return { message: `${m[1]}, ${m[2]}`, fraction: 0 };
  }
  m = text.match(/^\[(\d)\/3\] (.*)$/);
  if (m) {
    const stage = Number(m[1]);
    const step = m[2].replace(ELAPSED, "").replace(/…$/, "").trim();
    const percent = step.match(/\((\d+)%\)/);
    const message = step.replace(/\s*\(\d+%\)/, "");
    if (stage === 1) {
      return { message, fraction: 0.03 };
    }
    if (stage === 2) {
      return { message, fraction: 0.05 + 0.85 * (percent ? Number(percent[1]) / 100 : 0) };
    }
    return { message, fraction: 0.92 };
  }
  m = text.match(/^in (\d+) parts of/);
  if (m) {
    return { message: `In ${m[1]} parts` };
  }
  if (/^Done: /.test(text) || /^PDF created at /.test(text)) {
    return { fraction: 1 };
  }
  m = text.match(/^Converting to a PDF file for (.*)$/);
  if (m) {
    return { message: m[1] };
  }
  return undefined;
}

/** Collects code2pdf's output as it arrives: progress, warnings, notes, errors and page count. */
export class OutputReader {
  readonly warnings: string[] = [];
  readonly notes: string[] = [];
  readonly errors: string[] = [];
  pages: number | undefined;
  /** Lines that weren't progress, for an error message when there's no "Error:" line. */
  private readonly other: string[] = [];
  private readonly partial = { stdout: "", stderr: "" };

  constructor(private readonly onProgress?: (update: ProgressUpdate) => void) {}

  /** Feed a chunk of output. Lines may be split across chunks. */
  feed(chunk: string, stream: "stdout" | "stderr" = "stderr"): void {
    const lines = (this.partial[stream] + chunk).split(/\r\n|\r|\n/);
    this.partial[stream] = lines.pop() ?? "";
    for (const line of lines) {
      this.line(line);
    }
  }

  /** Call once the process has exited, for last lines without a newline. */
  end(): void {
    for (const stream of ["stdout", "stderr"] as const) {
      if (this.partial[stream]) {
        this.line(this.partial[stream]);
        this.partial[stream] = "";
      }
    }
  }

  private line(line: string): void {
    const text = line.trim();
    if (!text) {
      return;
    }
    const update = parseProgress(line);
    if (update) {
      this.onProgress?.(update);
    }
    const done = text.match(/^Done: ([\d,]+) pages? in /);
    if (done) {
      this.pages = Number(done[1].replace(/,/g, ""));
      return;
    }
    if (update) {
      return;
    }
    if (text.startsWith("Warning: ")) {
      addOnce(this.warnings, text.slice("Warning: ".length));
    } else if (text.startsWith("Note: ")) {
      addOnce(this.notes, text.slice("Note: ".length));
    } else if (text.startsWith("Error: ")) {
      addOnce(this.errors, text.slice("Error: ".length));
    } else {
      this.other.push(text);
    }
  }

  /** The best one-line explanation of a failure, if code2pdf gave one. */
  errorMessage(): string | undefined {
    return this.errors[0] ?? this.other[this.other.length - 1];
  }
}

function addOnce(list: string[], text: string): void {
  if (!list.includes(text)) {
    list.push(text);
  }
}
