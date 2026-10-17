# Streamplace Bot Example Repo

This is a basic proof-of-concept of how to make a Streamplace bot. [It's named after SCP-2721 (bones), the moderator of Gamers Against Weed](https://scp-wiki.wikidot.com/protected:scp-2721).

It watches Streamplace chat, answers `!timer`, and uses OpenRouter to turn mentions into calendar-event proposals and threaded replies. Users review and approve proposals through Attie; no model harness is needed.

For agents operating the live bot and composing complete calendar events, see
[AGENTS.md](AGENTS.md). It includes the event-field checklist, timezone research,
thumbnail/blob constraints, and proposal verification workflow.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `BOT_IDENTIFIER` | Yes | | Bot account handle or DID. Mentions are matched on the bot's DID, so a handle has to be resolvable — pass the DID if the account doesn't exist yet |
| `BOT_PASSWORD` | For publishing | | Bot account app password; may instead be supplied through `BOT_PASSWORD_FILE` |
| `BOT_PASSWORD_FILE` | No | | UTF-8 app-password file; trimmed, including CRLF. Direct `BOT_PASSWORD` takes precedence |
| `OPENROUTER_API_KEY` | For autonomous scheduling | | OpenRouter key; may instead be supplied through `OPENROUTER_API_KEY_FILE`. Without either, the listener emits request envelopes only |
| `OPENROUTER_API_KEY_FILE` | No | | UTF-8 OpenRouter-key file. Direct `OPENROUTER_API_KEY` takes precedence |
| `OPENROUTER_MODEL` | No | `deepseek/deepseek-v4-flash-0731` | Provider-prefixed model ID; no silent fallback to another model |
| `STREAMER_DID` | No | | Chat to watch. Unset watches every chat on the relay; set it to scope paid model calls |
| `RELAY_URL` | No | `wss://bsky.network` | Firehose relay WebSocket URL |
| `BOT_SERVICE` | No | `https://stream.place` | PDS (station) URL for the bot account |
| `PROPOSAL_URL_BASE` | No | `https://buzzing-ivory-wagon.attie.site` | Attie frontend for reviewing and approving proposals; override to use another compatible frontend |
| `SHUTDOWN_TIMEOUT_MS` | No | `25000` | Maximum live-listener drain time after SIGTERM/SIGINT; positive integer milliseconds |

## Run autonomously

```sh
pnpm install --frozen-lockfile
pnpm build
BOT_IDENTIFIER=fairway.cheeky.town \
BOT_PASSWORD_FILE=/shared/codes/fairway.cheeky.town.txt \
BOT_SERVICE=https://cheeky.town \
STREAMER_DID=did:plc:2zmxikig2sj7gqaezl5gntae \
OPENROUTER_API_KEY_FILE=/shared/openrouter-key.txt \
pnpm start
```

Only the file paths appear in the command, not their contents. The same environment
variables work with the existing Docker image; mount secret files read-only and
set the `_FILE` variables to their paths inside the container.

For each mention, the bot prefetches the requester's DID/PDS identity, Bluesky
profile, and five recent calendar events. The model has four read-only tools:
`get_profile`, `get_calendar_events`, `fetch_page`, and `resolve_time`.
Web research is limited to public HTTPS, with pinned DNS, redirect checks,
timeouts, and response-size limits. There is no local-file, shell, or write tool.

The model completes through the native `finish_schedule` function, returning
validated JSON with `records` (up to five events), `clarification` (null for
proposals), and `timezoneReason`. If a needed detail is missing, it returns an
empty `records` array and one specific clarification question instead.
`finish_schedule` returns data only; it is not a write tool.

The model supplies local civil `startsAt`/`endsAt` values in
`YYYY-MM-DDTHH:mm:ss` form plus an IANA zone or fixed device offset in `timezone`. Code converts both endpoints
to canonical UTC, rejecting invalid dates and DST gaps/overlaps, rather than
depending on model arithmetic or a tool-call transcript. `[schedule.result]`
and the actual proposals contain those normalized UTC event timestamps.
The bot also generates creation metadata and UTF-8 link facets.

Code creates the `com.iameli.record.proposal` records and threaded chat replies
in one atomic `com.atproto.repo.applyWrites` batch in the **bot's repo**.
The model cannot choose another collection or write into the requester's repo.
Attie approval remains a separate user action.

Requests, public profile/event context, and tool results are sent to OpenRouter;
each mention can incur model charges. Runs allow at most eight model rounds,
twelve research calls, and three concurrent live requests. A busy listener asks
additional requesters to try again. Bot-authored messages are ignored; the latest
2,048 handled message URIs are deduplicated in memory, not durably across restarts.
Provider/model failures are logged and get a short chat error rather than a
fabricated event; failed writes are not automatically retried.

An OpenRouter HTTP 402 requires account credits. A key's unused spending
allowance is not an account balance; increasing that allowance does not fund
inference. The bot does not switch models or fabricate events to hide this error.

## Container images

The image workflow runs on pushes to `main` and `gpt61/autonomous-scheduling`,
and supports manual `workflow_dispatch` runs. It publishes branch tags and
`sha-<short-commit>` tags to `ghcr.io/streamplace/streamplace-bot-example`.
Only the default branch publishes `latest`.

For the unmerged autonomous-scheduling branch:

```sh
docker pull ghcr.io/streamplace/streamplace-bot-example:gpt61-autonomous-scheduling
```

Use the environment variables above and mount secret files read-only at their
configured container paths. Pin a SHA tag or image digest for a reproducible
deployment; the branch tag moves on each successful branch build.

## Kubernetes shutdown

On SIGTERM or SIGINT, the live listener stops accepting relay messages, closes
the relay/reconnect loop, and drains in-flight scheduling and chat writes.
It exits with code 0 after draining; repeated signals do not interrupt that drain.
If `SHUTDOWN_TIMEOUT_MS` expires, it reports unfinished work and exits with code 1.
A forced exit can leave a network write's commit status unknown; inspect recent
proposal/chat records before replaying requests.

The default 25-second drain fits Kubernetes' default 30-second termination grace
period when there is no `preStop` hook. If you raise `SHUTDOWN_TIMEOUT_MS`, also
raise `terminationGracePeriodSeconds`, allowing extra time for any `preStop` hook
and shutdown overhead. Keep the image's default exec-form Node command; if you
wrap it in a shell, use `exec node dist/index.js` so signals reach Node.

## Asking for a stream to be scheduled

Mention the bot in chat and ask:

```
@fairway.cheeky.town schedule a stream for reading the dist.town docs and phoenix
architecture stuff at 9am tomorrow
```

The bot logs one diagnostic JSON envelope per request, prefixed with `[schedule.request]`. With an OpenRouter key configured, it resolves the request automatically and logs `[schedule.result]` and `[record.proposal]` (or sends a clarification). Without a key, it only emits the envelope:

```json
{"kind":"schedule.request","source":"chat","emittedAt":"2026-10-16T00:21:11.409Z","bot":{"did":"did:plc:…","identifier":"sidechannel.cheeky.town"},"channel":{"streamer":"did:plc:…"},"requester":{"did":"did:plc:…"},"message":{"uri":"at://did:plc:…/place.stream.chat.message/…","cid":"bafy…","createdAt":"2026-10-16T00:21:11.406Z","createdAtUtcOffsetMinutes":null,"text":"@sidechannel.cheeky.town schedule a stream for…","prompt":"schedule a stream for…","mentionSource":"facet","facets":[{"index":{"byteStart":0,"byteEnd":30},"features":[{"$type":"app.bsky.richtext.facet#mention","did":"did:plc:…"}]}]},"relay":"wss://bsky.network","host":{"timezone":"America/Los_Angeles","utcOffsetMinutes":-420}}
```

Field notes:

- `message.prompt` is the text with the bot's own mention cut out — that is the request.
- `requester.did` identifies whose profile/calendar context to prefetch. Use that context for event details, but research timezone from it only when `createdAt` ends in `Z`/`z` and the request specifies no event timezone.
- `message.createdAt` is the device's source of truth for local time when it carries a numeric suffix, such as `-07:00` or `+05:45`. `createdAtUtcOffsetMinutes` exposes that offset (including explicit `+00:00`); it is `null` for Zulu timestamps. Do not override an offset using profile location or past events.
- `message.mentionSource` is `facet` when the client resolved the handle into a mention facet and `text` when the handle was only typed as words. Both count as a mention; `text` just means the client didn't resolve it.
- `host` describes the bot's machine, not the requester's location. The autonomous model does not use it as timezone evidence.
- `message.uri` is the request as stored, if the model needs to read it back.

Use an explicitly requested event timezone first; otherwise preserve the device
offset in `message.createdAt`. Research a timezone only for Zulu (`Z`/`z`)
timestamps without an explicit event zone. Numeric offsets are fixed: they do
not identify an IANA location or its future DST rules, so do not guess either.
Relative dates are anchored to the message's local calendar date. The event
stores the chosen zone/offset in `timezone`; an unspecified duration is not guessed.

Exercise the real model without publishing (configure an OpenRouter key first):

```sh
BOT_IDENTIFIER=did:plc:… pnpm dev -- \
  --request "schedule a stream for reading the dist.town docs at 9am tomorrow" \
  --requester did:plc:… --streamer did:plc:… --dry-run
```

`--requester` identifies the person to research and propose events to; without it the model asks who the event is for, rather than substituting the host. `--streamer` selects the reply's chat. With no OpenRouter key, `--request` only emits an envelope. To resolve a saved complete envelope, use `pnpm dev -- --resolve envelope.json --dry-run`; remove `--dry-run` and supply the bot's app password to publish. Dry runs still use the paid model when a key is configured.

## Manually proposing a resolved record

`--propose` remains available for inspecting or submitting a record you composed
yourself. Its input is an envelope plus a single record and optional target URI;
this is separate from the autonomous model's `records` array:

```json
{
  "request": { "kind": "schedule.request", "…": "…the envelope above, verbatim…" },
  "record": {
    "$type": "community.lexicon.calendar.event",
    "name": "Reading dist.town/release.software docs",
    "startsAt": "2026-10-16T16:00:00.000Z",
    "endsAt": "2026-10-16T17:00:00.000Z",
    "timezone": "America/Los_Angeles",
    "createdAt": "2026-10-16T01:43:13.894Z"
  },
  "timezone": "America/Los_Angeles"
}
```

```sh
BOT_IDENTIFIER=did:plc:… pnpm dev -- --propose resolved.json --dry-run   # print the plan, write nothing
BOT_IDENTIFIER=did:plc:… BOT_PASSWORD=… pnpm dev -- --propose resolved.json
```

With credentials it atomically writes `com.iameli.record.proposal` and its chat reply into the bot's own repo, with the review link as the last thing in the message:

```json
{"proposal":"at://did:plc:…/com.iameli.record.proposal/3mxx…","rkey":"3mxx…","target":"at://did:plc:…/community.lexicon.calendar.event/3mxx…","url":"https://buzzing-ivory-wagon.attie.site/at://did:plc:…/com.iameli.record.proposal/3mxx…","text":"Proposed \"Reading dist.town/release.software docs\" starting Fri, Oct 16, 2026, 9:00 AM PDT for you to review: https://buzzing-ivory-wagon.attie.site/at://…","streamer":"did:plc:…","chat":"at://did:plc:…/place.stream.chat.message/3mxx…"}
```

- Nothing is written into the requester's repo. The proposal names where the record *would* go — a fresh TID in their repo, or the explicit `"uri"` in a manual input file. Approval is a separate act by them.
- Manual `--propose` preserves `record` byte for byte and checks enough to construct the target and reply, not the event's full schema. Autonomous model records additionally pass the scheduler's calendar/time checks before any write.
- `timezone` controls local rendering in the reply: an IANA name can show `9:00 AM PDT`, while a device offset can show `9:00 AM GMT+5:45`. Invalid names/offsets are refused. Without a timezone, the record's own `startsAt` string is quoted instead of guessing.
- Review links open the [Attie proposal frontend](https://buzzing-ivory-wagon.attie.site), where the requester can review and approve the record. The bot itself still only writes the proposal and chat reply; it does not approve on the user's behalf. `PROPOSAL_URL_BASE` overrides the frontend without changing the proposal's at-uri.

## Developing

```sh
pnpm test   # node:test, via the tsx that is already a dev dependency
```

Chat records are read leniently on purpose. Streamplace clients write facets typed after Bluesky's lexicon (`app.bsky.richtext.facet`), which is the same shape as `place.stream.richtext.facet` — the Streamplace lexicon aliases Bluesky's `#link`, `#mention` and `#byteSlice` definitions — but not the same `$type` string, so validating the record against the generated lexicon rejects real messages. The bot validates everything else with the lexicon and reads facets for the byte range and the mention `did` only, keeping whatever else the client attached.