import { scrubStalePiTelemetryEnv } from "../src/telemetry-env.js";

// Keep this extension intentionally tiny: when packaged, it is listed before
// the workflow extension so stale inherited telemetry is cleared before other
// listeners (notably @amaster.ai/pi-telemetry) can snapshot process.env.
scrubStalePiTelemetryEnv();

export default function telemetryScrubExtension() {
  // Direct factory fallback for loaders that import first and invoke later.
  scrubStalePiTelemetryEnv();
}
