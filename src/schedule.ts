// Schedule requests: something in chat mentions the bot, and we hand the
// request off to an LLM by printing one JSON envelope per line on stdout.
//
// The bot deliberately does not reason about times, timezones, or titles
// itself — that is the LLM's job. Everything it needs to do that research
// (who asked, what they said, exactly when they said it) is in the envelope.

import * as v from "@atcute/lexicons/validations";
import { isDid, type Did } from "@atcute/lexicons/syntax";
import * as PlaceStreamChatMessage from "./lexicons/types/place/stream/chat/message.js";

/** Prefix for the machine-readable line, so consumers can grep stdout. */
export const SCHEDULE_REQUEST_MARKER = "[schedule.request]";

const CHAT_MESSAGE_TYPE = "place.stream.chat.message";

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

export interface BotIdentity {
  /** DID the bot's own mentions carry in `facets`. */
  did: Did;
  /** Handle or DID, as configured. */
  identifier: string;
}

export interface ScheduleRequest {
  kind: "schedule.request";
  /** `chat` when it came off the firehose, `cli` for `--request`. */
  source: "chat" | "cli";
  /** When the bot emitted this envelope (ISO 8601, UTC). */
  emittedAt: string;
  bot: BotIdentity;
  /** The DID of the streamer whose chat the request arrived in. */
  channel: { streamer: Did };
  /** DID of the person asking; null for CLI requests with no `--requester`. */
  requester: { did: Did | null };
  message: {
    uri: string;
    cid: string | null;
    /** Client-declared. Streamplace clients write UTC, with no offset. */
    createdAt: string;
    /**
     * Offset declared in `createdAt` itself, in minutes east of UTC, or null
     * when the timestamp is UTC — which is the common case. Non-null is a
     * strong hint at the author's timezone; null is not.
     */
    createdAtUtcOffsetMinutes: number | null;
    /** The message as typed, mentions included. */
    text: string;
    /** `text` with the bot's own mentions removed — the prompt. */
    prompt: string;
    /**
     * `facet` when the client resolved the bot's handle into a mention facet,
     * `text` when the handle/DID was only typed. Both are real mentions.
     */
    mentionSource: MentionSource;
    facets: FacetLike[];
  };
  relay: string | null;
  /** Where the bot ran, as a last-resort timezone signal. */
  host: { timezone: string; utcOffsetMinutes: number };
}

/**
 * A chat message as accepted from the wire. `text`, `createdAt` and `streamer`
 * are checked against the lexicon; facets are not, because Streamplace clients
 * label them `app.bsky.richtext.facet` — the same shape as Streamplace's own
 * `place.stream.richtext.facet`, whose lexicon aliases Bluesky's definitions —
 * and validating that name rejects real messages.
 */
export interface ChatMessage {
  $type: typeof CHAT_MESSAGE_TYPE;
  text: string;
  createdAt: string;
  streamer: Did;
  facets: FacetLike[];
}

/** A facet feature, as far as this bot cares: mentions carry `did`, links `uri`. */
export interface FacetFeature {
  $type?: string;
  did?: string;
  uri?: string;
}

/** A facet: a byte range plus whatever features the client attached to it. */
export interface FacetLike {
  $type?: string;
  index: { byteStart: number; byteEnd: number };
  features: FacetFeature[];
}

/** Keeps the fields we use and drops anything malformed. */
function sanitizeFeature(value: unknown): FacetFeature | null {
  if (typeof value !== "object" || value === null) return null;
  const source = value as Record<string, unknown>;
  const feature: FacetFeature = {};
  if (typeof source.$type === "string") feature.$type = source.$type;
  if (typeof source.did === "string") feature.did = source.did;
  if (typeof source.uri === "string") feature.uri = source.uri;
  if (feature.did === undefined && feature.uri === undefined) return null;
  return feature;
}

/**
 * Facets from a decoded record: unreadable entries — and entries left with no
 * readable feature — are dropped.
 */
function sanitizeFacets(value: unknown): FacetLike[] {
  if (!Array.isArray(value)) return [];
  const facets: FacetLike[] = [];
  for (const facet of value) {
    if (typeof facet !== "object" || facet === null) continue;
    const source = facet as { $type?: unknown; index?: unknown; features?: unknown };
    const index = source.index as { byteStart?: unknown; byteEnd?: unknown } | undefined;
    if (typeof index?.byteStart !== "number" || typeof index.byteEnd !== "number") continue;
    if (index.byteStart < 0 || index.byteEnd < index.byteStart) continue;
    const features: FacetFeature[] = [];
    for (const feature of Array.isArray(source.features) ? source.features : []) {
      const kept = sanitizeFeature(feature);
      if (kept) features.push(kept);
    }
    if (features.length === 0) continue;
    facets.push({
      ...(typeof source.$type === "string" ? { $type: source.$type } : {}),
      index: { byteStart: index.byteStart, byteEnd: index.byteEnd },
      features,
    });
  }
  return facets;
}

interface Range {
  start: number;
  end: number;
}

export type MentionSource = "facet" | "text";

export interface Mention {
  /** `facet` when the client resolved the handle, `text` when it was just typed. */
  source: MentionSource;
  ranges: Range[];
}

/** Bytes that can be part of a handle/DID, used for token boundary checks. */
function isTokenByte(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    (byte >= 0x41 && byte <= 0x5a) || // A-Z
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    byte === 0x2d || // -
    byte === 0x2e || // .
    byte === 0x5f || // _
    byte === 0x3a // :
  );
}

/** ASCII-only lowercase: handles and DIDs are ASCII. */
function foldAscii(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    out[i] = byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
  }
  return out;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  const last = haystack.length - needle.length;
  outer: for (let i = Math.max(from, 0); i <= last; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Byte ranges of the message that mention `did`, per its `facets`. */
function facetMentionRanges(
  facets: readonly FacetLike[] | undefined,
  did: string,
): Range[] {
  const ranges: Range[] = [];
  for (const facet of facets ?? []) {
    const mentions = facet.features.some((feature) => feature.did === did);
    if (!mentions) continue;
    const { byteStart, byteEnd } = facet.index;
    if (byteStart < byteEnd) ranges.push({ start: byteStart, end: byteEnd });
  }
  return ranges;
}

/**
 * Byte ranges where the bot's handle or DID was typed as plain text. Clients
 * only write a mention facet once they resolve the handle, so a mention that
 * was typed (or that the client couldn't resolve) has no facet at all.
 */
function textMentionRanges(text: string, bot: BotIdentity): Range[] {
  const haystack = foldAscii(utf8.encode(text));
  const tokens = bot.identifier === bot.did ? [bot.did] : [bot.identifier, bot.did];
  const ranges: Range[] = [];
  for (const token of tokens) {
    const needle = foldAscii(utf8.encode(`@${token}`));
    for (let at = indexOfBytes(haystack, needle); at !== -1; at = indexOfBytes(haystack, needle, at + 1)) {
      if (at > 0 && isTokenByte(haystack[at - 1]!)) continue;
      const after = haystack[at + needle.length];
      if (after !== undefined && isTokenByte(after)) continue;
      ranges.push({ start: at, end: at + needle.length });
    }
  }
  return ranges;
}

/** Where the bot was mentioned, or null when it wasn't. */
export function findMention(message: ChatMessage, bot: BotIdentity): Mention | null {
  const facets = facetMentionRanges(message.facets, bot.did);
  if (facets.length > 0) {
    return { source: "facet", ranges: facets.sort((a, b) => a.start - b.start) };
  }
  const text = textMentionRanges(message.text, bot);
  return text.length > 0
    ? { source: "text", ranges: text.sort((a, b) => a.start - b.start) }
    : null;
}

/** Minutes east of UTC declared in a datetime string, or null for UTC. */
export function utcOffsetMinutes(iso: string): number | null {
  const match = /([+-])(\d{2}):?(\d{2})$/.exec(iso.trim());
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

/** The message with the bot's mentions cut out, whitespace collapsed. */
export function promptText(message: ChatMessage, mention: Mention): string {
  const bytes = utf8.encode(message.text);
  const kept: Uint8Array[] = [];
  let at = 0;
  for (const { start, end } of mention.ranges) {
    if (start > at) kept.push(bytes.subarray(at, start));
    at = Math.max(at, Math.min(end, bytes.length));
  }
  if (at < bytes.length) kept.push(bytes.subarray(at));
  const out = new Uint8Array(kept.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of kept) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return utf8Decoder.decode(out).replace(/\s+/g, " ").trim();
}

/**
 * Reads a decoded record as a chat message, or null when it isn't one. The
 * lexicon validates everything except `facets`, which are sanitized separately
 * because clients type them after Bluesky's lexicon (see `ChatMessage`).
 */
export function asChatMessage(record: unknown): ChatMessage | null {
  if (typeof record !== "object" || record === null) return null;
  const { facets, ...rest } = record as Record<string, unknown>;
  const parsed = v.safeParse(PlaceStreamChatMessage.mainSchema, rest);
  if (!parsed.ok) return null;
  return {
    $type: CHAT_MESSAGE_TYPE,
    text: parsed.value.text,
    createdAt: parsed.value.createdAt,
    streamer: parsed.value.streamer,
    facets: sanitizeFacets(facets),
  };
}

export interface BuildScheduleRequestOptions {
  /** Decoded record from the firehose, or a synthetic one for CLI runs. */
  record: unknown;
  bot: BotIdentity;
  streamer: Did;
  requester: Did | null;
  source: ScheduleRequest["source"];
  uri: string;
  cid: string | null;
  relay: string | null;
  hostTimezone: string;
  now?: Date;
}

/**
 * Builds the envelope for a chat message that mentions the bot, or null when
 * the record is not a well-formed `place.stream.chat.message` that mentions it.
 */
export function buildScheduleRequest(
  options: BuildScheduleRequestOptions,
): ScheduleRequest | null {
  const message = asChatMessage(options.record);
  if (!message) {
    // Something in this streamer's chat isn't shaped like a chat message; say
    // so rather than looking like a mention was ignored.
    console.error(`${options.uri} is not a readable place.stream.chat.message`);
    return null;
  }
  const mention = findMention(message, options.bot);
  if (!mention) return null;

  const now = options.now ?? new Date();
  return {
    kind: "schedule.request",
    source: options.source,
    emittedAt: now.toISOString(),
    bot: options.bot,
    channel: { streamer: options.streamer },
    requester: { did: options.requester },
    message: {
      uri: options.uri,
      cid: options.cid,
      createdAt: message.createdAt,
      createdAtUtcOffsetMinutes: utcOffsetMinutes(message.createdAt),
      text: message.text,
      prompt: promptText(message, mention),
      mentionSource: mention.source,
      facets: message.facets,
    },
    relay: options.relay,
    host: {
      timezone: options.hostTimezone,
      utcOffsetMinutes: -now.getTimezoneOffset(),
    },
  };
}

/** One line, greppable, JSON — the whole machine-facing contract. */
export function formatScheduleRequest(request: ScheduleRequest): string {
  return `${SCHEDULE_REQUEST_MARKER} ${JSON.stringify(request)}`;
}

/**
 * The parts of an envelope that say where a record goes and what to reply to.
 * `ScheduleRequest` satisfies this as it stands, so a request the bot just
 * built and one read back from stdout are equally usable.
 */
export interface RequestRef {
  /** The chat the request arrived in. */
  channel: { streamer: Did };
  /** Who asked; null for a CLI request that named nobody. */
  requester: { did: Did | null };
  /** The message being answered: what the reply points at. */
  message: { uri: string; cid: string | null };
}

/**
 * Reads an envelope back in, which is how `--propose` picks up a request a
 * model has since resolved. Only the fields above are checked: this is the bot
 * reading its own output, and the envelope's job is to survive that round trip
 * through a language model unchanged.
 */
export function readRequest(value: unknown): RequestRef | null {
  if (typeof value !== "object" || value === null) return null;

  const channel = "channel" in value ? value.channel : undefined;
  const streamer =
    typeof channel === "object" && channel !== null && "streamer" in channel
      ? channel.streamer
      : undefined;
  if (!isDid(streamer)) return null;

  const requester = "requester" in value ? value.requester : undefined;
  const did =
    typeof requester === "object" && requester !== null && "did" in requester
      ? requester.did
      : undefined;
  if (did !== undefined && did !== null && !isDid(did)) return null;

  const message = "message" in value ? value.message : undefined;
  const uri =
    typeof message === "object" && message !== null && "uri" in message
      ? message.uri
      : undefined;
  const cid =
    typeof message === "object" && message !== null && "cid" in message
      ? message.cid
      : undefined;
  if (typeof uri !== "string") return null;
  if (cid !== undefined && cid !== null && typeof cid !== "string") return null;

  return {
    channel: { streamer },
    requester: { did: isDid(did) ? did : null },
    message: { uri, cid: typeof cid === "string" ? cid : null },
  };
}

/** Stands in for a real chat message when the bot is driven from the CLI. */
export function createCliMessage(options: {
  input: string;
  bot: BotIdentity;
  streamer: Did;
  now: Date;
}): ChatMessage {
  const mention = `@${options.bot.identifier}`;
  return {
    $type: CHAT_MESSAGE_TYPE,
    text: `${mention} ${options.input}`,
    createdAt: options.now.toISOString(),
    streamer: options.streamer,
    facets: [
      {
        $type: "place.stream.richtext.facet",
        index: { byteStart: 0, byteEnd: utf8.encode(mention).length },
        features: [{ $type: "place.stream.richtext.facet#mention", did: options.bot.did }],
      },
    ],
  };
}