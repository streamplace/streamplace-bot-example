import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";
import * as ComAtprotoRepoStrongRef from "@atcute/atproto/types/repo/strongRef";
import * as PlaceStreamRichtextFacet from "../richtext/facet.js";

const _mainSchema = /*#__PURE__*/ v.record(
  /*#__PURE__*/ v.tidString(),
  /*#__PURE__*/ v.object({
    $type: /*#__PURE__*/ v.literal("place.stream.chat.message"),
    /**
     * Client-declared timestamp when this message was originally created.
     */
    createdAt: /*#__PURE__*/ v.datetimeString(),
    /**
     * Annotations of text (mentions, URLs, etc)
     */
    get facets() {
      return /*#__PURE__*/ v.optional(
        /*#__PURE__*/ v.array(PlaceStreamRichtextFacet.mainSchema),
      );
    },
    get reply() {
      return /*#__PURE__*/ v.optional(replyRefSchema);
    },
    /**
     * The DID of the streamer whose chat this is.
     */
    streamer: /*#__PURE__*/ v.didString(),
    /**
     * The primary message content. May be an empty string, if there are embeds.
     * @maxLength 3000
     * @maxGraphemes 300
     */
    text: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
      /*#__PURE__*/ v.stringLength(0, 3000),
      /*#__PURE__*/ v.stringGraphemes(0, 300),
    ]),
  }),
);
const _replyRefSchema = /*#__PURE__*/ v.object({
  $type: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.literal("place.stream.chat.message#replyRef"),
  ),
  get parent() {
    return ComAtprotoRepoStrongRef.mainSchema;
  },
  get root() {
    return ComAtprotoRepoStrongRef.mainSchema;
  },
});

type main$schematype = typeof _mainSchema;
type replyRef$schematype = typeof _replyRefSchema;

export interface mainSchema extends main$schematype {}
export interface replyRefSchema extends replyRef$schematype {}

export const mainSchema = _mainSchema as mainSchema;
export const replyRefSchema = _replyRefSchema as replyRefSchema;

export interface Main extends v.InferInput<typeof mainSchema> {}
export interface ReplyRef extends v.InferInput<typeof replyRefSchema> {}

declare module "@atcute/lexicons/ambient" {
  interface Records {
    "place.stream.chat.message": mainSchema;
  }
}
