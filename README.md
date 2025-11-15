# Discord Magic Eden Tracker

A Discord bot for tracking Magic Eden NFT listings/sales, with price filtering and fast, rate-limit-safe polling.

## Features

- Track multiple Magic Eden collections with per-collection price filters
- Fast, round-robin polling (rate-limit safe)
- Discord alerts with NFT images and links
- Slash commands for tracking, untracking, listing, and cleaning up
- Owner-only command restriction
- Config and tracks reload live (no restart needed)
- Exponential backoff on API throttling (429)

## Requirements

- You must set up a Discord application and bot in the [Discord Developer Portal](https://discord.com/developers/applications) to use this tracker since it's not published. See below for setup instructions.

- Node.js 18+
- Discord bot token and permissions (see below)

## Quick Start

## Discord Bot Setup (Developer Portal)

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click "New Application".
2. Name your application (e.g., "Magic Eden Tracker").
3. In the left sidebar, go to "Bot" and click "Add Bot".
4. Under the Bot settings, click "Reset Token" to get your bot token. **Copy this token**—you'll need it for `config.json`.
5. Under "Privileged Gateway Intents", enable the "Message Content Intent" if you want the bot to read message content (not required for slash commands only).
6. In the left sidebar, go to "OAuth2" > "URL Generator":

- Select "bot" and "applications.commands" scopes.
- Under "Bot Permissions", select at least "Send Messages" and "Read Messages" for the channel you want the bot to use.
- Copy the generated URL and use it to invite the bot to your server.

7. In "General Information", copy the "Application ID" (Client ID) and your server's ID (GUILD_ID) for use in `config.json`.

You can now use your bot token, client ID, and guild ID in your `config.json` file. See the sample config for details.

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Copy and edit config**

   ```bash
   cp config.json.sample config.json
   # Edit config.json with your bot token, channel, IDs, etc. (only needed for initial setup)
   ```

3. **Run the bot**

   ```bash
   node metracker.js
   # or
   nodemon metracker.js
   ```

4. **Track collections using commands in Discord**

   - Use the `/metrack` command to add a collection to track from discord (see below for usage).

## Managing Collections & Commands

Use these slash commands in Discord to manage tracked collections and bot actions:

- `/metrack magicedenURL:<url> <max_price>` — Track a collection (by Magic Eden URL or symbol)
- `/meuntrack magicedenURL:<url>` — Untrack a collection
- `/melist` — List all tracked collections
- `/mecleanup` — Delete the bot's own messages in the channel

#### Example Usage

- **Track a collection:**

  ```
  /metrack https://magiceden.io/marketplace/y00ts
  ```

- **Untrack a collection:**

  ```
  /meuntrack https://magiceden.io/marketplace/y00ts
  ```

- **List tracked collections:**

  ```
  /melist
  ```

- **Delete _all_ bot messages in discord:**
  ```
  /mecleanup
  ```

## Configuration (`config.json`)

- `DISCORD_TOKEN`: Your Discord bot token
- `DISCORD_CHANNEL_ID`: Channel to post alerts
- `CLIENT_ID`: Your bot's application ID
- `GUILD_ID`: Your server's ID
- `ROUND_ROBIN_TICK_MS`: Polling interval per collection (ms, default 750; increase for more safety)
- `BACKOFF_MS`: Backoff time after 429 (ms, default 10000)
- `OWNER_ID`: Only this Discord user can control the bot
- `TEST_MESSAGE_DELETE_SECONDS`: How long (in seconds) to keep test/debug messages before auto-deleting (default: 5)

## Tracking Collections (`data/tracks.json`)

Each collection can have its own config. Example:

```json
{
  "collections": {
    "great__goats": {
      "max_price": 0.4,
      "min_rarity": "Legendary",
      "supply_override": 9593
    },
    "candies": {
      "max_price": 0.4,
      "supply_override": 10000
    },
    "undead_genesis": {
      "supply_override": 4515
    }
  }
}
```

- `max_price`: Only alert for listings at or below this price
- `min_rarity`: Only alert for NFTs at or above this rarity (optional)
- `supply_override`: Fallback supply for rarity math if APIs fail (optional, per collection)

If `supply_override` is set, it will be used only if Magic Eden and HowRare APIs fail to provide supply.

## Rarity Filtering (Optional)

You can set a minimum rarity for each collection in `data/tracks.json` using the `min_rarity` field. Only NFTs at or above this rarity will trigger notifications and appear in the debug/test output.

**Example:**

```json
{
  "collections": {
    "great__goats": {
      "max_price": 0.4,
      "min_rarity": "Legendary"
    }
  }
}
```

Valid values: `Mythic`, `Legendary`, `Epic`, `Rare`, `Uncommon`, `Common`

If omitted, all rarities are allowed.

## Notes

- The bot polls one collection per tick (default 750ms), round-robin.

**Magic Eden's public API recommends no more than 2 requests per second per IP.** This bot can be configured to poll faster, but the default is set conservatively for safety and reliability. Adjust `ROUND_ROBIN_TICK_MS` in your config if you want to poll more aggressively (at your own risk).

- **The more collections you track, the longer it takes to check each one again.** For example, with 10 collections and a 550ms tick, each collection is checked about every 5.5 seconds. Polling gets slower for each collection as you add more.
- If you get rate-limited (429), polling pauses and slows down automatically.

## License

MIT
