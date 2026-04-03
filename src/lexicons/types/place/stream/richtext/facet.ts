import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import * as AppBskyRichtextFacet from "@atcute/bluesky/types/app/richtext/facet";

const _mainSchema = /*#__PURE__*/ v.object({
  $type: /*#__PURE__*/ v.optional(
    /*#__PURE__*/ v.literal("place.stream.richtext.facet"),
  ),
  get features() {
    return /*#__PURE__*/ v.array(
      /*#__PURE__*/ v.variant([
        AppBskyRichtextFacet.linkSchema,
        AppBskyRichtextFacet.mentionSchema,
      ]),
    );
  },
  get index() {
    return AppBskyRichtextFacet.byteSliceSchema;
  },
});

type main$schematype = typeof _mainSchema;

export interface mainSchema extends main$schematype {}

export const mainSchema = _mainSchema as mainSchema;

export interface Main extends v.InferInput<typeof mainSchema> {}
