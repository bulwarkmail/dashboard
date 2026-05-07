module.exports = {
  apps: [
    {
      name: 'bulwark-version-server',
      cwd: __dirname,
      script: 'dist/server.js',
      interpreter: 'node',
      env: { NODE_ENV: 'production' },
      max_restarts: 10,
      restart_delay: 5000,
      out_file: '/var/log/bulwark-dashboard/version-server.out.log',
      error_file: '/var/log/bulwark-dashboard/version-server.err.log',
      merge_logs: true,
    },
  ],
};
