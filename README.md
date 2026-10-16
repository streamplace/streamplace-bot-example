# Streamplace Bot Example Repo

This is a basic proof-of-concept of how to make a Streamplace bot. [It's named after SCP-2721 (bones), the moderator of Gamers Against Weed](https://scp-wiki.wikidot.com/protected:scp-2721).

It watches the chat firehose for one streamer, answers `!timer`, and turns messages that mention the bot into schedule requests for a language model to resolve.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `BOT_IDENTIFIER` | Yes | | Bot account handle or DID. Mentions are matched on the bot's DID, so a handle has to be resolvable — pass the DID if the account doesn't exist yet |
| `BOT_PASSWORD` | No | | Bot account app password. Without it the bot still watches chat and emits schedule requests, but sends nothing back |
| `STREAMER_DID` | No | | DID of the streamer whose chat to watch. Unset watches every chat on the relay, which is what a bot that can be asked for a stream by anyone wants |
| `RELAY_URL` | No | `wss://bsky.network` | Firehose relay WebSocket URL |
| `BOT_SERVICE` | No | `https://stream.place` | PDS (station) URL for the bot account |
| `PROPOSAL_URL_BASE` | No | `https://pdsls.dev` | Where proposal links point. Anything that resolves an at-uri works |

## Asking for a stream to be scheduled

Mention the bot in chat and ask:

```
@sidechannel.cheeky.town schedule a stream for reading the dist.town docs and phoenix
architecture stuff at 9am tomorrow
```

The bot does not guess the time itself. It prints one JSON envelope per request to stdout, prefixed with `[schedule.request]`, and whatever language model is reading stdout resolves it:

```json
{"kind":"schedule.request","source":"chat","emittedAt":"2026-10-16T00:21:11.409Z","bot":{"did":"did:plc:…","identifier":"sidechannel.cheeky.town"},"channel":{"streamer":"did:plc:…"},"requester":{"did":"did:plc:…"},"message":{"uri":"at://did:plc:…/place.stream.chat.message/…","cid":"bafy…","createdAt":"2026-10-16T00:21:11.406Z","createdAtUtcOffsetMinutes":null,"text":"@sidechannel.cheeky.town schedule a stream for…","prompt":"schedule a stream for…","mentionSource":"facet","facets":[{"index":{"byteStart":0,"byteEnd":30},"features":[{"$type":"app.bsky.richtext.facet#mention","did":"did:plc:…"}]}]},"relay":"wss://bsky.network","host":{"timezone":"America/Los_Angeles","utcOffsetMinutes":-420}}
```

Field notes:

- `message.prompt` is the text with the bot's own mention cut out — that is the request.
- `requester.did` is who to research. In practice their profile description is the signal that pins a timezone ("Seattle via Minnesota" → `America/Los_Angeles`).
- `message.createdAt` is client-declared and Streamplace clients write UTC, so `createdAtUtcOffsetMinutes` is normally `null`. It is only set when a client bothered to declare an offset, which makes it a strong hint when present.
- `message.mentionSource` is `facet` when the client resolved the handle into a mention facet and `text` when the handle was only typed as words. Both count as a mention; `text` just means the client didn't resolve it.
- `host` is the machine the bot runs on. Fine as a last resort when that is someone's laptop, wrong when it is a server.
- `message.uri` is the request as stored, if the model needs to read it back.

Resolving a request means: pick the requester's timezone from their records, turn "9am tomorrow" into an absolute instant in it, and *say which timezone was assumed* so a bad guess is visible immediately. The resolved record goes back in with the envelope, as below.

The same envelope can be produced without credentials, which is how the pipeline is tested:

```sh
BOT_IDENTIFIER=did:plc:… pnpm dev -- \
  --request "schedule a stream for reading the dist.town docs at 9am tomorrow" \
  --requester did:plc:… --streamer did:plc:…
```

`--requester` is the DID whose timezone the model should research, so a CLI run without it can only fall back on `host`. `--streamer` stands in for `STREAMER_DID` when the bot is watching every chat and the run is pretending to be one of them.

## Proposing the resolved record

The envelope is the model's *input*. Its answer is the same envelope with the record and where it goes attached, which is what `--propose` reads:

```json
{
  "request": { "kind": "schedule.request", "…": "…the envelope above, verbatim…" },
  "record": {
    "$type": "community.lexicon.calendar.event",
    "name": "Reading dist.town/release.software docs",
    "startsAt": "2026-10-16T15:00:00.000Z",
    "endsAt": "2026-10-16T16:00:00.000Z",
    "createdAt": "2026-10-16T01:43:13.894Z"
  }
}
```

```sh
BOT_IDENTIFIER=did:plc:… pnpm dev -- --propose resolved.json --dry-run   # print the plan, write nothing
BOT_IDENTIFIER=did:plc:… BOT_PASSWORD=… pnpm dev -- --propose resolved.json
```

With credentials it writes `com.iameli.record.proposal` into the bot's own repo and replies in the chat the request came from, with a link as the last thing in the message:

```json
{"proposal":"at://did:plc:…/com.iameli.record.proposal/3mxx…","rkey":"3mxx…","target":"at://did:plc:…/community.lexicon.calendar.event/3mxx…","url":"https://pdsls.dev/at://did:plc:…/com.iameli.record.proposal/3mxx…","text":"Proposed \"Reading dist.town/release.software docs\" starting 2026-10-16T15:00:00.000Z for you to review: https://pdsls.dev/at://…","streamer":"did:plc:…","chat":"at://did:plc:…/place.stream.chat.message/3mxx…"}
```

- Nothing is written into the requester's repo. The proposal names where the record *would* go — a fresh TID in the requester's repo, or `"uri"` in the input file when the model knows better — and approving it is a separate act, by them.
- `record` goes into the proposal byte for byte. The bot only reads `$type` (which collection the URI names), `name` and `startsAt` (for the sentence in chat) out of it; a record that can't say where it goes is refused rather than guessed at.
- The reply quotes the record's own `startsAt` string instead of rendering it, because rendering is where a timezone assumption would silently hide.
- Writing the proposal is `at://` all the way down, but the link has to be openable, hence `PROPOSAL_URL_BASE`. Until there is a frontend that reads proposals and offers to approve them, a plain at-uri viewer is the whole review experience.

## Developing

```sh
pnpm test   # node:test, via the tsx that is already a dev dependency
```

Chat records are read leniently on purpose. Streamplace clients write facets typed after Bluesky's lexicon (`app.bsky.richtext.facet`), which is the same shape as `place.stream.richtext.facet` — the Streamplace lexicon aliases Bluesky's `#link`, `#mention` and `#byteSlice` definitions — but not the same `$type` string, so validating the record against the generated lexicon rejects real messages. The bot validates everything else with the lexicon and reads facets for the byte range and the mention `did` only, keeping whatever else the client attached.