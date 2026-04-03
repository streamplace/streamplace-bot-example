# Streamplace Bot Example Repo

This is a basic proof-of-concept of how to make a Streamplace bot. [It's named after SCP-2721 (bones), the moderator of Gamers Against Weed](https://scp-wiki.wikidot.com/protected:scp-2721).

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `STREAMER_DID` | Yes | | DID of the streamer whose chat to monitor |
| `BOT_IDENTIFIER` | Yes | | Bot account handle or DID |
| `BOT_PASSWORD` | Yes | | Bot account app password |
| `RELAY_URL` | No | `wss://relay.stream.place` | Firehose relay WebSocket URL |
| `BOT_SERVICE` | No | `https://pds.stream.place` | PDS URL for the bot account |
