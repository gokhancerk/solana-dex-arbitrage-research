module.exports = {
  apps: [
    {
      name: "arb-server",
      script: "npx",
      args: "tsx src/server.ts",
      cwd: "./",
      env: {
        NODE_ENV: "production",
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
