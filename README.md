# Spaff Leaderboard

Persistent leaderboard for `YoyoCaleb_` Twitch chat. The server connects to Twitch chat as an anonymous reader, listens for Nightbot messages like:

```text
undove has spaffed 9.8 ft - not bad
```

It stores captures in `data/scores.json` and serves a public leaderboard website.

## Run locally

Install Node.js 22 or newer, then run:

```bash
npm start
```

Open:

```text
http://localhost:3000
```

## Hosting

This is not a static-only site anymore. Use a host that can run a Node server 24/7.

Good fits:

- Render
- Railway
- Fly.io
- a VPS
- shared hosting only if it supports long-running Node apps

Set the start command to:

```bash
npm start
```

The app uses the host's `PORT` automatically.

Optional environment variables:

```text
TWITCH_CHANNEL=YoyoCaleb_
TWITCH_BOT_NAME=nightbot
DATA_DIR=/opt/render/project/src/storage
```

For a custom domain, point the domain at whichever Node host you choose.

## Important

The included JSON storage is fine for a small first version. If the site gets popular or you need backups/admin tools, move the scores into a hosted database.
