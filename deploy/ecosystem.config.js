// PM2 process definition for the OdysseyAI web server.
//
// Lives beside server.js in the deployed app folder (C:\inetpub\odyssey_ai\app)
// and is started by update-on-server.ps1.
//
// ── WHY PORT AND HOSTNAME ARE SET HERE AND NOT IN .env ────────────────────
//
// The standalone server.js reads process.env.PORT on its FIRST executable line,
// long before Next has loaded any .env file — .env is read later, by the server
// it starts. So PORT in .env is read too late to place the listener: the app
// would come up on 3000, IIS would keep proxying to 4100, and the site would be
// a 502 while the logs said the app started fine.
//
// Everything else the app needs — DB_HOST, SESSION_SECRET, ENCRYPTION_KEY,
// APP_URL — does come from app\.env, because it is read at request time.
//
// HOSTNAME is loopback on purpose. IIS is the front door; binding to
// 127.0.0.1 means nothing on the network can reach port 4100 around it.
module.exports = {
  apps: [
    {
      name: 'odyssey-ai',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // A crash loop should be visible in the logs, not hidden by PM2
      // restarting forever at full speed.
      max_restarts: 10,
      restart_delay: 2000,
      env: {
        NODE_ENV: 'production',
        PORT: '4100',
        HOSTNAME: '127.0.0.1',
      },
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time: true,
    },
  ],
}
