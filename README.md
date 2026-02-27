# Twitch Real-Time Chat Logger

A real-time Twitch chat logging and archival coordination tool built with [Bun](https://bun.sh/).

This tool monitors a Twitch channel's status via EventSub WebSockets, collects chat messages in real-time, and automatically handles post-stream tasks like uploading data to Cloudflare R2 and registering records in Cloudflare D1 for integration with [Twitch Archive Manager (tam)](https://github.com/youruser/twitch-archive-manager).

## Key Features

- **EventSub Monitoring**: Automatically detects when a stream goes online or offline.
- **Real-Time Logging**: Collects every chat message via IRC and saves them to local JSON.
- **Integrated Archival Flow**:
  - Automatically retrieves the VOD ID upon stream completion.
  - Uploads the chat JSON to Cloudflare R2 (S3-compatible storage).
  - Registers the stream metadata into Cloudflare D1 (SQLite database).
- **Multi-Channel Notifications**: Supports [ntfy](https://ntfy.sh/) and LINE Messaging API for stream status and system updates.
- **Built for Bun**: High-performance execution and seamless modern JavaScript support.

## Prerequisites

- [Bun](https://bun.sh/) runtime installed.
- Twitch Developer Application (Client ID and Secret).
- (Optional) Cloudflare Account with D1 and R2 enabled.
- (Optional) ntfy topic or LINE Bot for notifications.

## Installation

```bash
git clone https://github.com/hqk0/twitch-rt-chat-logger.git
cd twitch-rt-chat-logger
bun install
```

## Configuration

Copy `.env.example` to `.env` and fill in your credentials:

## Usage

Start the bot:

```bash
bun start
```

The bot will connect to Twitch WebSockets and wait for the channel to go live. When the stream ends, it will automatically perform the data cleanup and archival registration.

## Architecture

1. **Wait**: Listens for `stream.online`.
2. **Log**: Spawns a dedicated IRC logging process (`chat.js`) to capture messages.
3. **Stop**: Listens for `stream.offline`.
4. **Finalize**:
   - Waits for Twitch to generate the VOD.
   - Fetches the VOD ID via API.
   - Uploads the chat JSON to R2.
   - Updates the D1 database to trigger the `tam` worker.

## License

MIT
