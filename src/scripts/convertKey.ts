import { config as loadEnv } from "dotenv";
import bs58 from "bs58";
import fs from "fs";
import path from "path";

loadEnv();

const phantomKey = process.env.PHANTOM_PRIVATE_KEY;
if (!phantomKey) {
  console.error("Missing PHANTOM_PRIVATE_KEY in .env");
  process.exit(1);
}

try {
  const decoded = bs58.decode(phantomKey);
  const bytes = Array.from(decoded.values());
  const outDir = path.join(process.cwd(), ".key");
  const outPath = path.join(outDir, "keypair.json");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(bytes, null, 2), "utf-8");
  console.log(`Saved keypair to ${outPath}`);
} catch (err) {
  console.error("Failed to convert PHANTOM_PRIVATE_KEY:", err);
  process.exit(1);
}
