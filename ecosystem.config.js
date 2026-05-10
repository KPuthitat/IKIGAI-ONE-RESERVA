/**
 * PM2 process manifest for IKIGAI ONE RESERVA (Next.js 14, port 3010).
 *
 * Why this file exists: previously we ran `pm2 start npm -- start`,
 * which made PM2 manage the *npm* wrapper. On `pm2 restart` it would
 * SIGTERM npm but the next-server child it spawned wouldn't get the
 * signal — so the child kept holding port 3010 and the new restart
 * couldn't bind ("EADDRINUSE :::3010"). We had to track the zombie
 * pid manually and `kill -9` it on every deploy.
 *
 * This config runs `next start` directly. PM2 owns the next-server
 * process itself (no npm middleman), so SIGTERM lands where it
 * needs to and `pm2 restart` is clean.
 *
 * Deployment (one-time setup on the VPS, after first `git pull`):
 *
 *     pm2 delete reserva                  # remove the old npm-wrapper entry
 *     pm2 start ecosystem.config.js       # start using this manifest
 *     pm2 save                            # persist for boot
 *
 * Subsequent deploys (no zombie pid hunting):
 *
 *     git pull origin main
 *     npm run build
 *     pm2 reload reserva                  # graceful restart, no port conflict
 */
module.exports = {
  apps: [
    {
      name: "reserva",
      cwd: "/var/www/reserva",
      // Run the Next CLI directly so PM2 controls the actual server
      // process (no npm shell wrapper that swallows signals).
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3010 -H 127.0.0.1",
      // fork mode is correct here — Next has its own internal worker
      // model; PM2 cluster mode would double-bind the port.
      exec_mode: "fork",
      instances: 1,
      // Plenty of headroom for graceful shutdown; default 1.6s isn't
      // enough on a busy SQLite write.
      kill_timeout: 8000,
      // Production env. PORT/HOSTNAME also passed as CLI args above
      // (belt-and-braces — Next reads either).
      env: {
        NODE_ENV: "production",
        PORT: "3010",
        HOSTNAME: "127.0.0.1"
      },
      // Restart policy: cap retries so we don't churn forever on a
      // bad build. PM2 default is unlimited.
      max_restarts: 10,
      restart_delay: 2000,
      // Memory ceiling — restart if the leak ever runs away. 1 GB on
      // a 1 GB droplet (we have ikigai-payroll alongside).
      max_memory_restart: "350M"
    }
  ]
};
