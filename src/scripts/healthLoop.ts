/**
 * Hourly health check loop
 * Usage: npx tsx src/scripts/healthLoop.ts
 */
import { execSync } from "child_process";

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

function runHealth() {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] Running m3:health...`);
  try {
    execSync("npm run m3:health", { stdio: "inherit", cwd: process.cwd() });
  } catch (e) {
    console.error("Health check failed:", e);
  }
}

console.log("Starting hourly health check loop (Ctrl+C to stop)");
runHealth(); // immediate first run
setInterval(runHealth, INTERVAL_MS);
