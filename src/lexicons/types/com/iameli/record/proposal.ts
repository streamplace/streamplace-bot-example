import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _mainSchema = /*#__PURE__*/ v.record(
  /*#__PURE__*/ v.tidString(),
  /*#__PURE__*/ v.object({
    $type: /*#__PURE__*/ v.literal("com.iameli.record.proposal"),
    /**
     * Client-declared timestamp when this proposal was created.
     */
    createdAt: /*#__PURE__*/ v.datetimeString(),
    /**
     * The proposed record, exactly as it would be written.
     */
    record: /*#__PURE__*/ v.unknown(),
    /**
     * The URI the proposed record would be written to, if approved: at://<repo>/<collection>/<rkey>.
     */
    uri: /*#__PURE__*/ v.resourceUriString(),
  }),
);

type main$schematype = typeof _mainSchema;

export interface mainSchema extends main$schematype {}

export const mainSchema = _mainSchema as mainSchema;

export interface Main extends v.InferInput<typeof mainSchema> {}

declare module "@atcute/lexicons/ambient" {
  interface Records {
    "com.iameli.record.proposal": mainSchema;
  }
}
