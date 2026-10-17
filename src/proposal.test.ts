// Tests for the half of the bot that answers a resolved request: it proposes a
// record the requester approves, and answers in chat with a link to it. Run
// with `pnpm test` (node:test via tsx, no extra dependencies).

import assert from "node:assert/strict";
import { test } from "node:test";

import * as v from "@atcute/lexicons/validations";
import type { Did } from "@atcute/lexicons/syntax";

import * as PlaceStreamChatMessage from "./lexicons/types/place/stream/chat/message.js";
import * as ComIameliRecordProposal from "./lexicons/types/com/iameli/record/proposal.js";
import {
  MAX_NAME_CHARACTERS,
  PROPOSAL_COLLECTION,
  formatProposal,
  mintTid,
  planProposal,
  reviewUrl,
  type ProposalPlan,
} from "./proposal.js";
import {
  buildScheduleRequest,
  formatScheduleRequest,
  readRequest,
  type ScheduleRequest,
} from "./schedule.js";

const BOT: Did = "did:plc:svzjldcfdhtytju6wa2vjrth";
const REQUESTER: Did = "did:plc:2zmxikig2sj7gqaezl5gntae";
const URI = `at://${REQUESTER}/place.stream.chat.message/3mxxdrkntri2e`;
const CID = "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5ryanw5swgssdfygczba";

/** The instant the request was read, for stable rkeys and assertions. */
const FIXTURE_NOW = new Date("2026-10-16T00:42:07.000Z");

/** A real message off the firehose, as the request envelope carries it. */
const realMessage = {
  $type: "place.stream.chat.message",
  text: "@sidechannel.cheeky.town schedule a stream for me tomorrow morning at 9am",
  streamer: REQUESTER,
  createdAt: "2026-10-16T00:42:06.791Z",
};

/** The record a model would resolve that request to: 9am in the requester's zone. */
const EVENT = {
  $type: "community.lexicon.calendar.event",
  name: "Reading dist.town/release.software docs",
  startsAt: "2026-10-16T16:00:00.000Z",
  endsAt: "2026-10-16T17:00:00.000Z",
  createdAt: "2026-10-16T00:42:07.000Z",
};

/** The zone the model researched for the requester: their profile says Seattle. */
const TIMEZONE = "America/Los_Angeles";

function request(): ScheduleRequest {
  const request = buildScheduleRequest({
    record: realMessage,
    bot: { did: BOT, identifier: "sidechannel.cheeky.town" },
    streamer: REQUESTER,
    requester: REQUESTER,
    source: "chat",
    uri: URI,
    cid: CID,
    relay: "wss://bsky.network",
    hostTimezone: "America/Denver",
    now: FIXTURE_NOW,
  });
  assert.ok(request, "the fixture message did not produce a request");
  return request;
}

function planFor(
  record: unknown = EVENT,
  options: { uri?: string; timezone?: string } = {},
): ProposalPlan {
  return planProposal({ bot: BOT, request: request(), record, now: FIXTURE_NOW, ...options });
}

/** The bytes a facet covers, decoded back to a string. */
function facetedText(text: string, index: { byteStart: number; byteEnd: number }): string {
  const bytes = new TextEncoder().encode(text);
  return new TextDecoder().decode(bytes.slice(index.byteStart, index.byteEnd));
}

const TID_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";

/** An independent read of a TID: the instant and clock id it was minted with. */
function decodeTid(tid: string): { micros: bigint; clock: number } {
  assert.equal(tid.length, 13, `${tid} is not a TID`);
  let value = 0n;
  for (const char of tid) {
    const index = TID_ALPHABET.indexOf(char);
    assert.ok(index >= 0, `${tid} is not a TID`);
    value = value * 32n + BigInt(index);
  }
  return { micros: value >> 10n, clock: Number(value & 0x3ffn) };
}

test("proposes a calendar event at a fresh rkey in the requester's repo", () => {
  const plan = planFor();

  assert.equal(plan.proposal.$type, PROPOSAL_COLLECTION);
  assert.equal(plan.proposal.record, EVENT);
  assert.equal(plan.proposal.createdAt, FIXTURE_NOW.toISOString());
  assert.equal(plan.target, plan.proposal.uri);
  assert.match(
    plan.target,
    new RegExp(`^at://${REQUESTER}/community\\.lexicon\\.calendar\\.event/[a-z2-7]{13}$`),
  );
  assert.equal(plan.proposalUri, `at://${BOT}/${PROPOSAL_COLLECTION}/${plan.rkey}`);
  assert.equal(decodeTid(plan.rkey).micros >= BigInt(FIXTURE_NOW.getTime()) * 1000n, true);
});

test("writes the proposal into the bot's repo, and links to review it", () => {
  const plan = planFor();
  assert.equal(
    reviewUrl("https://sidechannel.cheeky.town/", plan.proposalUri),
    `https://sidechannel.cheeky.town/${plan.proposalUri}`,
  );

  // The one thing the reviewer needs: the proposed record's own words.
  const parsed = v.safeParse(ComIameliRecordProposal.mainSchema, plan.proposal);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  assert.equal(parsed.value.uri, plan.target);
});

test("mints TIDs with the same bit layout the PDS uses", () => {
  // A real record key, off the streamer's chat message, next to that message's
  // createdAt: the PDS minted the key 123ms after the record was stamped, so
  // reading it has to land in that gap.
  const sent = BigInt(Date.parse(realMessage.createdAt)) * 1000n;
  const drift = Number(decodeTid("3mxxdrkntri2e").micros - sent);
  assert.ok(
    drift > 0 && drift < 60_000_000,
    `expected the real key within a minute after createdAt, got ${drift}µs`,
  );

  // Ours decode back to the instant they were minted for.
  const minted = decodeTid(mintTid(FIXTURE_NOW));
  const offBy = Number(minted.micros - BigInt(FIXTURE_NOW.getTime()) * 1000n);
  assert.ok(offBy >= 0 && offBy < 1024, `minted TID was ${offBy}µs off its timestamp`);
});

test("orders rkeys the way the writes happened, same microsecond included", () => {
  const tids = [mintTid(FIXTURE_NOW), mintTid(FIXTURE_NOW), mintTid(FIXTURE_NOW)];
  assert.deepEqual([...tids].sort(), tids);
  assert.equal(new Set(tids).size, tids.length, "two proposals would share an rkey");
  assert.ok(mintTid(new Date(FIXTURE_NOW.getTime() + 1)) > tids[2]);
});

test("quotes the record's name and start time in the reply, and links to it", () => {
  const plan = planFor(EVENT, { timezone: TIMEZONE });
  assert.equal(
    plan.reply.text,
    `Proposed "${EVENT.name}" starting Fri, Oct 16, 2026, 9:00 AM PDT for you to review: ${plan.url}`,
  );
  assert.equal(plan.reply.streamer, REQUESTER);
  assert.equal(plan.reply.createdAt, FIXTURE_NOW.toISOString());

  const facet = plan.reply.facets?.[0];
  assert.ok(facet, "the reply has no link facet");
  assert.equal(facetedText(plan.reply.text, facet.index), plan.url);
  assert.deepEqual(facet.features, [
    { $type: "app.bsky.richtext.facet#link", uri: plan.url },
  ]);

  const parsed = v.safeParse(PlaceStreamChatMessage.mainSchema, plan.reply);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
});

test("answers in the thread of the message it was asked in", () => {
  assert.deepEqual(planFor().reply.reply, {
    root: { uri: URI, cid: CID },
    parent: { uri: URI, cid: CID },
  });
});

test("names the record when it has no start time, and drops it when it has no name", () => {
  const named = planFor({ $type: "community.lexicon.calendar.event", name: "Docs reading" });
  assert.equal(named.reply.text, `Proposed "Docs reading" for you to review: ${named.url}`);

  const unnamed = planFor({ $type: "app.bsky.feed.post", text: "hello" });
  assert.equal(unnamed.reply.text, `Proposed a record for you to review: ${unnamed.url}`);
});

test("keeps a long or multi-byte name out of the link's byte range", () => {
  const name = "🎥 dist.town 日本語 docs — " + "deep dive ".repeat(20);
  const plan = planFor({ $type: "community.lexicon.calendar.event", name, startsAt: EVENT.startsAt });

  // Cut to the limit, points not bytes, and marked as cut.
  const quoted = /^Proposed "(.*)" starting /.exec(plan.reply.text)?.[1];
  assert.ok(quoted);
  assert.equal(Array.from(quoted).length, MAX_NAME_CHARACTERS);
  assert.ok(quoted.endsWith("…"));
  assert.ok(!plan.reply.text.includes("deep dive ".repeat(10)));

  const facet = plan.reply.facets?.[0];
  assert.ok(facet, "the reply has no link facet");
  assert.equal(facetedText(plan.reply.text, facet.index), plan.url);

  const parsed = v.safeParse(PlaceStreamChatMessage.mainSchema, plan.reply);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
});

test("renders the start time in whichever zone the model assumed", () => {
  const denver = planFor(EVENT, { timezone: "America/Denver" });
  assert.ok(
    denver.reply.text.includes("starting Fri, Oct 16, 2026, 10:00 AM MDT for you to review:"),
    denver.reply.text,
  );
  assert.ok(planFor(EVENT, { timezone: "UTC" }).reply.text.includes("4:00 PM UTC"));
});

test("falls back to quoting the record's own start time", () => {
  // Without a zone, rendering would be a guess, so the record's string — the
  // fact the reviewer is approving — is quoted instead.
  assert.ok(planFor().reply.text.includes(`starting ${EVENT.startsAt} for you to review:`));

  // And a start time that isn't a datetime has no rendering in the first place.
  assert.ok(
    planFor({ ...EVENT, startsAt: "9am-ish" }, { timezone: TIMEZONE }).reply.text.includes(
      "starting 9am-ish for you to review:",
    ),
  );
});

test("takes the uri when the model names where the record goes", () => {
  const something = `at://${REQUESTER}/community.lexicon.calendar.event/3mxxdrkntri2f`;
  const plan = planFor(EVENT, { uri: something });
  assert.equal(plan.target, something);
  assert.equal(plan.proposal.uri, something);
});

test("refuses a record it cannot place, rather than guessing", () => {
  assert.throws(() => planFor({ name: "no $type" }), /\$type/);
  assert.throws(() => planFor({ $type: "not an nsid" }), /\$type/);
  assert.throws(() => planFor(null), /JSON object/);
  assert.throws(
    () => planFor(EVENT, { uri: "at://example.com/community.lexicon.calendar.event/1" }),
    /canonical at-uri/,
  );

  // A CLI request names nobody, so there is no repo to propose into.
  const anonymous = buildScheduleRequest({
    record: { ...realMessage, text: "hey @sidechannel.cheeky.town schedule me" },
    bot: { did: BOT, identifier: "sidechannel.cheeky.town" },
    streamer: REQUESTER,
    requester: null,
    source: "cli",
    uri: "cli://schedule-request/1",
    cid: null,
    relay: null,
    hostTimezone: "America/Denver",
    now: FIXTURE_NOW,
  });
  assert.ok(anonymous);
  assert.throws(
    () => planProposal({ bot: BOT, request: anonymous, record: EVENT, now: FIXTURE_NOW }),
    /no repo to propose/,
  );
});

test("reads its own envelope back in, so a model can hand one back resolved", () => {
  const line = formatScheduleRequest(request());
  const read = readRequest(JSON.parse(line.slice(line.indexOf("{"))));
  assert.ok(read);
  assert.deepEqual(read, {
    channel: { streamer: REQUESTER },
    requester: { did: REQUESTER },
    message: { uri: URI, cid: CID },
  });

  // A CLI envelope has no requester and no cid, and still reads.
  const cli = readRequest({
    channel: { streamer: REQUESTER },
    requester: { did: null },
    message: { uri: "cli://schedule-request/1" },
  });
  assert.deepEqual(cli, {
    channel: { streamer: REQUESTER },
    requester: { did: null },
    message: { uri: "cli://schedule-request/1", cid: null },
  });

  // Anything that is not one of these envelopes, or is missing a place to
  // reply to, is refused.
  assert.equal(readRequest(null), null);
  assert.equal(readRequest({ message: { uri: URI } }), null);
  assert.equal(readRequest({ channel: { streamer: "nope" }, message: { uri: URI } }), null);
  assert.equal(
    readRequest({ channel: { streamer: REQUESTER }, requester: { did: 42 }, message: { uri: URI } }),
    null,
  );
  assert.equal(readRequest({ channel: { streamer: REQUESTER }, message: {} }), null);
  assert.equal(
    readRequest({ channel: { streamer: REQUESTER }, message: { uri: URI, cid: 42 } }),
    null,
  );
});

test("says in one line what was written where", () => {
  const plan = planFor();
  const written = {
    proposalUri: plan.proposalUri,
    chatUri: "at://" + BOT + "/place.stream.chat.message/3mxxdrkntri2g",
  };

  const line = formatProposal(plan, written);
  assert.equal(line, `[record.proposal] ${JSON.stringify({
    proposal: written.proposalUri,
    rkey: plan.rkey,
    target: plan.target,
    url: plan.url,
    text: plan.reply.text,
    streamer: plan.reply.streamer,
    chat: written.chatUri,
  })}`);

  // A dry run says so, and claims nothing was written.
  const dry = formatProposal(plan, { dryRun: true });
  assert.ok(dry.startsWith("[record.proposal] "));
  assert.equal(JSON.parse(dry.slice("[record.proposal] ".length)).dryRun, true);
  assert.equal(JSON.parse(dry.slice("[record.proposal] ".length)).proposal, undefined);
});