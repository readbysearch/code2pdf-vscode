// Helper for test/usage-data.sh: sends two events built by the extension's own code
// (out/telemetry.js) to CONNECTION_STRING. MARKER-tagged carries the extension's tags, so Azure
// shouldn't work out a location; MARKER-control leaves out ai.location.ip, so Azure should.
// Usage: CONNECTION_STRING=... node location.js <out/telemetry.js> <marker>
const telemetry = require(process.argv[2]);
const marker = process.argv[3];

const target = telemetry.parseConnectionString(process.env.CONNECTION_STRING ?? "");
if (!target) {
  throw new Error("CONNECTION_STRING has no InstrumentationKey");
}

async function send(session, tags) {
  const envelope = telemetry.envelope(target, "readbysearch.code2pdf/activated", { cli: "found" }, tags, new Date());
  const response = await fetch(target.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify([envelope]) });
  const reply = await response.json().catch(() => ({}));
  if (reply.itemsAccepted !== 1) {
    throw new Error(`Azure didn't accept ${session}: ${response.status} ${JSON.stringify(reply)}`);
  }
}

(async () => {
  const tagged = telemetry.tags("0.0.0-check", `${marker}-tagged`);
  const control = { ...tagged, "ai.session.id": `${marker}-control` };
  delete control["ai.location.ip"];
  await send(`${marker}-tagged`, tagged);
  await send(`${marker}-control`, control);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
