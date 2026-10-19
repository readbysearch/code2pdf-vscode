// Anonymous usage events, sent to Azure Application Insights. extension.ts sends them through
// VS Code's telemetry logger, which calls the sender only when telemetry is on in VS Code, and
// only from an installed extension (not under test or while debugging); the code2pdf.telemetry
// setting turns them off for this extension alone. No vscode imports.
//
// No event can be tied to a person: there's no ID that outlives the session, and Azure is asked
// not to look up a location (see tags()). PRIVACY.md says the same to users.
//
// EVENTS is the whole list of what may be sent: the sender drops any other field, so nothing
// undocumented leaves the machine. README.md ("Usage data") and telemetry.json describe the
// same fields; a unit test checks telemetry.json against EVENTS.

import { randomUUID } from "node:crypto";

/** From the Application Insights resource's Overview page. Empty: nothing is sent. */
export const CONNECTION_STRING: string =
  "InstrumentationKey=00187544-2f5b-4ad5-949b-9b7b887d190e;IngestionEndpoint=https://swedencentral-0.in.applicationinsights.azure.com/;LiveEndpoint=https://swedencentral.livediagnostics.monitor.azure.com/;ApplicationId=7c1adc78-5335-4eb0-aef8-4aaed8fcb09c";

/** Sent with every event. */
export const COMMON = ["extension", "vscode", "app", "platform", "arch", "remote"] as const;

/** Each event and its fields. Names and values only: never paths, file names or code. */
export const EVENTS = {
  /** Once each time the extension starts: is code2pdf there, and how could it be installed? */
  activated: ["cli", "cliVersion", "installKind", "homebrew", "distro", "firstActivation"],
  /** The install or update message was answered (or closed). */
  installOffered: ["reason", "from", "offered", "choice"],
  /** An install started from a message finished, or 30 minutes passed without one. */
  installFinished: ["outcome", "command", "seconds", "cliVersion", "installKind"],
  /** A print ended, or its save dialog was closed. */
  print: ["kind", "outcome", "saveTo", "openWith", "seconds", "pages", "warnings", "exitCode", "error"],
} as const;

export type EventName = keyof typeof EVENTS;
export type EventData<E extends EventName> = Partial<Record<(typeof EVENTS)[E][number], string | number | boolean>>;

/**
 * Sent with every event: a random ID for this session, made when the extension starts and never
 * saved, so events can't be linked across sessions; and 0.0.0.0 as the address for Azure to
 * look up a location for, instead of the connection's.
 */
export function tags(version: string, session: string = randomUUID()): Record<string, string> {
  return { "ai.session.id": session, "ai.application.ver": version, "ai.location.ip": "0.0.0.0" };
}

/** Where events go. */
export interface Target {
  iKey: string;
  url: string;
}

/** The instrumentation key and ingestion URL in a connection string, or undefined without a key. */
export function parseConnectionString(text: string): Target | undefined {
  const fields = new Map<string, string>();
  for (const part of text.split(";")) {
    const at = part.indexOf("=");
    if (at > 0) {
      fields.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim());
    }
  }
  const iKey = fields.get("instrumentationkey");
  if (!iKey) {
    return undefined;
  }
  const endpoint = fields.get("ingestionendpoint") || "https://dc.services.visualstudio.com/";
  return { iKey, url: new URL("v2/track", endpoint.endsWith("/") ? endpoint : `${endpoint}/`).toString() };
}

/**
 * One event as Application Insights takes it. NAME comes from the logger as
 * "readbysearch.code2pdf/print"; numbers become measurements, everything else properties.
 */
export function envelope(target: Target, name: string, data: Record<string, unknown>, tags: Record<string, string>, time: Date) {
  const event = name.slice(name.indexOf("/") + 1);
  const allowed = new Set<string>([...COMMON, ...((EVENTS as Record<string, readonly string[]>)[event] ?? [])]);
  const properties: Record<string, string> = {};
  const measurements: Record<string, number> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!allowed.has(key) || value === undefined || value === null) {
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      measurements[key] = value;
    } else {
      properties[key] = String(value);
    }
  }
  return {
    name: "Microsoft.ApplicationInsights.Event",
    time: time.toISOString(),
    iKey: target.iKey,
    tags,
    data: { baseType: "EventData", baseData: { ver: 2, name: event, properties, measurements } },
  };
}

export type Post = (url: string, body: string) => Promise<unknown>;

const post: Post = (url, body) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(10_000) });

/**
 * A vscode.TelemetrySender. Each event is posted on its own (there are a few per print), and a
 * failed post is dropped: usage data is never worth an error message.
 */
export function sender(target: Target, tags: Record<string, string>, send: Post = post) {
  const pending = new Set<Promise<unknown>>();
  return {
    sendEventData(name: string, data?: Record<string, unknown>): void {
      const sent = send(target.url, JSON.stringify([envelope(target, name, data ?? {}, tags, new Date())])).catch(() => undefined);
      pending.add(sent);
      void sent.finally(() => pending.delete(sent));
    },
    /** Not used: the logger is made with ignoreUnhandledErrors, and errors are never logged. */
    sendErrorData(): void {},
    async flush(): Promise<void> {
      await Promise.all(pending);
    },
  };
}
