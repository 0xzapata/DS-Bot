# Group chat at narrow widths

- Date: 2026-11-11
- Scope: the group chat's round rows and the member approval card. No change to the column, the sidebar, or the composer.

## Why

A group round mixes three kinds of rows: member replies, admin routing (the admin hands the message to a member with @Name), and handoffs (one Bot passes work to another). Today all three read the same. A member reply that the admin routed has no sign of it. On a phone (390 px) long tool names, code lines and Bot names push past the column, and the approval card's code line and buttons can run out of the card.

## Decided behavior

1. **Routing apart from replies.** A member reply that another member called in carries a small "via {caller}" tag in its name row, after the admin tag. The host already records the caller (`slot.by`); the reply row now keeps it as `by`. A reply the user called has no tag. The tag uses the existing `.bt-group-role` look (12 / 500, `--bt-ink-2`), so the name row keeps one style (standard 10.12).
2. **Handoffs as their own row.** A member that starts work in the background (`working`) or finishes it (`done`) keeps its centered event line (`.bt-event`), now with the handoff arrow icon in front, so it reads as a hand-off and not as a reply. No new component: the event line is the standard's row for non-message events.
3. **No horizontal scroll at 390 px.**
   - `.bt-group-replies`, `.bt-group-msg` and the name row get `min-width: 0`, and the name row wraps (`flex-wrap`), so a long name or tag wraps instead of widening the row.
   - Event lines already wrap; their text gets `overflow-wrap: anywhere` for long Bot names and paths.
   - Bubbles already use `overflow-wrap: anywhere` (standard 4.3 bubble widths stay as they are).
4. **Approval cards fit.** `.bt-mw-card` gets `min-width: 0; max-width: 100%; box-sizing: border-box`. Its text wraps (`overflow-wrap: anywhere`). The code line keeps one line with an ellipsis and its full text in `title`, as now. The action row wraps (`flex-wrap`) so "Reject" and "Allow once" stay inside the card. Buttons keep their height (28 px).

## Check against `docs/design/ui-standard.md`

- 4.3 Layout sizes: bubble widths and the composer card width are unchanged.
- 10.4 Tags: the "via" tag reuses the existing group role tag, not a new chip.
- 10.8 Cards: the approval card keeps its radius 12 and its background; only its overflow changes.
- 10.12 Conversation: the event line stays the row for non-message events; handoffs keep that row and gain only an icon.
- 11 Copy: "via {name}" is short, with a Chinese string "经 {name}".
- 12 Accessibility: the icon is `aria-hidden`; the event line's text names the Bot and the action, so a screen reader reads the same.
- 9.6 Reduced motion: no new animation.

## Not done

- No new layout for wide screens.
- No change to how the host routes a round.
- No separate admin lane or column. One column reads best at 390 px; a second lane would need horizontal room the phone does not have.

## How it is verified

- A unit test renders a round with a routed reply and checks the "via" tag, and checks that a reply without a caller has none.
- A unit test reads the compiled CSS and checks the overflow rules above.
- The 390 px browser check (no horizontal scroll, approval card inside the column) needs a running DSH and is not run in this change.
