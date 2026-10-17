// Tests for the scheduling model's boundary: what it is allowed to propose,
// and what happens when the research or the model itself goes wrong. The model
// is a scripted fake and `resolve_time` a lookup table; what's under test is
// how the scheduler gates their output. Run with `pnpm test`.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Did } from "@atcute/lexicons/syntax";

import { SchedulerError, resolveSchedule, type SchedulerOptions } from "./scheduler.js";
import { buildScheduleRequest, type ScheduleRequest } from "./schedule.js";

const BOT: Did = "did:plc:svzjldcfdhtytju6wa2vjrth";
const REQUESTER: Did = "did:plc:2zmxikig2sj7gqaezl5gntae";
const KEY = "sk-or-test-key-not-real";
const EVENT = "community.lexicon.calendar.event";
const LA = "America/Los_Angeles";

/** When the bot "processes" the request: moments after the message. */
const NOW = new Date("2026-10-16T00:45:00.000Z");

// Oct 15, 5:42pm in Seattle: "tomorrow at 9am" is Oct 16, 9:00 PDT = 16:00Z.
function request(): ScheduleRequest {
  const built = buildScheduleRequest({
    record: {
      $type: "place.stream.chat.message",
      text: "@sidechannel.cheeky.town schedule a stream for me tomorrow morning at 9am",
      streamer: REQUESTER,
      createdAt: "2026-10-16T00:42:06.791Z",
    },
    bot: { did: BOT, identifier: "sidechannel.cheeky.town" },
    streamer: REQUESTER,
    requester: REQUESTER,
    source: "chat",
    uri: `at://${REQUESTER}/place.stream.chat.message/3mxxdrkntri2e`,
    cid: "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5ryanw5swgssdfygczba",
    relay: "wss://bsky.network",
    hostTimezone: "America/Denver",
    now: NOW,
  });
  assert.ok(built, "the fixture message did not produce a request");
  return built;
}

// What resolve_time knows in these tests. Anything else does not exist.
const CIVIL_TIMES: Record<string, string> = {
  [`${LA}|2026-10-16T08:00:00`]: "2026-10-16T15:00:00.000Z",
  [`${LA}|2026-10-16T09:00:00`]: "2026-10-16T16:00:00.000Z",
  [`${LA}|2026-10-16T10:00:00`]: "2026-10-16T17:00:00.000Z",
  [`${LA}|2026-10-15T09:00:00`]: "2026-10-15T16:00:00.000Z",
  ["America/Denver|2026-10-16T09:00:00"]: "2026-10-16T15:00:00.000Z",
};

type Json = Record<string, unknown>;

interface Harness {
  options: SchedulerOptions;
  /** Request bodies, as sent to the model. */
  bodies: { messages: Json[]; tool_choice: string }[];
  /** Headers of every model call. */
  headers: Record<string, string>[];
  /** Research tool calls that actually ran. */
  ran: { name: string; args: Json }[];
}

function completion(message: Json, finish_reason = "stop"): Response {
  return new Response(JSON.stringify({ choices: [{ message, finish_reason }] }), {
    headers: { "content-type": "application/json" },
  });
}

/** A model turn asking for research. */
function toolTurn(...calls: [name: string, args: Json][]): Response {
  return completion(
    {
      role: "assistant",
      content: null,
      tool_calls: calls.map(([name, args], i) => ({
        id: `call_${i}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      })),
    },
    "tool_calls",
  );
}

/** A model turn that answers. */
function answerTurn(answer: unknown): Response {
  return completion({
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "finish",
      type: "function",
      function: {
        name: "finish_schedule",
        arguments: typeof answer === "string" ? answer : JSON.stringify(answer),
      },
    }],
  }, "tool_calls");
}

function harness(script: Response[], extra: Partial<SchedulerOptions> = {}): Harness {
  const h: Harness = { options: undefined as never, bodies: [], headers: [], ran: [] };
  const replies = [...script];
  h.options = {
    apiKey: KEY,
    now: () => NOW,
    context: async () => ({}),
    fetch: (async (_url: unknown, init: RequestInit) => {
      h.bodies.push(JSON.parse(String(init.body)));
      h.headers.push(init.headers as Record<string, string>);
      const next = replies.shift();
      assert.ok(next, "the model was called more often than the test scripted");
      return next;
    }) as typeof fetch,
    runTool: async (name, args) => {
      h.ran.push({ name, args });
      if (name !== "resolve_time") return { note: `${name} is not scripted` };
      const timezone = String(args.timezone);
      if (args.localTime === undefined) {
        return { timezone, localTime: "2026-10-15T17:42:06", instant: "2026-10-16T00:42:06.791Z" };
      }
      const instant = CIVIL_TIMES[`${timezone}|${String(args.localTime)}`];
      if (instant === undefined) {
        throw new Error(`${String(args.localTime)} does not exist or is ambiguous in ${timezone}`);
      }
      return { timezone, localTime: args.localTime, instant };
    },
    ...extra,
  };
  return h;
}

const resolve = (localTime: string, timezone = LA): [string, Json] => [
  "resolve_time",
  { timezone, localTime },
];

const event = (overrides: Json = {}): Json => ({
  $type: EVENT,
  name: "Web dev stream",
  description: "Building things live.",
  startsAt: "2026-10-16T09:00:00",
  endsAt: "2026-10-16T10:00:00",
  timezone: LA,
  ...overrides,
});

const answer = (records: unknown[], extra: Json = {}): Json => ({
  records,
  clarification: null,
  timezoneReason: "Their profile says Seattle.",
  ...extra,
});

/** Resolves 9am and 10am Pacific first, as a model that did its research would. */
function researched(...final: Response[]): Response[] {
  return [toolTurn(resolve("2026-10-16T09:00:00"), resolve("2026-10-16T10:00:00")), ...final];
}

async function run(h: Harness): Promise<Awaited<ReturnType<typeof resolveSchedule>>> {
  return resolveSchedule(request(), h.options);
}

const refused = (pattern: RegExp) => (error: unknown) => {
  assert.ok(error instanceof SchedulerError, `expected a SchedulerError, got ${String(error)}`);
  assert.match(error.message, pattern);
  return true;
};

function toolMessages(h: Harness, call: number): Json[] {
  return h.bodies[call]!.messages.filter((message) => message.role === "tool");
}

// --- code owns civil-time conversion and chronological boundaries --------------


test("an end at or before the start is refused", async () => {
  const h = harness([
    toolTurn(resolve("2026-10-16T09:00:00"), resolve("2026-10-16T08:00:00")),
    answerTurn(answer([event({ endsAt: "2026-10-16T08:00:00" })])),
  ]);
  await assert.rejects(run(h), refused(/endsAt is not after startsAt/));
});

test("an event resolved to before the message that asked for it is refused", async () => {
  const h = harness([
    toolTurn(resolve("2026-10-15T09:00:00")),
    answerTurn(answer([event({ startsAt: "2026-10-15T09:00:00", endsAt: undefined })])),
  ]);
  await assert.rejects(run(h), refused(/before the message/));
});

test("a delayed request cannot publish an event whose start has already passed", async () => {
  const h = harness(researched(answerTurn(answer([event()]))), {
    now: () => new Date("2026-10-16T18:00:00.000Z"),
  });
  await assert.rejects(run(h), refused(/already passed at processing time/));
});


test("normalizes both local endpoints to UTC without relying on model conversion", async () => {
  const h = harness([answerTurn(answer([event({ endsAt: "2026-10-16T09:30:00" })]))]);
  const record = (await run(h)).records[0]!;
  assert.equal(record.startsAt, "2026-10-16T16:00:00.000Z");
  assert.equal(record.endsAt, "2026-10-16T16:30:00.000Z");
});

test("rejects invalid and DST-ambiguous endpoints even if the model never checks them", async () => {
  for (const overrides of [
    { startsAt: "2026-03-08T02:30:00", endsAt: undefined },
    { startsAt: "2026-11-01T01:30:00", endsAt: undefined },
    { startsAt: "2026-11-01T00:30:00", endsAt: "2026-11-01T01:30:00" },
    { startsAt: "2027-02-29T09:00:00", endsAt: undefined },
    { startsAt: "2026-10-16T09:00:00-07:00", endsAt: undefined },
  ]) {
    const h = harness([answerTurn(answer([event(overrides)]))]);
    await assert.rejects(run(h), SchedulerError);
  }
});

test("a skipped-over or ambiguous local time reaches the model as data, and it can ask instead", async () => {
  const h = harness([
    toolTurn(resolve("2026-11-01T01:30:00")),
    answerTurn({
      records: [],
      clarification: "1:30am happens twice that night. Before or after the clocks go back?",
      timezoneReason: "Profile says Seattle.",
    }),
  ]);
  const result = await run(h);
  assert.deepEqual(result.records, []);
  assert.match(result.clarification ?? "", /happens twice/);

  const [message] = toolMessages(h, 1);
  const payload = JSON.parse(String(message!.content));
  assert.equal(payload.ok, false);
  assert.match(payload.error, /does not exist or is ambiguous/);
});

// --- tools are bounded ----------------------------------------------------------

test("an unknown tool is refused without running anything", async () => {
  const h = harness([
    toolTurn(["write_record", { collection: "app.bsky.feed.post", record: { text: "hi" } }]),
    answerTurn({ records: [], clarification: "When do you want it?", timezoneReason: "Unknown." }),
  ]);
  await run(h);
  assert.deepEqual(h.ran, []);
  const payload = JSON.parse(String(toolMessages(h, 1)[0]!.content));
  assert.equal(payload.ok, false);
  assert.match(payload.error, /unknown tool/);
});

test("tool arguments that are not a JSON object are an error result, not a crash", async () => {
  const bad = completion({
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "a", type: "function", function: { name: "get_profile", arguments: "{not json" } },
      { id: "b", type: "function", function: { name: "get_profile", arguments: "[1,2]" } },
    ],
  }, "tool_calls");
  const h = harness([bad, answerTurn({ records: [], clarification: "Who is it for?", timezoneReason: "Unknown." })]);
  await run(h);
  assert.deepEqual(h.ran, []);
  const payloads = toolMessages(h, 1).map((m) => JSON.parse(String(m.content)));
  assert.deepEqual(payloads.map((p) => p.ok), [false, false]);
});

test("calls beyond the tool budget get an error result and never run", async () => {
  const h = harness(
    [
      toolTurn(
        ["get_profile", { actor: "a.example" }],
        ["get_profile", { actor: "b.example" }],
        ["get_profile", { actor: "c.example" }],
      ),
      answerTurn({ records: [], clarification: "Which timezone?", timezoneReason: "Unknown." }),
    ],
    { maxToolCalls: 2 },
  );
  await run(h);
  assert.equal(h.ran.length, 2);
  const payloads = toolMessages(h, 1).map((m) => JSON.parse(String(m.content)));
  assert.equal(payloads[2].ok, false);
  assert.match(payloads[2].error, /budget/);
});

test("a model that keeps researching is cut off, and its last turn cannot call tools", async () => {
  const h = harness(
    [toolTurn(["get_profile", { actor: "a.example" }]), toolTurn(["get_profile", { actor: "b.example" }])],
    { maxRounds: 2 },
  );
  await assert.rejects(run(h), refused(/still asking for tools after 2 rounds/));
});

test("a tool that hangs becomes an error result instead of stalling the run", async () => {
  const h = harness(
    [
      toolTurn(["fetch_page", { url: "https://slow.example/" }]),
      answerTurn({ records: [], clarification: "What is the link?", timezoneReason: "Unknown." }),
    ],
    { toolTimeoutMs: 20, runTool: () => new Promise(() => {}) },
  );
  await run(h);
  const payload = JSON.parse(String(toolMessages(h, 1)[0]!.content));
  assert.equal(payload.ok, false);
  assert.match(payload.error, /timed out/);
});

test("an oversized tool result is cut and marked, not forwarded whole", async () => {
  const h = harness(
    [
      toolTurn(["fetch_page", { url: "https://big.example/" }]),
      answerTurn({ records: [], clarification: "What is the link?", timezoneReason: "Unknown." }),
    ],
    { runTool: async () => "x".repeat(200_000) },
  );
  await run(h);
  const content = String(toolMessages(h, 1)[0]!.content);
  assert.ok(content.length < 30_000, `tool message was ${content.length} characters`);
  assert.equal(JSON.parse(content).truncated, true);
});

test("a failed pre-fetch is reported to the model and the run goes on", async () => {
  const h = harness(
    [answerTurn({ records: [], clarification: "Which timezone are you in?", timezoneReason: "Unknown." })],
    {
      context: async () => {
        throw new Error("plc.directory unreachable");
      },
    },
  );
  const result = await run(h);
  assert.equal(result.clarification, "Which timezone are you in?");
  const user = String(h.bodies[0]!.messages[1]!.content);
  assert.match(user, /plc\.directory unreachable/);
});

test("the API key only travels in the OpenRouter header, never into the conversation", async () => {
  const h = harness(researched(answerTurn(answer([event()]))));
  await run(h);
  assert.deepEqual(h.headers.map((headers) => headers.authorization), [`Bearer ${KEY}`, `Bearer ${KEY}`]);
  for (const body of h.bodies) assert.ok(!JSON.stringify(body).includes(KEY));
  assert.ok(h.ran.every((call) => !JSON.stringify(call).includes(KEY)));
});

// --- what the model may propose -------------------------------------------------

test("only calendar events may be proposed", async () => {
  for (const $type of [
    "com.iameli.record.proposal",
    "place.stream.chat.message",
    "app.bsky.feed.post",
    undefined,
  ]) {
    const h = harness(researched(answerTurn(answer([event({ $type })]))));
    await assert.rejects(run(h), refused(/\$type must be community\.lexicon\.calendar\.event/), String($type));
  }
});

test("a repo, collection or provenance the model supplies never reaches the record", async () => {
  const h = harness(
    researched(
      answerTurn({
        ...answer([
          event({
            repo: "did:plc:attacker",
            collection: "app.bsky.feed.post",
            rkey: "3forged",
            uri: "at://did:plc:attacker/app.bsky.feed.post/3forged",
            createdAt: "1999-01-01T00:00:00.000Z",
            createdWith: "https://atmo.rsvp",
          }),
        ]),
        repo: "did:plc:attacker",
        uri: "at://did:plc:attacker/app.bsky.feed.post/3forged",
      }),
    ),
  );
  const result = await run(h);
  const record = result.records[0]!;
  for (const field of ["repo", "collection", "rkey", "uri"]) {
    assert.equal(Object.hasOwn(record, field), false, `${field} escaped into the event`);
  }
  assert.equal(record.createdAt, NOW.toISOString());
  assert.notEqual(record.createdWith, "https://atmo.rsvp");
});

test("link facets are computed in code from UTF-8 bytes; supplied facets are discarded", async () => {
  const description = "Join 🎉 live at https://stream.place/iame.li. Docs: (https://example.com/a_(b)).";
  const h = harness(
    researched(
      answerTurn(
        answer([
          event({
            description,
            facets: [
              {
                index: { byteStart: 0, byteEnd: 9999 },
                features: [{ $type: "app.bsky.richtext.facet#mention", did: "did:plc:attacker" }],
              },
            ],
          }),
        ]),
      ),
    ),
  );
  const [record] = (await run(h)).records;
  const facets = record!.facets as {
    index: { byteStart: number; byteEnd: number };
    features: { $type: string; uri: string }[];
  }[];
  const bytes = Buffer.from(description);
  assert.deepEqual(
    facets.map((facet) => [bytes.subarray(facet.index.byteStart, facet.index.byteEnd).toString(), facet.features]),
    [
      [
        "https://stream.place/iame.li",
        [{ $type: "app.bsky.richtext.facet#link", uri: "https://stream.place/iame.li" }],
      ],
      [
        "https://example.com/a_(b)",
        [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com/a_(b)" }],
      ],
    ],
  );
  // The emoji is 4 bytes but 2 UTF-16 units: a character-based offset would land here.
  assert.notEqual(facets[0]!.index.byteStart, description.indexOf("https"));
});

test("supplied facets on a description with no links leave no facets at all", async () => {
  const h = harness(
    researched(
      answerTurn(
        answer([
          event({
            facets: [{ index: { byteStart: 0, byteEnd: 4 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://evil.example" }] }],
          }),
        ]),
      ),
    ),
  );
  const [record] = (await run(h)).records;
  assert.ok(!("facets" in record!));
});

test("media is kept only when it is a blob the requester's own events already carry", async () => {
  const real = {
    role: "thumbnail",
    content: { $type: "blob", ref: { $link: "bafkreiexisting" }, mimeType: "image/jpeg", size: 1234 },
    aspect_ratio: { width: 1280, height: 720 },
  };
  const forged = { ...real, content: { ...real.content, ref: { $link: "bafkreiinvented" } } };
  const wrongSize = { ...real, content: { ...real.content, size: 99 } };
  const wrongShape = { ...real, aspect_ratio: { width: 1, height: 1 } };
  const h = harness(researched(answerTurn(answer([event({ media: [forged, wrongSize, wrongShape, real] })]))), {
    context: async () => ({
      calendarEvents: [{ uri: "at://x/community.lexicon.calendar.event/1", value: { media: [real] } }],
    }),
  });
  const [record] = (await run(h)).records;
  assert.deepEqual(record!.media, [real]);

  const without = harness(researched(answerTurn(answer([event({ media: [real] })]))));
  assert.ok(!("media" in (await run(without)).records[0]!), "a blob nobody can vouch for was kept");
});

test("records the lexicon or the approval flow couldn't honour are refused", async () => {
  const cases: [string, Json, RegExp][] = [
    ["offset instead of a zone", event({ timezone: "-07:00" }), /timezone is not an IANA zone/],
    ["abbreviation instead of a zone", event({ timezone: "PST" }), /timezone is not an IANA zone/],
    ["sloppy zone casing", event({ timezone: "america/los_angeles" }), /timezone is not an IANA zone/],
    ["an unknown status", event({ status: "confirmed" }), /status is not a known/],
    ["a plain-http link", event({ uris: [{ uri: "http://stream.place/iame.li" }] }), /uris entries need an https URL/],
    ["a link with credentials", event({ uris: [{ uri: "https://user:pw@example.com/" }] }), /uris entries need an https URL/],
    ["no description", event({ description: "  " }), /description is empty/],
    ["no name", event({ name: undefined }), /name is required/],
  ];
  for (const [label, record, pattern] of cases) {
    const h = harness(researched(answerTurn(answer([record]))));
    await assert.rejects(run(h), refused(pattern), label);
  }
});

// --- the shape of the answer ----------------------------------------------------

test("the answer must be exactly one of records or a short clarification", async () => {
  const cases: [string, unknown, RegExp][] = [
    ["both", answer([event()], { clarification: "Also, which game?" }), /both records and a clarification/],
    ["neither", answer([]), /neither a record nor a clarification/],
    ["a blank clarification", answer([], { clarification: "   " }), /neither a record nor a clarification/],
    ["a clarification over 280 characters", answer([], { clarification: "?".repeat(281) }), /longer than 280/],
    ["too many records", answer(Array.from({ length: 6 }, () => event())), /at most 5/],
    ["records that aren't a list", { records: event(), clarification: null, timezoneReason: "x" }, /records must be an array/],
    ["no timezone reason", { records: [], clarification: "When?" }, /no timezoneReason/],
    ["a non-string clarification", answer([], { clarification: { text: "When?" } }), /clarification must be a string/],
    ["prose", "Sure! I scheduled it for 9am.", /not valid JSON/],
    ["a JSON list", "[1, 2]", /not a JSON object/],
  ];
  for (const [label, reply, pattern] of cases) {
    const h = harness(researched(answerTurn(reply)));
    await assert.rejects(run(h), refused(pattern), label);
  }
});

test("a clarification of exactly 280 characters is fine, counted in characters not bytes", async () => {
  const question = "é".repeat(280);
  const h = harness([answerTurn({ records: [], clarification: question, timezoneReason: "Unknown." })]);
  assert.equal((await run(h)).clarification, question);
});


// --- provider failures write nothing --------------------------------------------

test("provider failures, refusals and truncation are errors, not partial results", async () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const cases: [string, Response, RegExp][] = [
    ["rate limit", json({ error: { message: "rate limited", code: 429 } }, 429), /HTTP 429: rate limited/],
    ["an error inside a 200", json({ error: { message: "upstream exploded" } }), /upstream exploded/],
    ["an error on the choice", json({ choices: [{ error: { message: "provider hiccup" }, message: {} }] }), /provider hiccup/],
    ["an HTML error page", new Response("<html>Bad gateway</html>", { status: 502 }), /HTTP 502/],
    ["a truncated answer", completion({ role: "assistant", content: '{"records": [' }, "length"), /cut off/],
    ["a truncated tool call", completion({ role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "get_profile", arguments: '{"actor": "a' } }] }, "length"), /cut off/],
    ["a content filter", completion({ role: "assistant", content: "" }, "content_filter"), /content filter/],
    ["a refusal", completion({ role: "assistant", content: null, refusal: "I can't help with that." }), /refused: I can't help/],
    ["no choices", json({ choices: [] }), /no completion/],
    ["a tool call without an id", completion({ role: "assistant", content: null, tool_calls: [{ type: "function", function: { name: "get_profile", arguments: "{}" } }] }, "tool_calls"), /malformed tool call/],
  ];
  for (const [label, response, pattern] of cases) {
    const h = harness([response]);
    await assert.rejects(run(h), refused(pattern), label);
    assert.deepEqual(h.ran, [], label);
  }
});

test("a network failure is an error that names OpenRouter and not the key", async () => {
  const h = harness([], {
    fetch: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
  });
  await assert.rejects(run(h), (error: unknown) => {
    assert.ok(error instanceof SchedulerError);
    assert.match(error.message, /OpenRouter request failed: fetch failed/);
    assert.ok(!error.message.includes(KEY));
    return true;
  });
});
