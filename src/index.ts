import { Client, ok } from "@atcute/client";
import { PasswordSession } from "@atcute/password-session";
import { FirehoseSubscription } from "@atcute/firehose";
import * as ComAtprotoSyncSubscribeRepos from "@atcute/atproto/types/sync/subscribeRepos";
import { fromUint8Array } from "@atcute/car";
import { decode as decodeCbor, fromBytes } from "@atcute/cbor";
import { fromCidLink, toString as cidToString } from "@atcute/cid";

// Import generated lexicon types for type augmentation
import type {} from "./lexicons/types/place/stream/chat/message.js";

const RELAY_URL = process.env.RELAY_URL ?? "wss://relay.stream.place";
const STREAMER_DID = process.env.STREAMER_DID;
const BOT_SERVICE = process.env.BOT_SERVICE ?? "https://pds.stream.place";
const BOT_IDENTIFIER = process.env.BOT_IDENTIFIER;
const BOT_PASSWORD = process.env.BOT_PASSWORD;

if (!STREAMER_DID) {
  console.error("STREAMER_DID is required");
  process.exit(1);
}
if (!BOT_IDENTIFIER || !BOT_PASSWORD) {
  console.error("BOT_IDENTIFIER and BOT_PASSWORD are required");
  process.exit(1);
}

async function main() {
  // Authenticate the bot
  const session = await PasswordSession.login({
    service: BOT_SERVICE,
    identifier: BOT_IDENTIFIER!,
    password: BOT_PASSWORD!,
  });
  const client = new Client({ handler: session });
  console.log(`Logged in as ${session.did}`);

  // Subscribe to the relay firehose
  const subscription = new FirehoseSubscription({
    service: RELAY_URL,
    nsid: ComAtprotoSyncSubscribeRepos.mainSchema,
    validateMessages: false,
  });

  console.log(`Listening for chat messages on ${RELAY_URL} for streamer ${STREAMER_DID}...`);

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
      // commit.blocks is a Bytes wrapper at runtime; unwrap to Uint8Array
      const blocksBytes = fromBytes(commit.blocks as any);
      const car = fromUint8Array(blocksBytes);

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
      if (record.streamer !== STREAMER_DID) continue;

      const text = record.text as string;
      if (!text.trim().startsWith("!timer")) continue;

      console.log(`Got !timer command from ${commit.repo}`);

      // Send a response
      try {
        const resp = await (client as any).post("com.atproto.repo.createRecord", {
          input: {
            repo: session.did,
            collection: "place.stream.chat.message",
            record: {
              $type: "place.stream.chat.message",
              text: "timer explanation here",
              createdAt: new Date().toISOString(),
              streamer: STREAMER_DID,
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
