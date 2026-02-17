const path = require("path");
const fs = require("fs");

// .env dosyasını oku ve anahtar=değer çiftlerini obje olarak döndür
function loadDotEnv() {
  const envPath = path.resolve(__dirname, ".env");
  const result = {};
  try {
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Tırnak kaldır
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
  } catch {
    // .env yoksa sessizce devam et
  }
  return result;
}

module.exports = {
  apps: [
    {
      name: "arb-server",
      script: "npx",
      args: "tsx src/start.ts",
      cwd: "./",
      env: {
        NODE_ENV: "production",
        ...loadDotEnv(),
      },
      // Restart policies
      max_restarts: 10,
      restart_delay: 3000,
      exp_backoff_restart_delay: 1000,
      // Logging
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "logs/pm2-error.log",
      out_file: "logs/pm2-out.log",
      merge_logs: true,
    },
  ],
};
