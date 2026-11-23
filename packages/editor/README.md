# @openapi-proxy/editor

The screen a variant is edited on: the operations of the document with a checkbox each, the document they produce next to them, who may read it, and what stands at its top. React components, with the primitives they are drawn with and the design tokens.

It is shown in two places, and exists as a package so that both show the same thing:

- the app, over a project the service holds ([`src/web/pages/variant-editor.tsx`](../../src/web/pages/variant-editor.tsx));
- the page `openapi-proxy dev` serves, over an `openapi-proxy.yaml` ([`packages/cli/page/main.tsx`](../cli/page/main.tsx)).

It is not published. Both hosts import it from its TypeScript source as `@editor/*`, and each builds it with its own bundler.

## What a host gives it

The editor knows no router and no API. A host passes what differs:

```tsx
<VariantEditor
  project={project} // the definition and its state, as packages/core/src/definition/api.ts describes them
  variant={variant} // the open variant; left out for a new one
  document={document} // the project's documents assembled into one, once that is here
  apply={(change) => save(change(project.definition))} // publish in the app, write the file locally
  describeError={(error) => "..."}
  onCreated={(slug) => open(slug)}
  onRenamed={(slug) => open(slug)}
  onDuplicate={(slug) => open(slug)}
  onDeleted={() => openTheProject()}
/>;
```

Everything the editor saves goes through `apply`: it hands over a change to the project's definition, and the host applies the whole definition. What only one host has comes in as optional props: where a key for a private variant is made (`privateAction`), "View as file" (`onViewAsFile`), a notice of its own (`banner`), and what saving is called there (`words`). What the backend can do at all is in `project.state.can`: a project that is deployed from a file is shown read-only, and the local page has no keys, credentials or checks to offer.

## Layout

| Path                     | What is in it                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `src/variant-editor.tsx` | The screen, and the state of a draft                                                                      |
| `src/components`         | Its parts: the operation picker, the result pane, the sheet for title and servers, the visibility control |
| `src/ui`                 | Primitives from shadcn on Base UI, restyled through the tokens                                            |
| `src/lib`                | Reading a project view, highlighting, small helpers                                                       |
| `src/theme.css`          | The design tokens, materials and utilities. A host imports it into its own stylesheet                     |

The rules it is drawn by are in [docs/design.md](../../docs/design.md), and what each interaction means in [docs/flows.md](../../docs/flows.md).

## License

MIT
