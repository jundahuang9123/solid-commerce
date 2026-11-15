/**
 * Web demo for talks (see docs/demo.md).
 *
 *   npm run demo:web                                  live services, phone approval via QR code
 *   npm run demo:web -- --replay recordings/x.json    the same UI from a recording (no services needed)
 *   npm run demo:web -- --rehearse <name>             run every screen unattended, save recordings/<name>.json, exit
 *
 * Options: --port <n> (default 4400, or DEMO_PORT). DEMO_PUBLIC_URL overrides
 * the base URL put in the QR code; POD_URL uses an already running Solid server.
 * DEMO_TOKEN sets the session token; otherwise it is kept in recordings/.demo-token,
 * so restarting (also into --replay) keeps the printed URLs and the QR code valid.
 */
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveDemo, type DemoControls } from "./live.js";
import { ReplayDemo } from "./replay.js";
import { loadRecording } from "./events.js";
import { demoToken, startDemoServer, TOKEN_FILE } from "./server.js";
import { publicBase, qrTerminal } from "./qr.js";
import { rehearse } from "./rehearse.js";

const RECORDINGS = fileURLToPath(new URL("../../recordings/", import.meta.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const replay = arg("--replay");
  const rehearsal = arg("--rehearse");
  const port = Number(arg("--port") ?? process.env.DEMO_PORT ?? 4400);

  if (!replay) console.log("Starting the Solid server, simulated payment rails, sellers, merchants, signer and gateway ...");
  const demo: DemoControls = replay
    ? new ReplayDemo(loadRecording(replay), { name: basename(replay, ".json") })
    : await LiveDemo.start({ recordingsDir: RECORDINGS });

  if (rehearsal) {
    const path = await rehearse(demo, rehearsal, (step) => console.log(`  ${step}`));
    console.log(`Saved ${path}`);
    await demo.close();
    return;
  }

  const token = demoToken(RECORDINGS);
  const srv = await startDemoServer(demo, { port, publicBase, token });
  console.log(`\n  ${replay ? `REPLAY of ${replay}` : "LIVE"}  (payments are simulated)`);
  console.log(`\n  Dashboard:  ${srv.dashboardUrl}`);
  console.log(`  Phone:      ${srv.phoneUrl}\n`);
  console.log(await qrTerminal(srv.phoneUrl));
  console.log("  Scan with a phone on the same network. Ctrl+C to stop.");
  console.log(`  The token is kept across restarts${process.env.DEMO_TOKEN ? " (DEMO_TOKEN)" : `; delete recordings/${TOKEN_FILE} for a new one`}.\n`);
  const stop = async () => { await srv.close(); await demo.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => { console.error(e); process.exit(1); });
