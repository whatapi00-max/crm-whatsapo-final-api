module.exports = {
  apps: [
    {
      name: 'whatsapp-crm',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,          // KEEP at 1 — server uses in-memory Maps (tenant configs, caches)
      autorestart: true,
      watch: false,
      max_memory_restart: '600M', // raised from 500M for 100+ concurrent users
      restart_delay: 3000,        // faster restart after crash
      max_restarts: 20,           // more restarts before PM2 gives up
      min_uptime: '10s',          // must stay up 10s to count as a successful start
      node_args: '--max-old-space-size=560', // explicit V8 heap limit just under max_memory
      env: {
        NODE_ENV: 'production',
        UV_THREADPOOL_SIZE: '16' // increase libuv thread pool for heavy I/O (default 4)
      },
      error_file: './logs/error.log',
      out_file: './logs/output.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      time: true
    }
  ]
};
