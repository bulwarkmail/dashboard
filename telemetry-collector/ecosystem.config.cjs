module.exports = {
  apps: [
    {
      name: 'bulwark-telemetry-collector',
      cwd: __dirname,
      script: 'dist/server.js',
      interpreter: 'node',
      env: { NODE_ENV: 'production' },
      max_restarts: 10,
      restart_delay: 5000,
      out_file: '/var/log/bulwark-dashboard/telemetry.out.log',
      error_file: '/var/log/bulwark-dashboard/telemetry.err.log',
      merge_logs: true,
    },
  ],
};
