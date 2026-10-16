import { Client } from "@atcute/client";
import { PasswordSession } from "@atcute/password-session";
import { FirehoseSubscription } from "@atcute/firehose";
import * as ComAtprotoSyncSubscribeRepos from "@atcute/atproto/types/sync/subscribeRepos";
import type {} from "@atcute/atproto/types/repo/createRecord";
import { fromUint8Array } from "@atcute/car";
import { decode as decodeCbor, fromBytes } from "@atcute/cbor";
import { fromCidLink, toString as cidToString } from "@atcute/cid";
import { isDid, type Did } from "@atcute/lexicons/syntax";

// Import generated lexicon types for type augmentation
import type {} from "./lexicons/types/place/stream/chat/message.js";
import {
  buildScheduleRequest,
  createCliMessage,
  formatScheduleRequest,
  type BotIdentity,
} from "./schedule.js";

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
}

/** `--request "schedule a stream ..." [--requester did:plc:...] [--streamer did:plc:...]` */
function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const equals = arg.indexOf("=");
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    if (flag !== "--request" && flag !== "--requester" && flag !== "--streamer") continue;
    const value = equals === -1 ? argv[++i] : arg.slice(equals + 1);
    if (value === undefined) {
      console.error(`${flag} needs a value`);
      process.exit(1);
    }
    if (flag === "--request") {
      args.request = value;
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
      try {
        const resp = await client.post("com.atproto.repo.createRecord", {
          input: {
            repo: bot.did,
            collection: "place.stream.chat.message",
            record: {
              $type: "place.stream.chat.message",
              text: TIMER_REPLY,
              createdAt: new Date().toISOString(),
              streamer,
            },
          },
        });
        if (!resp.ok) {
          console.error("Failed to send response:", resp.data);
        } else {
          console.log("Sent response");
        }
      } catch (err) {
        console.error("Failed to send response:", err);
      }
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});