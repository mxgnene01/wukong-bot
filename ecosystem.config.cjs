module.exports = {
  apps: [
    {
      name: 'wukong-bot',
      script: './src/index.ts',
      interpreter: 'bun',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
      env_development: {
        NODE_ENV: 'development',
      },
      error_file: './workspace/logs/error.log',
      out_file: './workspace/logs/output.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
  ],
};
