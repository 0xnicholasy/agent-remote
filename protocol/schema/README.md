# Protocol schemas

These JSON Schemas are the source of truth for the Agent Remote wire format. `agent-event.schema.json`
describes every event the Mac Agent Bridge publishes and `command.schema.json` describes every
command a client sends. Both are JSON Schema draft 2020-12 and both use `oneOf` over the `type`
field so that each type is checked against its own payload definition.

The Swift types in `protocol/swift` and the TypeScript types in `protocol/typescript` exist to
match these files. They are hand written today and are expected to be generated from the schemas
once the shapes stop moving; either way the schemas lead and the language bindings follow. When a
schema and a binding disagree, the binding is wrong.

The TypeScript test suite validates sample envelopes against these files directly, so a change
here that the types do not follow will fail `bun test`.
