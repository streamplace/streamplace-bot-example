// Proposed records: instead of writing a record into somebody else's repo with
// the bot's credentials, the bot writes a `com.iameli.record.proposal` into its
// own repo — holding the record the requester would create, and the URI it
// would be created at — and answers in chat with a link to review it.
// Approving it is a separate act, by whoever the record is for.
//
// Everything here is a pure function of the schedule request envelope and the
// record the model resolved, so the parts that are easy to get subtly wrong —
// minting a TID, deriving the target at-uri, the byte range that makes the link
// clickable — are testable without a PDS.

import * as v from "@atcute/lexicons/validations";
import {
  isCanonicalResourceUri,
  isDid,
  isNsid,
  type CanonicalResourceUri,
  type Did,
  type Nsid,
} from "@atcute/lexicons/syntax";

import * as ComIameliRecordProposal from "./lexicons/types/com/iameli/record/proposal.js";
import * as PlaceStreamChatMessage from "./lexicons/types/place/stream/chat/message.js";
import type { RequestRef } from "./schedule.js";

/** The proposal record, as this bot writes it. */
export type ProposalRecord = v.InferInput<typeof ComIameliRecordProposal.mainSchema>;

/** The chat message, as this bot writes it. */
export type ChatReply = v.InferInput<typeof PlaceStreamChatMessage.mainSchema>;

/** The collection proposals live in. They are always in the bot's own repo. */
export const PROPOSAL_COLLECTION = "com.iameli.record.proposal";

/** Prefix for the machine-readable line describing a proposal. */
export const PROPOSAL_MARKER = "[record.proposal]";

/**
 * Where review links point until there is a frontend built for them. Any
 * ordinary at-uri viewer will do: the link carries the whole proposal.
 */
export const DEFAULT_PROPOSAL_URL_BASE = "https://pdsls.dev";

/** Kept well inside the chat message limits, so a long name can't break them. */
export const MAX_NAME_CHARACTERS = 80;

const utf8 = new TextEncoder();

// TIDs, the way the PDS mints them for record keys: 53 bits of microseconds
// since the epoch, 10 bits of clock id, written in base32-sortable.
const TID_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";
const TID_LENGTH = 13;

let clockId = Math.floor(Math.random() * 1024);
let lastValue = 0n;

/** Two TIDs minted in the same microsecond still have to sort in order. */
function nextClockId(): number {
  clockId = (clockId + 1) & 0x3ff;
  return clockId;
}

/**
 * A TID for `now`. Sorts after every TID minted before it and before every one
 * minted after it, which is what makes rkey order time order.
 */
export function mintTid(now: Date, clock: number = nextClockId()): string {
  let value = (BigInt(now.getTime()) * 1000n << 10n) | BigInt(clock & 0x3ff);
  // Same microsecond as the last one, or a clock that went backwards: step
  // past it, since two records can't share a key.
  if (value <= lastValue) value = lastValue + 1n;
  lastValue = value;
  let tid = "";
  for (let i = 0; i < TID_LENGTH; i++) {
    tid = TID_ALPHABET[Number(value & 31n)] + tid;
    value >>= 5n;
  }
  return tid;
}

/** Records this bot builds are validated before they are written anywhere. */
function checked<TSchema extends v.BaseSchema<unknown, unknown>>(
  schema: TSchema,
  value: unknown,
  what: string,
): v.InferOutput<TSchema> {
  try {
    return v.parse(schema, value);
  } catch (err) {
    throw new Error(`built an invalid ${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface PlanProposalOptions {
  /** The bot's DID: proposals are written into its own repo. */
  bot: Did;
  /** The request being answered: who asked, in which chat, and where. */
  request: RequestRef;
  /** The record the model resolved, to be created if the requester approves. */
  record: unknown;
  /**
   * Where the record would be written. Defaults to a fresh TID in the
   * requester's own repo.
   */
  uri?: string;
  /** Base URL of the review frontend. Defaults to `DEFAULT_PROPOSAL_URL_BASE`. */
  urlBase?: string;
  now?: Date;
}

export interface ProposalPlan {
  /** `com.iameli.record.proposal` record, ready for the bot's repo. */
  proposal: ProposalRecord;
  /** The rkey the proposal is written at — fixed here, so the link is too. */
  rkey: string;
  /** The proposal's own at-uri, which is what the review link points at. */
  proposalUri: CanonicalResourceUri;
  /** Where the proposed record would be written, if it is approved. */
  target: CanonicalResourceUri;
  /** Link to put in front of whoever has to approve it. */
  url: string;
  /** `place.stream.chat.message` record, ready for the bot's repo. */
  reply: ChatReply;
}

/** `{base}/at://{did}/{collection}/{rkey}` — resolvable by ordinary viewers. */
export function reviewUrl(urlBase: string, proposalUri: CanonicalResourceUri): string {
  return `${urlBase.replace(/\/+$/, "")}/at://${proposalUri.slice("at://".length)}`;
}

/** The collection the record claims to be, checked because the URI needs it. */
function recordCollection(record: unknown): Nsid {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new Error("the proposed record must be a JSON object");
  }
  const type = "$type" in record ? record.$type : undefined;
  if (typeof type !== "string" || !isNsid(type)) {
    throw new Error(
      `the proposed record needs a $type that is a collection NSID (got ${JSON.stringify(type)}); ` +
        "add one, or say where the record goes with `uri`",
    );
  }
  return type;
}

/** Where the proposed record would live, if it is approved. */
function targetUri(options: PlanProposalOptions, collection: Nsid, now: Date): CanonicalResourceUri {
  if (options.uri !== undefined) {
    if (isCanonicalResourceUri(options.uri)) return options.uri;
    throw new Error(
      `uri is not a canonical at-uri (at://did:…/collection/rkey): ${options.uri}`,
    );
  }

  // The requester's repo: the record is proposed *to them*. A bot that wrote
  // into other people's repos on request would be a spam machine, and the
  // model that resolved the request can always name another repo with `uri`.
  const requester = options.request.requester.did;
  if (!isDid(requester)) {
    throw new Error(
      "the request has no requester, so there is no repo to propose the record in; " +
        "say where it goes with `uri`",
    );
  }
  return `at://${requester}/${collection}/${mintTid(now)}`;
}

/** The name to quote in chat: one line, and short enough to leave room for the link. */
function recordName(record: unknown): string | null {
  if (typeof record !== "object" || record === null) return null;
  const name = "name" in record ? record.name : undefined;
  if (typeof name !== "string") return null;
  const line = name.trim().replace(/\s+/g, " ");
  if (line === "") return null;
  const points = Array.from(line);
  return points.length <= MAX_NAME_CHARACTERS
    ? line
    : `${points.slice(0, MAX_NAME_CHARACTERS - 1).join("")}…`;
}

/**
 * The start time to show in chat, verbatim. Quoting the record's own string is
 * deliberate: rendering it would mean guessing a timezone, and the offset in
 * the string is the one the model resolved.
 */
function recordStart(record: unknown): string | null {
  if (typeof record !== "object" || record === null) return null;
  const startsAt = "startsAt" in record ? record.startsAt : undefined;
  return typeof startsAt === "string" && startsAt !== "" ? startsAt : null;
}

/** What the reply says. Kept in one place because its byte offsets matter. */
function replyText(record: unknown, url: string): string {
  const name = recordName(record);
  const start = name === null ? null : recordStart(record);
  if (name === null) return `Proposed a record for you to review: ${url}`;
  if (start === null) return `Proposed "${name}" for you to review: ${url}`;
  return `Proposed "${name}" starting ${start} for you to review: ${url}`;
}

/**
 * Plans everything a proposal needs: the record to write, where it goes, and
 * the chat reply that links to it. Throws when the request or the record does
 * not say enough to build one.
 */
export function planProposal(options: PlanProposalOptions): ProposalPlan {
  const now = options.now ?? new Date();
  const target = targetUri(options, recordCollection(options.record), now);
  const rkey = mintTid(now);
  const proposalUri: CanonicalResourceUri =
    `at://${options.bot}/${PROPOSAL_COLLECTION}/${rkey}`;
  const url = reviewUrl(options.urlBase ?? DEFAULT_PROPOSAL_URL_BASE, proposalUri);
  const text = replyText(options.record, url);

  // The link is the last thing in the message, so its facet is a byte range
  // ending at the end of the text. Bytes, not characters: the name is arbitrary.
  const byteEnd = utf8.encode(text).length;
  const byteStart = byteEnd - utf8.encode(url).length;

  const { uri, cid } = options.request.message;
  const proposal: ProposalRecord = checked(
    ComIameliRecordProposal.mainSchema,
    {
      $type: PROPOSAL_COLLECTION,
      uri: target,
      record: options.record,
      createdAt: now.toISOString(),
    },
    "proposal record",
  );

  const reply: ChatReply = checked(
    PlaceStreamChatMessage.mainSchema,
    {
      $type: "place.stream.chat.message",
      text,
      createdAt: now.toISOString(),
      streamer: options.request.channel.streamer,
      facets: [
        {
          index: { byteStart, byteEnd },
          features: [{ $type: "app.bsky.richtext.facet#link", uri: url }],
        },
      ],
      // Streamplace's own clients reply with root and parent set to the same
      // message, so do the same rather than guessing at a thread root.
      ...(cid !== null ? { reply: { root: { uri, cid }, parent: { uri, cid } } } : {}),
    },
    "chat reply",
  );

  return { proposal, rkey, proposalUri, target, url, reply };
}

/**
 * One line, greppable, JSON — what was written where. The URIs are only known
 * after the PDS has accepted the writes, so they are passed in.
 */
export function formatProposal(
  plan: ProposalPlan,
  written: { proposalUri?: string; chatUri?: string; dryRun?: boolean } = {},
): string {
  return `${PROPOSAL_MARKER} ${JSON.stringify({
    ...(written.dryRun ? { dryRun: true } : {}),
    ...(written.proposalUri ? { proposal: written.proposalUri } : {}),
    rkey: plan.rkey,
    target: plan.target,
    url: plan.url,
    text: plan.reply.text,
    streamer: plan.reply.streamer,
    ...(written.chatUri ? { chat: written.chatUri } : {}),
  })}`;
}