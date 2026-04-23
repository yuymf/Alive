/**
 * PM2 ecosystem config for alive-api-server.
 *
 * Production usage:
 *   npm run build        # compile TypeScript → dist/
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *
 * Development (tsx watch, no build step):
 *   OPS_API_KEY=xxx ALIVE_PERSONA=miss-v npm run dev
 */
module.exports = {
  apps: [{
    name: 'alive-api-server',
    script: './dist/server.js',
    cwd: __dirname,
    env: {
      NODE_ENV: 'production',
      PORT: 3001,
    },
    watch: false,
    max_restarts: 10,
    restart_delay: 3000,
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
