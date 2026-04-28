module.exports = {
  apps: [
    {
      name: 'bulwark-dashboard-collector',
      cwd: __dirname,
      script: 'dist/index.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
      },
      max_restarts: 10,
      restart_delay: 5000,
      out_file: '/var/log/bulwark-dashboard/collector.out.log',
      error_file: '/var/log/bulwark-dashboard/collector.err.log',
      merge_logs: true,
    },
  ],
};
