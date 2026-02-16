import { config as loadDotenv } from "dotenv";
import { getKeypairFromEnv } from "../wallet.js";
import { measureAllEndpoints, measureRpcLatency, printLatencyReport } from "../latency.js";

loadDotenv();

async function main() {
  const rounds = Number(process.env.LATENCY_ROUNDS ?? 10);
  const delayMs = Number(process.env.LATENCY_DELAY_MS ?? 150);

  let walletPubkey;
  try {
    walletPubkey = getKeypairFromEnv().publicKey;
  } catch {
    console.warn("Wallet bulunamadı, getBalance probu atlanacak.\n");
  }

  console.log(`Latency ölçümü: ${rounds} round, ${delayMs}ms delay\n`);

  // Configured endpoints
  const reports = await measureAllEndpoints({ rounds, delayMs, walletPubkey });

  // Also probe public devnet for comparison
  const publicDevnet = "https://api.devnet.solana.com";
  const isAlreadyTested = reports.some((r) => r.url.includes("devnet.solana.com"));
  if (!isAlreadyTested) {
    reports.push(
      await measureRpcLatency(publicDevnet, "public-devnet", { rounds, delayMs, walletPubkey })
    );
  }

  for (const r of reports) {
    printLatencyReport(r);
  }

  // Comparison table
  console.log("\n┌────────────────────┬────────┬────────┬────────┬────────┬─────────┐");
  console.log("│ Endpoint           │ Avg ms │ Min ms │ Max ms │ P95 ms │ Success │");
  console.log("├────────────────────┼────────┼────────┼────────┼────────┼─────────┤");
  for (const r of reports) {
    const s = r.summary;
    console.log(
      `│ ${r.rpcLabel.padEnd(18)} │ ${String(s.avgMs).padStart(6)} │ ${String(s.minMs).padStart(6)} │ ${String(s.maxMs).padStart(6)} │ ${String(s.p95Ms).padStart(6)} │ ${(s.successRate + "%").padStart(7)} │`
    );
  }
  console.log("└────────────────────┴────────┴────────┴────────┴────────┴─────────┘");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
