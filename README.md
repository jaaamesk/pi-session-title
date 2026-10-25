# pi-session-title

Names Pi sessions automatically.

Pi's resume picker (`pi --resume`) shows `session.name ?? session.firstMessage`, so without a name you only ever see the raw first prompt. This extension generates a short descriptive title for that name, using the model the session is already using — no second model to configure, no extra API credentials.

## Install

```sh
pi install git:github.com/jaaamesk/pi-session-title
```

Or load it for a single run without installing:

```sh
pi -e git:github.com/jaaamesk/pi-session-title
```

## How it works

| Situation | Result |
| --- | --- |
| New session, first turn finishes | A title is generated from the first user prompt and set as the session name |
| Session already has a name (`/name`, the picker, `--name`, or a previous title) | Left alone |
| Resumed or continuing session | Left alone |
| Second or later turn | Nothing happens |
| Title call fails (no auth, offline, timeout, empty output) | Nothing happens; Pi's first-message fallback stays |
| `/retitle [hint]` | Always overwrites the name with a freshly generated title |

The title is requested **after the first turn completes**, so it never competes with the first run for a provider connection. The nested call uses the session's current model, the lowest reasoning effort the API allows, and a 15 second own timeout.

## `/retitle`

```
/retitle
/retitle emphasize the migration risk
```

Regenerates the title from the original request plus the tail of the recent conversation. An optional hint tells the generator what the title should emphasize. Unlike the automatic path, this always overwrites the existing name, and it reports the result (or a warning on failure) through a notification.

## Limitations

- **Terminal title is not refreshed.** Setting the name through `pi.setSessionName()` does not update the terminal window title, unlike the built-in `/name` command. See [earendil-works/pi#3686](https://github.com/earendil-works/pi/issues/3686).
- **Token usage of the title call is not attributable to the session.** In Pi 1.3.0 an extension's `ctx.sessionManager` exposes no `appendUsage`, so the extra request's cost is invisible in session statistics.
- **Sessions that already have a name are never retitled automatically.** Use `/retitle` when you want a new one.
- Titles are capped at 100 characters by this extension (Pi has no cap of its own); the prompt asks the model for 50.

## Development

Typecheck only — the package has no build step, Pi loads `index.ts` directly:

```sh
tsc --noEmit -p tsconfig.json
```

`tsconfig.json` maps the host-provided `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` specifiers to the globally installed Pi package so the check resolves without a local `node_modules`.

## License

MIT — see [LICENSE](LICENSE).
