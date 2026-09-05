# Setting up your own copy

The app itself is shared: one page, served from GitHub Pages, that everyone
uses. What you set up is the **backend** — an Apps Script deployment that holds
your API key and writes to *your* calendar. Nobody else can reach it, and you
cannot reach anybody else's.

Roughly fifteen minutes, most of it waiting for Google's permission screens.

## What you need

- A Google account, and a calendar you want events written into
- An [Anthropic API key](https://console.anthropic.com/) — reading a message
  costs a fraction of a cent, and it is billed to whoever's key is in the
  script, so this one needs to be yours

## 1. Create the script

1. Go to [script.google.com](https://script.google.com/) → **New project**
2. Delete the `myFunction` stub
3. Paste the whole of [`calendar-backend.gs`](calendar-backend.gs) from this
   repository, and save

## 2. Tell it who you are

**Project Settings** → **Script properties**. Three are required:

| Property | Value |
|---|---|
| `ANTHROPIC_KEY` | your API key |
| `SHARED_SECRET` | any random string — it is the only thing standing between your calendar and the open internet, so make it long |
| `CALENDAR_ID` | the calendar to write into (Calendar → Settings → the calendar → *Integrate calendar* → Calendar ID). Your own is your email address |

Four more are optional. Without them the app still works; it just reads *your*
family's shorthand no better than a stranger would. All are JSON except
`TEMPLATES`:

| Property | Example |
|---|---|
| `PEOPLE` | `["דנה","איתי","נועה"]` — offered as buttons on the confirm screen |
| `PERSON_COLOR` | `{"דנה":"YELLOW","איתי":"PALE_RED"}` — one colour each, so the shared board is readable at a glance |
| `VENUES` | `["מגרש הדשא","אולם הספורט"]` — the real names of places, so a photographed schedule is matched to them rather than transcribed letter by letter |
| `TEMPLATES` | free text; `{VENUES}` is replaced by the list above |

Colour names come from `CalendarApp.EventColor`: `PALE_BLUE` (Lavender),
`PALE_GREEN` (Sage), `MAUVE` (Grape), `PALE_RED` (Flamingo), `YELLOW` (Banana),
`ORANGE` (Tangerine), `CYAN` (Peacock), `GRAY` (Graphite), `BLUE` (Blueberry),
`GREEN` (Basil), `RED` (Tomato).

A `TEMPLATES` value looks like this:

```
- אימון כדורגל: "[שם] - אימון ([מגרש])"
  מגרשים אפשריים: {VENUES}
- תור רפואי: "[שם] - [סוג תור]"
```

## 3. Check it before deploying

Run `testSetup` from the editor (you will be asked to grant calendar and
external-request permissions the first time). It prints which properties are
set, the name of the calendar it reached, and the result of parsing a few
sample messages. Anything reported as `MISSING — required` will stop the app
working.

## 4. Deploy

**Deploy** → **New deployment** → type **Web app**.

- **Execute as:** Me
- **Who has access:** **Anyone**

That second one sounds alarming and is not: "anyone" may send a request, but
every request is rejected unless it carries your `SHARED_SECRET`. The app needs
this because it calls the script from a browser page rather than from a signed-in
Google session.

Copy the **Web app URL**. It ends in `/exec` — that exact URL is what the app
wants. The `/dev` one only ever answers to you, and will not work.

## 5. Point the app at it

Open the shared app URL, and on the setup screen enter:

- **כתובת השרת** — the `/exec` URL from the step above
- **סיסמה משותפת** — the `SHARED_SECRET` you chose
- **שם תצוגה** — your name, which appears as the creator of events

Press **התחברות ובדיקה**. It should report the name of your calendar and the
backend version. All three are stored on that device only — each phone in the
household enters them once.

Then install it: Chrome's menu → **Add to Home screen**. It opens without
browser chrome, works offline, and appears in the Android share sheet so a
message or a photo can be sent to it straight from WhatsApp.

## Updates

**The app updates itself.** Everyone loads the same page, so a change pushed to
this repository reaches every household. On a phone it arrives through the
service worker: settings → **בדיקת עדכון**, or close the app fully and reopen it
twice. Give it ten minutes after a push — GitHub's CDN serves the old worker for
up to that long, and the update check will tell you plainly when that is what is
happening.

**The backend does not.** It lives in your Apps Script project, so when
`calendar-backend.gs` changes here, pull and re-paste it, then **Deploy** →
**Manage deployments** → edit the existing one → **New version**. Editing the
existing deployment keeps your URL; creating a *new* deployment gives you a new
URL and the app will stop reaching you.

The header shows `· vN` — the backend version actually running. The app version
is in settings. If a change does not seem to have landed, those two numbers say
which half is behind.

## If something goes wrong

| What you see | Usually means |
|---|---|
| `אין תקשורת עם השרת` | the URL is wrong, the deployment is not set to *Anyone*, or the script is failing to load — open the `/exec` URL in a browser and read the error |
| `הסיסמה המשותפת שגויה` | `SHARED_SECRET` does not match what the app has |
| `תשובה לא תקינה מהשרת` | the URL points at something that is not this script |
| Events land in the wrong calendar | `CALENDAR_ID` — check it in `testSetup`'s output |
| Names appear with no colour | the name is in `PERSON_COLOR` but not in `PEOPLE`, so no button ever writes it into a title. `testSetup` flags this |
