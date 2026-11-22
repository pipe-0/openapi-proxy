# Design system

How the interface is built, and the rules it follows. The system lives in three places: tokens and materials in [`src/web/styles.css`](../src/web/styles.css), primitives in [`src/web/components/ui`](../src/web/components/ui), and the app's own vocabulary in [`src/web/components`](../src/web/components).

## Principles

1. **One meaning per control.** A checked operation is served. A raised control can be pressed. The solid indigo button is the one thing this screen is for. Nothing means two things depending on a mode.
2. **Hierarchy from type and space.** A title, a description directly beneath it, then content. Sections sit 56px apart. Rules and boxes are the exception, used where something really is a separate object (a dialog, the sign-in card).
3. **Color is reserved.** Structure is neutral. Indigo means "interactive, and primary" (the main action, a checked box, a focus ring). Green, amber and red mean judgment and appear nowhere else. Plain facts never get a color.
4. **Show the result, not a description of it.** The editor shows the document being served, live. The URL bar shows the URL as it will be requested.
5. **Nothing goes live by accident.** Edits are staged, the screen says so, and leaving with unpublished changes asks first.
6. **Plain words.** Short sentences, sentence case, no decoration. Status is a word in a chip, with nothing put in front of it. Nothing is ever set in all caps.
7. **Quiet by default.** A screen shows what is needed to act and keeps the rest one hover or one click away. An operation is a method and a path; its description is a tooltip. A number that is already on screen is not repeated in a second place. Before adding a chip, a count or a border, ask what would be lost without it.

## Foundations

### Color

Tokens use the shadcn names, so components from that ecosystem drop in unchanged. Each has a light and a dark value; dark mode is the `.dark` class on `<html>`.

| Token                                          | Use                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| `background`, `foreground`                     | The page and its text                                             |
| `subtle`                                       | One step off the background: the sidebar, code, a read-only field |
| `muted`, `muted-foreground`                    | Quiet fills and second-level text                                 |
| `faint`                                        | Third-level text: placeholders, counts, punctuation               |
| `border`, `input`                              | Dividers, and field outlines (one step stronger)                  |
| `primary`, `ring`                              | Indigo: the main action, checked state, focus                     |
| `destructive`                                  | Deleting                                                          |
| `ok`, `warn`, `bad` (+ `-foreground`, `-edge`) | Status tints with readable text and a hairline edge               |

HTTP methods get a hue each through one recipe (`.method`, keyed on `data-method`), tuned in OKLCH so all of them have the same weight in both schemes. A method is a colored word, not a chip.

### Type

- **UI text** is the system font at 14px (13px in dense lists).
- **Headings** are Inter with its optical-size axis (`font-display`), self-hosted. `type-title` is 26px for the page, `type-heading` 16px for sections.
- **Monospace is for code only**: documents and snippets shown as code, and a secret shown once to be copied (an API key). Paths, URLs, header names and slugs are ordinary text. An operation's path parameters are small chips with their name (`run_id`), not braces.

### Materials

Controls get their body from the edge, not from a shadow underneath: a border that catches light at the top and deepens toward the bottom, one inset highlight, a hairline of cast shadow. Faces stay flat.

| Class                            | Is                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| `material-raised` (+ `-hover`)   | Anything pressable that is not the main action; the selected item of a switch or the sidebar |
| `material-solid`                 | The main action. Takes its color from `--tone` (indigo)                                      |
| `material-solid material-danger` | The same, in red, for the confirm button of a deletion                                       |

### Shape and density

Radius is 0.6rem with a short scale around it. Controls are 32px tall (28px small, 36px large); list rows 32px; table rows 48px.

## Components

Primitives come from [shadcn/ui](https://ui.shadcn.com) in its Base UI flavor ("base-nova") and are restyled with the tokens and materials above. Add one with `pnpm dlx shadcn@latest add <name>`, then run `pnpm lint:fix`.

The app's own components, and when to use them:

| Component          | Use it for                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`           | `default` once per screen. `outline` for everything else. `ghost` inside dense rows.                                                                    |
| `Segmented`        | Every choice among a few visible options: filters, formats, switches. A quiet track with the selection lifted off it. Never tabs with a different look. |
| `StatusChip`       | A status or a fact as a word. `ok`, `warn`, `bad` for judgment, `accent` for "new", `neutral` for facts. No dot or icon in front.                       |
| `MethodChip`       | An HTTP method as a colored word, at a fixed width so paths line up.                                                                                    |
| `OperationPath`    | An operation's path: UI text, faint slashes, each parameter as a chip with its name.                                                                    |
| `Notice`           | Something to read in the flow of a page: an error, a change in the source.                                                                              |
| `Section`, `Field` | Settings: title and description as one unit; label, control, hint.                                                                                      |
| `PageHeader`       | Top of a page: title, description beneath, the page's actions on the right.                                                                             |
| `CopyButton`       | Copying. The icon confirms, and a toast says what was copied.                                                                                           |
| `SlugInput`        | A slug edited inside the URL it produces, with the availability check behind it.                                                                        |

## Layout

Every signed-in screen is the same frame: a 240px sidebar that says where you are (project, its variants) and a main area that is all content. Pages are one centered column, at most 896px wide. The editor is the exception: it fills the main area and scrolls its two panes separately, because both have to stay in view.

## Behavior

- **Keyboard.** `⌘K` opens the command menu anywhere. `N` starts a variant. In the editor `/` focuses the filter, arrow keys walk the list, `Space` toggles, `⌘↵` or `⌘S` publishes.
- **Feedback.** Things that happened are a toast. Things that are wrong stay next to what caused them until they are fixed.
- **Motion.** Short and functional: a menu opening, the ring around a newly created URL. All of it yields to `prefers-reduced-motion`.
- **Dark mode.** System by default, switchable from the account menu. Applied before first paint by a small external script, so there is no flash and no inline script for the Content-Security-Policy to allow.

## Checking a change

`SCREENSHOTS_DIR=some/dir pnpm test:e2e` walks the whole product, the landing page included, and saves every screen in both schemes. Look at them before calling a UI change done.

## The landing page and the blog

They use the same tokens, type and materials as the app, with more room: a wider measure, larger headings, sections far apart. The same rules hold, and two more: the picture of the product is a real screenshot from the journeys, never a mock; and every claim on the page is something a test checks.
