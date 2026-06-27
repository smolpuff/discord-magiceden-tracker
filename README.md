# discord-magiceden-tracker

Go rewrite of the Magic Eden Discord tracker. It polls Magic Eden listings and sales, applies price / rarity / trait filters from `data/tracks.json`, and posts Discord embeds through slash-command managed tracking.

## Runtime

- Language: Go
- Discord library: `github.com/bwmarrin/discordgo`
- Config file: `config.json`
- Track file: `data/tracks.json`

## macOS Menu Bar App

A native SwiftUI menu bar wrapper is included under [`macos/`](./macos).

It bundles the Go tracker worker and gives you:

- start / stop from the menu bar
- live log window
- Finder access to the config folder
- macOS notifications for priority trait matches
- a test notification action for local verification

Build it with:

```bash
/bin/zsh macos/build-macos-app.sh
```

This produces:

```bash
dist/macos/Magic Eden Tracker.app
```

On first launch, the app creates its working files in:

```text
~/Library/Application Support/Magic Eden Tracker/
```

That folder contains:

- `config.json`
- `tracks.json`
- `Logs/metracker.log`

The app copies the bundled `config.json` and tracks templates into the support folder if they do not already exist. If the support folder still has a placeholder config, it is refreshed from the bundled config on launch.

## Setup

1. Create a Discord bot in the Discord Developer Portal.
2. Enable the bot and application commands scopes.
3. Put your bot token, channel ID, client ID, guild ID, and owner ID into `config.json`.
4. Install Go 1.22 or newer.
5. Fetch dependencies and run:

```bash
go mod download
go run .
```

For a binary:

```bash
go build -o bin/metracker .
./bin/metracker
```

## Commands

- `/metrack`
  Track listings for a collection with a max price and optional trait filters.
- `/meuntrack`
  Stop tracking listings for a collection.
- `/mesalestrack`
  Track sales for a collection with a max price and optional trait filters.
- `/mesalesuntrack`
  Stop tracking sales for a collection.
- `/melist`
  List tracked collections.
- `/mestatus`
  Show polling, cache, and backoff status.
- `/metest`
  Clear the seen cache.
- `/mecleanup`
  Delete recent bot messages in the configured channel.

## Trait Filters

Trait filters use:

```text
Background=Blue; Eyes=Laser|Gold
```

- `;` separates trait types.
- `|` means OR within one trait type.
- `trait_match: "any"` in `tracks.json` changes cross-trait behavior from AND to OR.
- `notify_on: "all"` or `"priority"` controls whether alerts are sent for every tracked listing/sale or only priority trait matches.
- `trait_alert_repeats` controls repeated priority sends for matches.

## Startup Summary

On startup the bot:

1. Caches supply / rarity data where available.
2. Indexes current listing and sales activity into the seen cache.
3. Sends a startup summary to the configured Discord channel.

The startup summary includes:

- tracked collections
- current listed count from Magic Eden listings pagination
- sampled listing count
- current filter matches
- current priority trait matches
- collection thumbnail image when available

If the configured startup listing page cap is reached, the listed count is shown as `>=N`.

## Example Config

```json
{
  "DISCORD_TOKEN": "YOUR_DISCORD_BOT_TOKEN",
  "DISCORD_CHANNEL_ID": "YOUR_DISCORD_CHANNEL_ID",
  "CLIENT_ID": "YOUR_BOT_CLIENT_ID",
  "GUILD_ID": "YOUR_GUILD_ID",
  "ROUND_ROBIN_TICK_MS": 150000,
  "BACKOFF_MS": 10000,
  "STARTUP_LISTINGS_PAGE_LIMIT": 100,
  "STARTUP_LISTINGS_MAX_PAGES": 50,
  "OWNER_ID": "YOUR_DISCORD_USER_ID",
  "PRIORITY_MENTION_OWNER": false
}
```

## Notes

- This rewrite keeps the existing JSON config and track file shape.
- This environment did not have `go` installed, so the code here was not compile-tested locally in this session.
- The old Node implementation is removed on this branch to keep the rewrite clean.

## License

MIT
