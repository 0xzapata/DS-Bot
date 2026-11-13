# This fork is discontinued

On 2026-11-14 work on this fork (0xzapata/DS-Bot, branch `fork/dev`) stopped. The work continues in zeron. Upstream DS Bot (Fei2411/DS-Bot) is not affected.

## What the fork added

Reviewed and checked in the app (up to `697bb570`):

- **Jev automatic model picker.** A Bot in Auto mode gets a model for each message (`ds-bot/src/host/auto-model.js`).
- **Group chat "Auto" replies.** Jev picks which members answer a message (`ds-bot/src/host/auto-reply.js`, `groups.js`).
- **Background checkpoint.** In a Bot's own chat the compaction summary is written in the background, and the owner's next message does not wait (`ds-bot/src/host/draft.js`, `parts.js`).
- **Fixes.** A model switch to a smaller window works (compaction headroom in `app/src/goal-patch.mjs`). A message stays in the chat when a switch fails. Long owner messages sent during a group round stay. A checkpoint no longer lists messages that stay after it.

Not fully reviewed (`697bb570..4945e052`, pushed together with this notice):

- **Code mode.** A per-Bot switch that gives a Bot's own chat DSH's `run_code` (preset `bot-code`, `ds-bot/src/host/roster.js`). It had one live check, which passed all its rules, and one security review, which asked for fixes. The fixes are in, but their second review and live check did not run. Do not ship code mode before they do.

## Known limits at the stop

- At an 80,000-token window every checkpoint is blocking: the next message waits for the summary.
- A model switch still fails when the model's window minus its maximum output is 19,504 tokens or less.
- The first checkpoint of a new Bot in a small window sends its summary request two times.
- Code mode adds about 7,000 tokens to each request.
- App tests `main-close-card` (2) fail and `main-room-left` hangs. They fail without the fork's changes too.

## To run it again

1. In `ds-bot/`, run `npm ci`, then `npm run harness`.
2. Run the tests from `ds-bot/`: `node --import ./test/harness-resolve.mjs --test --test-timeout=120000 "test/*.test.js"`. The last full run, at `4945e052`, gave 2,357 tests: 2,354 pass, 0 fail, 3 skipped.
