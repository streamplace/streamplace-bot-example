import { Client } from "@atcute/client";
import { PasswordSession } from "@atcute/password-session";
import { FirehoseSubscription } from "@atcute/firehose";
import * as ComAtprotoSyncSubscribeRepos from "@atcute/atproto/types/sync/subscribeRepos";
import type {} from "@atcute/atproto/types/repo/createRecord";
import type {} from "@atcute/atproto/types/repo/applyWrites";
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
  type ScheduleRequest,
} from "./schedule.js";
import {
  formatProposal,
  planProposal,
  mintTid,
  PROPOSAL_COLLECTION,
  type ProposalPlan,
} from "./proposal.js";
import { resolveSchedule, DEFAULT_OPENROUTER_MODEL, type SchedulerOptions } from "./scheduler.js";

async function secret(name: string): Promise<string | undefined> {
  const value = process.env[name]?.trim();
  if (value) return value;
  const path = process.env[`${name}_FILE`];
  if (!path) return undefined;
  const contents = (await readFile(path, "utf8")).trim();
  if (!contents) throw new Error(`${name}_FILE is empty`);
  return contents;
}

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
  /** Resolve a saved schedule.request envelope through the configured model. */
  resolve?: string;
  /** Resolve without publishing, or preview a manually supplied proposal. */
  dryRun?: boolean;
}

/**
 * `--request "schedule a stream ..." [--requester did:plc:...] [--streamer did:plc:...]`
 * `--propose request.json [--dry-run]`
 * `--resolve envelope.json [--dry-run]`
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
      flag !== "--resolve" &&
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
    } else if (flag === "--resolve") {
      args.resolve = value;
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
 * logging why. The caller decides how to handle a failed write.
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

/** Commit proposals and their replies together, so a reply cannot point at a missing proposal. */
async function writePlans(client: Client, bot: Did, plans: ProposalPlan[]): Promise<void> {
  const chatKeys = plans.map(() => mintTid(new Date()));
  const writes = plans.flatMap((plan, index) => [
    {
      $type: "com.atproto.repo.applyWrites#create" as const,
      collection: PROPOSAL_COLLECTION as Nsid,
      rkey: plan.rkey,
      value: plan.proposal,
    },
    {
      $type: "com.atproto.repo.applyWrites#create" as const,
      collection: "place.stream.chat.message" as const,
      rkey: chatKeys[index],
      value: plan.reply,
    },
  ]);
  const response = await client.post("com.atproto.repo.applyWrites", {
    input: { repo: bot, writes },
  });
  if (!response.ok) throw new Error(`Could not publish proposals: ${JSON.stringify(response.data)}`);
  for (const [index, plan] of plans.entries()) {
    console.log(formatProposal(plan, {
      proposalUri: plan.proposalUri,
      chatUri: `at://${bot}/place.stream.chat.message/${chatKeys[index]}`,
    }));
  }
}

function threadedReply(request: ScheduleRequest, text: string): Record<string, unknown> {
  const { uri, cid } = request.message;
  return {
    $type: "place.stream.chat.message",
    text,
    createdAt: new Date().toISOString(),
    streamer: request.channel.streamer,
    ...(cid ? { reply: { root: { uri, cid }, parent: { uri, cid } } } : {}),
  };
}

async function handleSchedule(
  request: ScheduleRequest,
  bot: BotIdentity,
  client: Client | null,
  options: SchedulerOptions,
  dryRun: boolean,
): Promise<void> {
  const result = await resolveSchedule(request, options);
  console.log(`[schedule.result] ${JSON.stringify(result)}`);
  if (result.clarification !== null) {
    const reply = threadedReply(request, result.clarification);
    if (dryRun) {
      console.log(`[schedule.reply] ${JSON.stringify({ dryRun: true, record: reply })}`);
    } else if (!client || await createRecord(client, bot.did, "place.stream.chat.message", reply) === null) {
      throw new Error("Could not send scheduling clarification");
    }
    return;
  }
  const plans = result.records.map((record) => planProposal({
    bot: bot.did,
    request,
    record,
    timezone: record.timezone as string,
    urlBase: process.env.PROPOSAL_URL_BASE,
  }));
  if (dryRun) {
    for (const plan of plans) console.log(formatProposal(plan, { dryRun: true }));
    console.log("Dry run: nothing was written.");
  } else {
    if (!client) throw new Error("BOT_PASSWORD or BOT_PASSWORD_FILE is required to publish");
    await writePlans(client, bot.did, plans);
  }
}

async function readEnvelope(path: string): Promise<ScheduleRequest> {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (
    !readRequest(value) || value.kind !== "schedule.request" ||
    !isDid(value.bot?.did) || typeof value.bot?.identifier !== "string" ||
    typeof value.message?.prompt !== "string" ||
    typeof value.message?.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.message.createdAt))
  ) {
    throw new Error(`${path} must contain a complete schedule.request envelope`);
  }
  return value as ScheduleRequest;
}

/**
 * `--propose input.json`: turn a resolved request into a proposal in the bot's
 * repo, and answer in chat with a link to it. The input is a saved envelope
 * with the resolved record added to it:
 *
 *   {"request": {…a [schedule.request] line…}, "record": {…}, "uri": "at://…",
 *    "timezone": "America/Los_Angeles"}
 *
 * `uri` is optional: without it the record is proposed at a fresh TID in the
 * requester's own repo. `timezone` is optional too, and is the zone the model
 * resolved the request in: the reply renders the start time in it, and without
 * it the record's own `startsAt` string is quoted instead. `--dry-run` prints
 * what would be written, and the link, without logging in or writing anything.
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
  const timezone = "timezone" in parsed ? parsed.timezone : undefined;
  if (timezone !== undefined && typeof timezone !== "string") {
    console.error(`${path} has a "timezone" that is not a string`);
    process.exit(1);
  }

  const password = await secret("BOT_PASSWORD");
  if (!dryRun && !password) {
    console.error("--propose writes records: set BOT_PASSWORD or BOT_PASSWORD_FILE, or pass --dry-run");
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
      timezone,
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
  await writePlans(client, botDid, [plan]);
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (args.propose !== undefined) {
    await runPropose(args.propose, args.dryRun === true);
    return;
  }
  const apiKey = await secret("OPENROUTER_API_KEY");
  const scheduler: SchedulerOptions | null = apiKey
    ? { apiKey, model: process.env.OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL }
    : null;
  const password = await secret("BOT_PASSWORD");
  if (scheduler && !password && !args.dryRun) {
    throw new Error("Autonomous scheduling requires BOT_PASSWORD or BOT_PASSWORD_FILE; use --dry-run to write nothing");
  }
  if (args.resolve && !scheduler) {
    throw new Error("--resolve requires OPENROUTER_API_KEY or OPENROUTER_API_KEY_FILE");
  }

  if (args.resolve) {
    const request = await readEnvelope(args.resolve);
    const session = password && !args.dryRun
      ? await PasswordSession.login({ service: BOT_SERVICE, identifier: BOT_IDENTIFIER, password })
      : null;
    const bot = session ? { did: session.did, identifier: BOT_IDENTIFIER } : await resolveBotIdentity();
    await handleSchedule(request, bot, session ? new Client({ handler: session }) : null, scheduler!, args.dryRun === true);
    return;
  }

  // --request: exercise the same scheduling path without needing a chat write.
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
    if (scheduler) {
      const session = password && !args.dryRun
        ? await PasswordSession.login({ service: BOT_SERVICE, identifier: BOT_IDENTIFIER, password })
        : null;
      await handleSchedule(request, bot, session ? new Client({ handler: session }) : null, scheduler, args.dryRun === true);
    }
    return;
  }

  const shutdownTimeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 25_000);
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1 || shutdownTimeoutMs > 2_147_483_647) {
    throw new Error("SHUTDOWN_TIMEOUT_MS must be a positive integer within the Node timer range");
  }
  let stopping = false;
  let closeRelay: (() => Promise<unknown>) | undefined;
  const pending = new Set<Promise<unknown>>();
  function track<T>(operation: Promise<T>): Promise<T> {
    const task = operation.finally(() => pending.delete(task));
    pending.add(task);
    return task;
  }
  function shutdown(signal: NodeJS.Signals): void {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received: stopping relay intake and draining ${pending.size} in-flight operation(s)`);
    const deadline = setTimeout(() => {
      console.error(`Shutdown timed out after ${shutdownTimeoutMs}ms with ${pending.size} unfinished operation(s); check proposal/chat records before replaying requests.`);
      process.exit(1);
    }, shutdownTimeoutMs);
    void (async () => {
      await closeRelay?.();
      await Promise.allSettled(pending);
      // The relay iterator's return() closes its socket but does not wake a
      // pending next(). Exit explicitly after draining work and flushing stdout.
      process.stdout.write("Shutdown complete\n", () => {
        clearTimeout(deadline);
        process.exit(0);
      });
    })().catch((error) => {
      console.error("Shutdown failed:", error);
      process.exit(1);
    });
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Authenticate once for the live listener and autonomous writes.
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
  if (stopping) return;
  const client = session && !args.dryRun ? new Client({ handler: session }) : null;
  console.log(scheduler
    ? `Autonomous scheduling enabled: ${scheduler.model}${args.dryRun ? " (dry run)" : ""}`
    : "No OpenRouter key: schedule requests are emitted to stdout only.");
  const active = new Set<string>();
  const seen = new Set<string>();

  // Subscribe to the relay firehose
  const subscription = new FirehoseSubscription({
    service: RELAY_URL,
    nsid: ComAtprotoSyncSubscribeRepos.mainSchema,
    validateMessages: false,
    onConnectionOpen: () => console.log("Relay connected"),
    onConnectionError: () => console.error("Relay connection error"),
  });
  const messages = subscription[Symbol.asyncIterator]();
  closeRelay = () => messages.return();

  console.log(
    `Listening for chat messages on ${RELAY_URL}` +
      (STREAMER_DID ? ` for streamer ${STREAMER_DID}...` : ", in every chat it carries..."),
  );

  for await (const message of messages) {
    if (stopping) break;
    if (message.$type !== "com.atproto.sync.subscribeRepos#commit") {
      continue;
    }

    const commit = message as ComAtprotoSyncSubscribeRepos.Commit;
    if (commit.repo === bot.did) continue;

    for (const op of commit.ops) {
      if (stopping) break;
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

      // Preserve the diagnostic envelope; resolve automatically when a model is configured.
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
        if (scheduler && !seen.has(request.message.uri)) {
          seen.add(request.message.uri);
          if (seen.size > 2048) seen.delete(seen.values().next().value!);
          if (active.size >= 3) {
            if (client) await track(createRecord(client, bot.did, "place.stream.chat.message", threadedReply(
              request, "I'm handling a few scheduling requests already. Please try again shortly.",
            )));
          } else {
            active.add(request.message.uri);
            // Do not block the high-volume firehose while the model researches this request.
            void track(handleSchedule(request, bot, client, scheduler, args.dryRun === true)
              .catch(async (error) => {
                console.error(`Scheduling failed for ${request.message.uri}:`, error);
                if (client) await createRecord(client, bot.did, "place.stream.chat.message", threadedReply(
                  request, "I couldn't finish scheduling. Please check recent proposals before trying again.",
                ));
              })
              .finally(() => active.delete(request.message.uri)));
          }
        }
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
      const sent = await track(createRecord(client, bot.did, "place.stream.chat.message", {
        $type: "place.stream.chat.message",
        text: TIMER_REPLY,
        createdAt: new Date().toISOString(),
        streamer,
      }));
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