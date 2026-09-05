# CalendarEventCreator

A Hebrew family calendar app: paste a WhatsApp message, forward a photo, or
share a scanned PDF, and it becomes events in a shared Google Calendar.

It reads a whole training timetable out of one paragraph, understands "יום שני
הקרוב" and "כל השבוע של 29/11", writes weekly series, updates an event that
already exists, cancels one, and colours each person's events so a shared board
can be read at a glance.

## How it is put together

**The app** is a PWA — `index.html`, `sw.js` and `manifest.webmanifest`, served
as static files from GitHub Pages. It installs to a home screen, works offline,
and receives shares from other Android apps. There is one copy of it, and
everyone uses it.

**The backend** is a Google Apps Script Web App, one per household. It holds the
Anthropic API key, calls the model, and writes to that household's calendar.
`calendar-backend.gs` here is the same file for everyone: names, colours, venues
and title templates all live in Script Properties, so no family's details are in
this repository.

The two meet at one address, which each device stores locally — so the same page
serves every household while each writes only to its own calendar.

## Running your own

See [SETUP.md](SETUP.md). You need a Google account, a calendar, and an
Anthropic API key of your own.

## Versions

Three counters, and each proves a different thing:

- `BACKEND_VERSION` in `calendar-backend.gs` — shown in the app header as `· vN`.
  Which backend is actually deployed.
- `APP_VERSION` in `index.html` — shown in settings.
- `CACHE_VERSION` in `sw.js` — moves with `APP_VERSION`, or phones keep serving
  the old shell.
