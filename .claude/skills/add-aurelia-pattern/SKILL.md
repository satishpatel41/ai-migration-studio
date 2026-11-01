---
name: add-aurelia-pattern
description: Add support for a new Aurelia 1 binding, attribute, lifecycle hook or decorator to the migration engine, with tests. Use when a real app uses a construct the report flags as unsupported.
---

# Add an Aurelia pattern

1. Reproduce: add the smallest failing view/view-model to `test/component.test.ts` (use the `run()` helper) and confirm the current output or warning.
2. Locate the layer:
   - Attribute or element on a view: `src/core/template.ts` (`buildAttributes`, `renderElement`).
   - Expression syntax (`$parent`, converters, assignments): `src/core/expr.ts`.
   - `this.*` usage in a method body: `src/core/rewrite.ts`.
   - Decorators, constructor, fields: `src/core/vm.ts`; component assembly and lifecycle: `src/core/generate.ts`.
3. Convert only when the mapping is exact. Otherwise emit a warning with `needsAi: true` and keep the original text visible. Never invent behavior.
4. Immutable updates only: state is changed through `setX(...)` built by `makeSetterCall`.
5. Run `npm run typecheck && npm test`. The compile test must still pass (strict TS over generated output). If the sample app is affected, update `test/fixtures/sample-app`.
6. Document the mapping in the README tables and list any new limitation.
