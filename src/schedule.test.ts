// Regression tests for the chat-message reader: the records that Streamplace
// clients actually write must produce schedule requests. Run with
// `pnpm test` (node:test via tsx, no extra dependencies).

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Did } from "@atcute/lexicons/syntax";

import {
  asChatMessage,
  buildScheduleRequest,
  createCliMessage,
  findMention,
  formatScheduleRequest,
  promptText,
  type BotIdentity,
} from "./schedule.js";

const BOT: BotIdentity = {
  did: "did:plc:svzjldcfdhtytju6wa2vjrth",
  identifier: "sidechannel.cheeky.town",
};
const STREAMER: Did = "did:plc:2zmxikig2sj7gqaezl5gntae";
const URI = `at://${STREAMER}/place.stream.chat.message/3mxxdrkntri2e`;

/**
 * A real message off the firehose: facets are typed after Bluesky's lexicon,
 * not after `place.stream.richtext.facet`, and only the first facet carries a
 * `$type` at all.
 */
const realMessage = {
  $type: "place.stream.chat.message",
  text: "@sidechannel.cheeky.town Hello! Could you schedule a stream for me tomorrow morning at 9am to read through the dist.town/release.software docs?",
  facets: [
    {
      $type: "app.bsky.richtext.facet",
      index: { byteStart: 0, byteEnd: 24 },
      features: [
        { $type: "app.bsky.richtext.facet#mention", did: BOT.did },
      ],
    },
    {
      index: { byteStart: 111, byteEnd: 137 },
      features: [
        { $type: "app.bsky.richtext.facet#link", uri: "https://dist.town/release.software" },
      ],
    },
  ],
  streamer: STREAMER,
  createdAt: "2026-10-16T00:42:06.791Z",
};

/** The instant the bot emitted these envelopes, for stable assertions. */
const FIXTURE_NOW = new Date("2026-10-16T00:42:07.000Z");

function envelopeFor(record: unknown, source: "chat" | "cli" = "chat") {
  return buildScheduleRequest({
    record,
    bot: BOT,
    streamer: STREAMER,
    requester: null,
    source,
    uri: URI,
    cid: "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5ryanw5swgssdfygczba",
    relay: "wss://bsky.network",
    hostTimezone: "America/Denver",
    now: FIXTURE_NOW,
  });
}

test("reads the facet types clients actually write", () => {
  const message = asChatMessage(realMessage);
  assert.ok(message, "real firehose message was rejected");
  assert.equal(message.facets.length, 2);
  assert.deepEqual(findMention(message, BOT), {
    source: "facet",
    ranges: [{ start: 0, end: 24 }],
  });
});

test("builds one envelope for a real mention", () => {
  const request = envelopeFor(realMessage);
  assert.ok(request);
  assert.equal(request.kind, "schedule.request");
  assert.equal(request.channel.streamer, STREAMER);
  assert.equal(request.message.uri, URI);
  assert.equal(request.message.createdAt, "2026-10-16T00:42:06.791Z");
  assert.equal(request.message.createdAtUtcOffsetMinutes, null);
  assert.equal(request.message.mentionSource, "facet");
  assert.equal(request.message.prompt, "Hello! Could you schedule a stream for me tomorrow morning at 9am to read through the dist.town/release.software docs?");
  assert.equal(request.host.timezone, "America/Denver");
  assert.equal(request.host.utcOffsetMinutes, offsetMinutesAt(FIXTURE_NOW));
  assert.equal(
    formatScheduleRequest(request),
    `[schedule.request] ${JSON.stringify(request)}`,
  );
});

test("reads a mention typed as plain text without facets", () => {
  const request = envelopeFor({
    ...realMessage,
    facets: undefined,
    text: "hey @sidechannel.cheeky.town schedule me",
  });
  assert.ok(request);
  assert.equal(request.message.mentionSource, "text");
  assert.equal(request.message.prompt, "hey schedule me");
});

test("ignores messages that do not mention the bot", () => {
  // The link facet survives, the mentioning one does not.
  assert.equal(
    envelopeFor({ ...realMessage, text: "unrelated chatter", facets: [realMessage.facets[1]] }),
    null,
  );
  assert.equal(envelopeFor({ ...realMessage, text: "unrelated chatter", facets: [] }), null);
  assert.equal(
    envelopeFor({ ...realMessage, text: "@someone.else schedule me", facets: [] }),
    null,
  );
});

test("ignores records that are not chat messages", () => {
  assert.equal(asChatMessage(null), null);
  assert.equal(asChatMessage("not a record"), null);
  assert.equal(asChatMessage({ ...realMessage, text: 42 }), null);
  assert.equal(asChatMessage({ ...realMessage, createdAt: "yesterday" }), null);
  assert.equal(asChatMessage({ ...realMessage, streamer: "not-a-did" }), null);
});

test("keeps malformed facets from breaking a real mention", () => {
  const message = asChatMessage({
    ...realMessage,
    facets: [
      "garbage",
      { index: { byteStart: 0, byteEnd: 24 } },
      { index: { byteStart: 0, byteEnd: 24 }, features: [null, { did: BOT.did }] },
      { index: { byteStart: 5 }, features: [{ did: BOT.did }] },
    ],
  });
  assert.ok(message);
  assert.deepEqual(message.facets, [
    { index: { byteStart: 0, byteEnd: 24 }, features: [{ did: BOT.did }] },
  ]);
  assert.equal(promptText(message, findMention(message, BOT)!), "Hello! Could you schedule a stream for me tomorrow morning at 9am to read through the dist.town/release.software docs?");
});

test("closes the loop from a CLI invocation", () => {
  const record = createCliMessage({
    input: "schedule a stream tomorrow at 9am",
    bot: BOT,
    streamer: STREAMER,
    now: FIXTURE_NOW,
  });
  const request = envelopeFor(record, "cli");
  assert.ok(request);
  assert.equal(request.source, "cli");
  assert.equal(request.message.mentionSource, "facet");
  assert.equal(request.message.prompt, "schedule a stream tomorrow at 9am");
});

/** Minutes east of UTC for an instant, in whatever timezone the test runs in. */
function offsetMinutesAt(when: Date): number {
  return -when.getTimezoneOffset();
}