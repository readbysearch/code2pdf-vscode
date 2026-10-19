import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { COMMON, CONNECTION_STRING, EVENTS, envelope, parseConnectionString, sender, tags } from "../../telemetry";

const TARGET = { iKey: "00000000-1111-2222-3333-444444444444", url: "https://westeurope-5.in.applicationinsights.azure.com/v2/track" };

test("connection string: key and ingestion URL", () => {
  assert.deepEqual(
    parseConnectionString(`InstrumentationKey=${TARGET.iKey};IngestionEndpoint=https://westeurope-5.in.applicationinsights.azure.com/;LiveEndpoint=https://westeurope.livediagnostics.monitor.azure.com/;ApplicationId=abc`),
    TARGET);
  assert.equal(parseConnectionString(`InstrumentationKey=k;IngestionEndpoint=https://example.com/ingest`)?.url, "https://example.com/ingest/v2/track");
  assert.equal(parseConnectionString("InstrumentationKey=k")?.url, "https://dc.services.visualstudio.com/v2/track");
  assert.equal(parseConnectionString(""), undefined, "an empty string sends nothing");
  assert.equal(parseConnectionString("IngestionEndpoint=https://example.com/"), undefined);
});

test("the connection string in telemetry.ts is empty or parses", () => {
  assert.ok(CONNECTION_STRING === "" || parseConnectionString(CONNECTION_STRING));
});

test("envelope: Application Insights' event shape; numbers are measurements", () => {
  const time = new Date("2026-10-14T12:00:00Z");
  const sent = envelope(TARGET, "readbysearch.code2pdf/print",
    { kind: "folder", outcome: "printed", pages: 12, seconds: 3.4, platform: "darwin", saveTo: undefined }, { "ai.session.id": "s" }, time);
  assert.deepEqual(sent, {
    name: "Microsoft.ApplicationInsights.Event",
    time: "2026-10-14T12:00:00.000Z",
    iKey: TARGET.iKey,
    tags: { "ai.session.id": "s" },
    data: { baseType: "EventData", baseData: { ver: 2, name: "print", properties: { kind: "folder", outcome: "printed", platform: "darwin" }, measurements: { pages: 12, seconds: 3.4 } } },
  });
});

test("envelope: fields that aren't listed for the event are never sent", () => {
  const sent = envelope(TARGET, "readbysearch.code2pdf/activated", { cli: "found", file: "/Users/me/secret.py", pages: 3, homebrew: true }, {}, new Date());
  assert.deepEqual(sent.data.baseData.properties, { cli: "found", homebrew: "true" });
  assert.deepEqual(sent.data.baseData.measurements, {});
  const unknown = envelope(TARGET, "readbysearch.code2pdf/somethingElse", { cli: "found", arch: "arm64" }, {}, new Date());
  assert.deepEqual(unknown.data.baseData.properties, { arch: "arm64" }, "an unlisted event carries only the common fields");
});

test("tags: a new ID each session, no user ID, and no address to look up a location from", () => {
  const first = tags("2.0.1");
  assert.deepEqual(Object.keys(first).sort(), ["ai.application.ver", "ai.location.ip", "ai.session.id"]);
  assert.equal(first["ai.location.ip"], "0.0.0.0");
  assert.notEqual(tags("2.0.1")["ai.session.id"], first["ai.session.id"]);
});

test("sender: one POST per event; a failed POST is dropped quietly", async () => {
  const posts: { url: string; body: unknown }[] = [];
  const ok = sender(TARGET, tags("2.0.1"), async (url, body) => posts.push({ url, body: JSON.parse(body) }));
  ok.sendEventData("readbysearch.code2pdf/print", { outcome: "printed" });
  await ok.flush();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, TARGET.url);
  assert.ok(Array.isArray(posts[0].body));
  const failing = sender(TARGET, {}, () => Promise.reject(new Error("offline")));
  failing.sendEventData("readbysearch.code2pdf/print", {});
  await failing.flush();
});

test("telemetry.json describes exactly the events and fields that can be sent", () => {
  const described = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../telemetry.json"), "utf8"));
  assert.deepEqual(Object.keys(described.commonProperties).sort(), [...COMMON].sort());
  assert.deepEqual(Object.keys(described.events).sort(), Object.keys(EVENTS).map((e) => `readbysearch.code2pdf/${e}`).sort());
  for (const [event, fields] of Object.entries(EVENTS)) {
    const entry = described.events[`readbysearch.code2pdf/${event}`];
    assert.deepEqual(Object.keys(entry).filter((k) => k !== "owner" && k !== "comment").sort(), [...fields].sort(), event);
  }
});

test("the .vsix includes telemetry.json", () => {
  const ignore = fs.readFileSync(path.join(__dirname, "../../../.vscodeignore"), "utf8");
  assert.match(ignore, /^!telemetry\.json$/m);
});

test("code2pdf.telemetry: user settings only, found under @tag:telemetry", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../package.json"), "utf8"));
  const setting = manifest.contributes.configuration.properties["code2pdf.telemetry"];
  assert.equal(setting.type, "boolean");
  assert.equal(setting.default, true);
  // A workspace's .vscode/settings.json must not be able to turn it back on
  assert.equal(setting.scope, "application");
  assert.deepEqual(setting.tags, ["telemetry", "usesOnlineServices"]);
});
