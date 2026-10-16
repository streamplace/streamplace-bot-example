import { Client } from "@atcute/client";
import { PasswordSession } from "@atcute/password-session";
import { FirehoseSubscription } from "@atcute/firehose";
import * as ComAtprotoSyncSubscribeRepos from "@atcute/atproto/types/sync/subscribeRepos";
import type {} from "@atcute/atproto/types/repo/createRecord";
import { fromUint8Array } from "@atcute/car";
import { decode as decodeCbor, fromBytes } from "@atcute/cbor";
import { fromCidLink, toString as cidToString } from "@atcute/cid";
import { isDid, type Did, type Nsid } from "@atcute/lexicons/syntax";
import { readFile } from "node:fs/promises";

// Import generated lexicon types for type augmentation
import type {} from "./lexicons/types/place/stream/chat/message.js";
import {
  buildScheduleRequest,
  createCliMessage,
  formatScheduleRequest,
  readRequest,
  type BotIdentity,
} from "./schedule.js";
import {
  formatProposal,
  planProposal,
  PROPOSAL_COLLECTION,
  type ProposalPlan,
} from "./proposal.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

function optionalDidEnv(name: string): Did | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  if (!isDid(value)) {
    console.error(`${name} must be a DID (got ${value})`);
    process.exit(1);
  }
  return value;
}

const RELAY_URL = process.env.RELAY_URL ?? "wss://bsky.network";
const BOT_SERVICE = process.env.BOT_SERVICE ?? "https://stream.place";
/** Chat to watch. Unset means every chat that comes off the relay. */
const STREAMER_DID = optionalDidEnv("STREAMER_DID");
const BOT_IDENTIFIER = requireEnv("BOT_IDENTIFIER");

const TIMER_REPLY = `The timer in the corner of Eli's stream is there to measure end-to-end latency of the livestream. The timestamp itself is arbitrary, so it's counting down to Unix time 173173173173.173. Because if you put 173 in an old calculator and turn it upside down, it spells Eli.`;

interface CliArgs {
  request?: string;
  requester?: Did;
  streamer?: Did;
  /** Path to the proposal input: a saved request plus the resolved record. */
  propose?: string;
  /** Print what `--propose` would write, without writing it. */
  dryRun?: boolean;
}

/**
 * `--request "schedule a stream ..." [--requester did:plc:...] [--streamer did:plc:...]`
 * `--propose request.json [--dry-run]`
 */
function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const equals = arg.indexOf("=");
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    if (flag === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (
      flag !== "--request" &&
      flag !== "--requester" &&
      flag !== "--streamer" &&
      flag !== "--propose"
    ) {
      continue;
    }
    const value = equals === -1 ? argv[++i] : arg.slice(equals + 1);
    if (value === undefined) {
      console.error(`${flag} needs a value`);
      process.exit(1);
    }
    if (flag === "--request") {
      args.request = value;
    } else if (flag === "--propose") {
      args.propose = value;
    } else if (isDid(value)) {
      if (flag === "--requester") {
        args.requester = value;
      } else {
        args.streamer = value;
      }
    } else {
      console.error(`${flag} must be a DID (got ${value})`);
      process.exit(1);
    }
  }
  return args;
}

/**
 * The bot's DID is how its mentions are recognized: clients resolve the handle
 * when they build the `facets`, so matching on `did` is what actually works.
 */
async function resolveBotIdentity(): Promise<BotIdentity> {
  const identifier = BOT_IDENTIFIER;
  if (isDid(identifier)) return { did: identifier, identifier };
  try {
    const response = await fetch(
      `${BOT_SERVICE}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(identifier)}`,
    );
    if (!response.ok) {
      throw new Error(`${response.status} ${await response.text()}`);
    }
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "did" in body && isDid(body.did)) {
      return { did: body.did, identifier };
    }
    throw new Error("no did in response");
  } catch (err) {
    console.error(
      `Could not resolve bot handle ${identifier}: ${err}\n` +
        `Set BOT_IDENTIFIER to the bot's DID instead.`,
    );
    process.exit(1);
  }
}

/**
 * Writes one record into the bot's own repo and returns its URI, or null after
 * logging why. Every caller here is a CLI command, so exiting is on them.
 */
async function createRecord(
  client: Client,
  repo: Did,
  collection: Nsid,
  record: Record<string, unknown>,
  rkey?: string,
): Promise<string | null> {
  try {
    const resp = await client.post("com.atproto.repo.createRecord", {
      input: {
        repo,
        collection,
        ...(rkey === undefined ? {} : { rkey }),
        record,
      },
    });
    if (!resp.ok) {
      console.error(`Failed to write ${collection}:`, resp.data);
      return null;
    }
    return resp.data.uri;
  } catch (err) {
    console.error(`Failed to write ${collection}:`, err);
    return null;
  }
}

/**
 * `--propose input.json`: turn a resolved request into a proposal in the bot's
 * repo, and answer in chat with a link to it. The input is a saved envelope
 * with the resolved record added to it:
 *
 *   {"request": {…a [schedule.request] line…}, "record": {…}, "uri": "at://…"}
 *
 * `uri` is optional: without it the record is proposed at a fresh TID in the
 * requester's own repo. `--dry-run` prints what would be written, and the
 * link, without logging in or writing anything.
 *
 * Nothing is created in the requester's repo; approving the proposal is a
 * separate act, by them.
 */
async function runPropose(path: string, dryRun: boolean): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    console.error(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (typeof parsed !== "object" || parsed === null) {
    console.error(`${path} must contain a JSON object`);
    process.exit(1);
  }

  const request = "request" in parsed ? readRequest(parsed.request) : null;
  if (!request) {
    console.error(`${path} has no readable "request": save a [schedule.request] envelope into it`);
    process.exit(1);
  }
  const record = "record" in parsed ? parsed.record : undefined;
  if (record === undefined) {
    console.error(`${path} has no "record": the resolved record goes next to the request`);
    process.exit(1);
  }
  const uri = "uri" in parsed && typeof parsed.uri === "string" ? parsed.uri : undefined;

  const password = process.env.BOT_PASSWORD;
  if (!dryRun && !password) {
    console.error("--propose writes records: set BOT_PASSWORD, or pass --dry-run to see the plan");
    process.exit(1);
  }

  // Logging in is what says which repo the proposal goes in. A dry run only
  // needs the bot's DID, which resolves without a password.
  const session =
    password && !dryRun
      ? await PasswordSession.login({
          service: BOT_SERVICE,
          identifier: BOT_IDENTIFIER,
          password,
        })
      : null;
  const botDid = session?.did ?? (await resolveBotIdentity()).did;

  let plan: ProposalPlan;
  try {
    plan = planProposal({
      bot: botDid,
      request,
      record,
      uri,
      urlBase: process.env.PROPOSAL_URL_BASE,
      now: new Date(),
    });
  } catch (err) {
    console.error(`Cannot propose from ${path}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (session === null) {
    console.log(formatProposal(plan, { dryRun: true }));
    console.log("Dry run: nothing was written.");
    return;
  }

  console.log(`Logged in as ${session.did}`);
  const client = new Client({ handler: session });
  // The proposal's rkey is minted in the plan, so the link in the reply is
  // already correct when the record lands.
  const proposalUri = await createRecord(client, botDid, PROPOSAL_COLLECTION, plan.proposal, plan.rkey);
  if (proposalUri === null) {
    process.exit(1);
  }
  const chatUri = await createRecord(client, botDid, "place.stream.chat.message", plan.reply);
  if (chatUri === null) {
    console.error(
      `Wrote ${proposalUri}, but the reply failed: nothing points at the proposal yet.`,
    );
    process.exit(1);
  }
  console.log(formatProposal(plan, { proposalUri, chatUri }));
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // --request: pretend a chat message mentioned us, and emit the envelope.
  // Same code path as the firehose, minus the login and the CAR decoding.
  if (args.request !== undefined) {
    const streamer = args.streamer ?? STREAMER_DID;
    if (!streamer) {
      console.error("--request needs a streamer: set STREAMER_DID or pass --streamer");
      process.exit(1);
    }
    const bot = await resolveBotIdentity();
    const now = new Date();
    const request = buildScheduleRequest({
      record: createCliMessage({
        input: args.request,
        bot,
        streamer,
        now,
      }),
      bot,
      streamer,
      requester: args.requester ?? null,
      source: "cli",
      uri: `cli://schedule-request/${now.getTime()}`,
      cid: null,
      relay: null,
      hostTimezone,
    });
    if (!request) {
      throw new Error("could not build a schedule request from --request");
    }
    console.log(formatScheduleRequest(request));
    return;
  }

  // --propose: the request has been resolved, so write the proposal into the
  // bot's repo and answer in chat with a link to it.
  if (args.propose !== undefined) {
    await runPropose(args.propose, args.dryRun === true);
    return;
  }

  // Authenticate the bot. Schedule requests don't send anything, so a missing
  // password only costs us the ability to reply in chat.
  const password = process.env.BOT_PASSWORD;
  let session: PasswordSession | null = null;
  let bot: BotIdentity;
  if (password) {
    session = await PasswordSession.login({
      service: BOT_SERVICE,
      identifier: BOT_IDENTIFIER,
      password,
    });
    bot = { did: session.did, identifier: BOT_IDENTIFIER };
    console.log(`Logged in as ${session.did}`);
  } else {
    bot = await resolveBotIdentity();
    console.log(
      `No BOT_PASSWORD set: read-only, replies disabled. Watching for mentions of ${bot.did}.`,
    );
  }
  const client = session ? new Client({ handler: session }) : null;

  // Subscribe to the relay firehose
  const subscription = new FirehoseSubscription({
    service: RELAY_URL,
    nsid: ComAtprotoSyncSubscribeRepos.mainSchema,
    validateMessages: false,
  });

  console.log(
    `Listening for chat messages on ${RELAY_URL}` +
      (STREAMER_DID ? ` for streamer ${STREAMER_DID}...` : ", in every chat it carries..."),
  );

  for await (const message of subscription) {
    if (message.$type !== "com.atproto.sync.subscribeRepos#commit") {
      continue;
    }

    const commit = message as ComAtprotoSyncSubscribeRepos.Commit;

    for (const op of commit.ops) {
      if (op.action !== "create") continue;
      if (!op.path.startsWith("place.stream.chat.message/")) continue;
      if (!op.cid) continue;

      // Decode the CAR blocks to get the record
      const car = fromUint8Array(fromBytes(commit.blocks));

      // Convert the op CID (CidLink) to a string for comparison
      const opCidStr = cidToString(fromCidLink(op.cid));
      let record: Record<string, unknown> | undefined;

      for (const entry of car) {
        if (cidToString(entry.cid) === opCidStr) {
          record = decodeCbor(entry.bytes) as Record<string, unknown>;
          break;
        }
      }

      if (!record) continue;
      if (STREAMER_DID && record.streamer !== STREAMER_DID) continue;

      // The chat this landed in: the configured streamer when there is only
      // one, otherwise whatever the record says.
      const streamer = STREAMER_DID ?? (isDid(record.streamer) ? record.streamer : null);
      if (!streamer) continue;

      // Someone mentioned the bot: hand the request to the LLM on stdout.
      const request = buildScheduleRequest({
        record,
        bot,
        streamer,
        requester: commit.repo,
        source: "chat",
        uri: `at://${commit.repo}/${op.path}`,
        cid: opCidStr,
        relay: RELAY_URL,
        hostTimezone,
      });
      if (request) {
        console.log(`Got schedule request from ${commit.repo} in ${streamer}'s chat`);
        console.log(formatScheduleRequest(request));
        continue;
      }

      const text = typeof record.text === "string" ? record.text : "";
      if (!text.trim().startsWith("!timer")) continue;

      console.log(`Got !timer command from ${commit.repo}`);
      if (!client) {
        console.warn("Skipping reply: no BOT_PASSWORD set.");
        continue;
      }

      // Send a response
      const sent = await createRecord(client, bot.did, "place.stream.chat.message", {
        $type: "place.stream.chat.message",
        text: TIMER_REPLY,
        createdAt: new Date().toISOString(),
        streamer,
      });
      if (sent !== null) {
        console.log("Sent response");
      }
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});