/**
 * Family Calendar backend  —  Google Apps Script
 * Deploy as: Web app  |  Execute as: Me  |  Who has access: Anyone
 *
 * Script Properties required (Project Settings > Script Properties):
 *   ANTHROPIC_KEY   your Anthropic API key
 *   SHARED_SECRET   any random string; the app sends it with every request
 *   CALENDAR_ID     the ID of the ONE board events are written to
 */

const PROPS = PropertiesService.getScriptProperties();
const TZ = 'Asia/Jerusalem';
/* Reading a photograph is where the model tiers actually separate: Haiku 4.5
 * misread a photographed training schedule that Sonnet 5 got right, so photos
 * go to the stronger model. Typed text stays on Haiku, which handles it well
 * and keeps the common path fast — that is the path used many times a day.
 * To put everything on Sonnet 5, point both constants at it. */
const MODEL_TEXT  = 'claude-haiku-4-5-20251001';
const MODEL_IMAGE = 'claude-sonnet-5';

const HE_DAYS = ['יום ראשון','יום שני','יום שלישי','יום רביעי','יום חמישי','יום שישי','שבת'];

// ---------- per-deployment configuration ----------
/* None of this lives in the code. Every family running this app has its own
 * Apps Script deployment and its own calendar, and this file is identical for
 * all of them — which is what lets it sit in a public repository without ever
 * holding anyone's children's names.
 *
 * Set these in Project Settings > Script Properties. All four are optional:
 * without them the app still reads messages and writes events, it just loses
 * the hints that make it good at one particular family's shorthand.
 * testSetup() reports what is missing, and SETUP.md walks through it.
 *
 *   PEOPLE        ["דנה","איתי","נועה"]
 *   PERSON_COLOR  {"דנה":"YELLOW","איתי":"PALE_RED"}
 *   VENUES        ["מגרש הדשא","אולם הספורט"]
 *   TEMPLATES     free text; {VENUES} is replaced by the list above
 */
function cfgJson(name, fallback) {
  const raw = PROPS.getProperty(name);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    /* A typo in a property earns a loud failure. Falling back quietly would
       mean a whole season written in the wrong colour before anyone noticed. */
    throw new Error('Script Property ' + name + ' is not valid JSON: ' + err);
  }
}

/** Names offered as buttons on the confirm screen. They travel only in the
 *  reply to `ping`, which is behind the shared secret. */
function people() { return cfgJson('PEOPLE', []); }

/* One colour per person, so a shared board can be read at a glance — whose
 * week is whose, without reading a single title. Keyed by the same names the
 * app offers as buttons, and matched against the "[name] - " prefix those
 * buttons write into the title.
 *
 * Values are the constant names from CalendarApp.EventColor. The eleven
 * available are PALE_BLUE (Lavender), PALE_GREEN (Sage), MAUVE (Grape),
 * PALE_RED (Flamingo), YELLOW (Banana), ORANGE (Tangerine), CYAN (Peacock),
 * GRAY (Graphite), BLUE (Blueberry), GREEN (Basil), RED (Tomato).
 *
 * An event with nobody's name — אסיפת הורים, a family meal — is left alone and
 * keeps the board's own colour, which reads as "this one is everyone's". */
function personColor() { return cfgJson('PERSON_COLOR', {}); }

/* The places events actually happen. A photographed schedule is where a proper
 * noun comes back as a near-miss — the letters are read one at a time with
 * nothing to check them against — so the model is given the real list and told
 * to land on it rather than transcribe what the pixels seemed to say. */
function venues() { return cfgJson('VENUES', []); }

/** Title patterns for the events this family actually has. {VENUES} is
 *  replaced by the venue list, so the two stay in step. */
function templates() {
  return String(PROPS.getProperty('TEMPLATES') || '')
    .replace('{VENUES}', venues().join(' / '));
}

// ---------- entry point ----------
function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);

    if (req.secret !== PROPS.getProperty('SHARED_SECRET')) {
      return json({ ok: false, error: 'unauthorized' });
    }

    switch (req.action) {
      /* "file" since a scan can be a PDF; "image" is what an older app sends */
      case 'parse':  return json(parseText(req.text, req.file || req.image, req.history));
      case 'amend':  return json(amendEvent(req.event, req.text, req.history, req.source));
      case 'day':    return json(dayEvents(req.date));
      case 'create': return json(createEvent(req.event, req.user));
      case 'update': return json(updateEvent(req.id, req.scope, req.event, req.user));
      case 'delete': return json(deleteEvent(req.id, req.scope));
      case 'colors': return json(colorSetting(req.colors));
      case 'ping':   return json({
        ok: true,
        calendar: calendar().getName(),
        version: BACKEND_VERSION,
        people: people(),
        colors: personColor()
      });
      default:       return json({ ok: false, error: 'unknown action' });
    }
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

/* Bump on every deploy. `ping` reports it, so the app can prove which build is
 * actually live instead of guessing from behaviour. */
const BACKEND_VERSION = 38;

/* A term's timetable is a long list, so the ceiling is high. It is still a
 * ceiling: past this the message is more likely to have been misread than to
 * really hold that many events. Whatever is over it is reported rather than
 * dropped quietly — someone handing over a schedule expects all of it. */
const MAX_EVENTS = 30;

/* A weekly series is written once and then belongs to everyone looking at the
 * board. Two years is longer than any season, and short enough that a slip of
 * the finger in the year field cannot bury the calendar. */
const MAX_SERIES_DAYS = 730;

/* How far recolorExisting() reaches. Back far enough to cover the season just
 * gone, forward far enough to cover a series already written. */
const RECOLOR_BACK  = 180;
const RECOLOR_AHEAD = 400;

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* Which colour belongs to whom is a fact about the calendar, not about a
 * phone: an event written from one device has to come out the same colour as
 * one written from another, or the board stops being readable at a glance.
 * So the app edits it here rather than keeping its own copy, and every device
 * picks the change up on its next ping.
 *
 * Behind the shared secret, like everything else — anyone holding it can
 * already write events into this calendar, so colouring them is no wider a
 * power than they had.
 *
 * @param {?Object} next name -> EventColor constant name. Omitted to read.
 */
function colorSetting(next) {
  if (next === undefined || next === null) return { ok: true, colors: personColor() };
  if (typeof next !== 'object' || Array.isArray(next)) {
    return { ok: false, error: 'colors must be an object' };
  }

  const clean = {};
  for (const name in next) {
    const who = String(name).trim();
    const color = String(next[name] || '').trim();
    if (!who || !color) continue;          // dropped entirely = back to no colour

    /* An unknown constant would be stored happily and then silently fail at
       every write, which is the kind of fault that is noticed a season late. */
    if (!CalendarApp.EventColor[color]) {
      return { ok: false, error: 'unknown colour: ' + color };
    }
    clean[who] = color;
  }

  PROPS.setProperty('PERSON_COLOR', JSON.stringify(clean));
  return { ok: true, colors: clean };
}

function calendar() {
  const cal = CalendarApp.getCalendarById(PROPS.getProperty('CALENDAR_ID'));
  if (!cal) throw new Error('calendar not found or not editable');
  return cal;
}

// ---------- step 1: free text and/or image -> structured event ----------
/* What an event is made of. Repetition is deliberately not part of this set:
 * it is a property of the series rather than of the occurrence, and the app
 * keeps it under the user's own hand. See AMEND_TOOL. */
const BASE_FIELDS = {
  title:      { type: 'string' },
  date:       { type: 'string', description: 'yyyy-MM-dd' },
  bareWeekday:{ type: 'string',
                description: 'שם היום שנאמר בלי תאריך מפורש ובלי המילה מחר, למשל "רביעי". ריק אחרת' },
  bareYear:   { type: 'boolean',
                description: 'true כאשר נאמרו יום וחודש בלי שנה, למשל "29/11"' },
  allDay:     { type: 'boolean',
                description: 'true כשהאירוע נמשך יום שלם או כמה ימים ולא נמסרו שעות' },
  endDate:    { type: 'string',
                description: 'yyyy-MM-dd — היום האחרון של אירוע רב-יומי, כולל. ריק ליום אחד' },
  wholeWeek:  { type: 'boolean',
                description: 'true כשההודעה אומרת שבוע שלם, למשל "כל השבוע של 29/11"' },
  start:      { type: 'string', description: 'HH:mm בשעון 24' },
  end:        { type: 'string', description: 'HH:mm בשעון 24. ריק כאשר לא נמסרה שעת סיום' },
  location:   { type: 'string' },
  needsEnd:   { type: 'boolean' },
  needsTitle: { type: 'boolean' },
  needsLocation: { type: 'boolean',
                description: 'true כשהמיקום נקרא מתמונה ואינו שם מוכר — כלומר עלול להיות משובש' },
  note:       { type: 'string' }
};

const EVENT_FIELDS = Object.assign({}, BASE_FIELDS, {
  repeat:     { type: 'string', enum: ['none', 'weekly'],
                description: 'weekly כאשר ההודעה אומרת שהאירוע חוזר כל שבוע. ברירת המחדל none' },
  repeatUntil:{ type: 'string',
                description: 'yyyy-MM-dd — היום האחרון של הסדרה, רק כשנאמר עד מתי. ריק אחרת' }
});

/**
 * The model is given exactly one tool and forced to call it, so it cannot
 * answer in prose. Before this, a chatty reply ("I need more information…")
 * reached JSON.parse and crashed the whole request; now "I need more
 * information" is a first-class outcome — status:'question'.
 *
 * One message can describe several events — a weekly training schedule is the
 * ordinary case — so `events` is an array. That is the one piece of nesting
 * here: everything inside an event is still a flat scalar, because nested
 * objects and nullable types are where hand-written schemas start disagreeing
 * with the model. Everything that describes the message as a whole (status,
 * intent, the edit target) stays at the top level, where it belongs.
 */
const EVENT_TOOL = {
  name: 'submit',
  description: 'מחזיר את כל האירועים שבהודעה, או שאלת הבהרה אחת כאשר חסר מידע קריטי.',
  input_schema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['event', 'question'],
        description: 'question רק כשאי אפשר לבנות אף אירוע בלי תשובה נוספת'
      },
      question: {
        type: 'string',
        description: 'שאלה אחת קצרה בעברית. ריק כאשר status=event'
      },
      intent:     { type: 'string', enum: ['create', 'update', 'delete'] },
      findText:   { type: 'string', description: 'מילות זיהוי של האירוע הקיים, כאשר intent=update או intent=delete' },
      findDate:   { type: 'string', description: 'התאריך שבו האירוע קיים כרגע לפני השינוי, בפורמט yyyy-MM-dd' },
      events: {
        type: 'array',
        description: 'אירוע אחד לכל מופע בהודעה, מסודרים מהמוקדם למאוחר. ריק כאשר status=question',
        items: {
          type: 'object',
          properties: EVENT_FIELDS,
          required: ['title', 'date', 'start']
        }
      }
    },
    required: ['status']
  }
};

/* Shared between `parse` and `amend`. A correction that read dates by
 * different rules than the parse it is correcting would be its own bug. */
function DATE_RULES() {
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const year  = Number(today.slice(0, 4));
  const weekday = HE_DAYS[new Date(
    Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd')
  ).getDay()];

  /* Sunday of the week we are in. Handing the model the actual dates of this
     week and the next is the whole point: every date bug so far has come from
     asking it to do calendar arithmetic, and "לשבוע הבא" on top of "the next
     occurrence of Sunday" quietly shifted a whole schedule a week late. */
  const sunday = plusDays(today, -new Date(
    Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd')
  ).getDay());

  return [
    'כללי תאריך:',
    '- היום הוא ' + today + ' (' + weekday + ').',
    '- שבוע מתחיל ביום ראשון ומסתיים בשבת.',
    weekLine('השבוע הזה', sunday),
    weekLine('השבוע הבא', plusDays(sunday, 7)),
    nextEachDay(today, new Date(
      Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd')
    ).getDay()),
    '- קח תאריכים מהטבלאות האלה. אל תחשב אותם בעצמך.',
    '- "הקרוב" או "הזה" אחרי שם יום — אותה משמעות בדיוק: היום הקרוב שיגיע.',
    '  "בשישי הקרוב", "בשישי הזה", "ביום שני הזה" = בדיוק השורה',
    '  "המופע הקרוב הבא". אל תוסיף עליה שבוע.',
    '  אבל "השבוע הזה" הוא חלון שבוע ולא יום — ראה את הכלל הבא.',
    '- ביטוי שחל על כל ההודעה קובע את חלון השבוע של כל הימים שמופיעים אחריו.',
    '  קרא אותו פעם אחת, קח את התאריכים מהשורה שלו, ואל תוסיף עליהם עוד שבוע:',
    '  "השבוע" או "השבוע הזה" = השורה "השבוע הזה", כלומר השבוע שמתנהל כרגע,',
    '    זה שהיום נמצא בתוכו. לא השבוע שאחריו.',
    '  "שבוע הבא" או "לשבוע הבא" = השורה "השבוע הבא".',
    '- כשיש חלון שבוע כזה, כל יום ברשימה נלקח מאותו חלון, גם אם הוא נופל מחר,',
    '  והשאר את bareWeekday ריק.',
    '- יום שכבר עבר עובר ליום המקביל בשבוע שאחרי החלון. אירוע נקבע קדימה ולא',
    '  אחורה, ולכן תאריך שנגזר משם של יום לעולם אינו לפני היום.',
    '  היום עצמו עדיין נחשב בתוך החלון, לא כיום שעבר.',
    '  דוגמה: היום יום רביעי, "השבוע ביום שני" = יום שני של השבוע הבא.',
    '- יום בשבוע בלי תאריך ובלי חלון שבוע = המופע הקרוב הבא של אותו יום,',
    '  אף פעם לא היום עצמו. אם היום שנאמר הוא היום הנוכחי, הכוונה לשבוע הבא.',
    '  במקרה הזה בלבד מלא גם bareWeekday בשם היום.',
    '  אם נאמר תאריך מפורש, או "מחר", או "היום" — השאר את bareWeekday ריק.',
    '- "מחר" = היום הבא.',
    '- רשימת ימים באותה הודעה שייכת לשבוע אחד, לא לימים מפוזרים על פני חודש.',
    '- שמות ימים מקוצרים או עם שגיאת כתיב ("יום חמיש", "יום ג") — פרש לפי',
    '  הכוונה הברורה, אל תשאל עליהם.',
    '- תאריך בלי שנה ("29/11") = המופע הקרוב הבא של אותו יום וחודש,',
    '  בדיוק כמו שם של יום שכבר עבר: אם התאריך עדיין לא עבר — שנת ' + year + ',',
    '  ואם כבר עבר — שנת ' + (year + 1) + '. היום עצמו נחשב כאילו לא עבר.',
    '  סמן bareYear=true בכל מקרה כזה, גם כשהשנה שבחרת היא הנוכחית.',
    '  כשנאמרה שנה מפורשת — השאר bareYear ריק וקח את השנה שנאמרה.',
    '- אירוע שנמשך יום שלם ולא נמסרו בו שעות — טיול, מחנה, חופשה, נסיעה,',
    '  יום ספורט, שבתון — סמן allDay=true והשאר start ו-end ריקים.',
    '- אירוע רב-יומי ("12-14/11", "מ-20/12 עד 24/12"): date = היום הראשון,',
    '  endDate = היום האחרון וכולל אותו. ליום אחד — השאר endDate ריק.',
    '- שעה מפורשת גוברת: אם נאמרה שעה, זה אינו אירוע של יום שלם.',
    '- "כל השבוע של 29/11", "כל השבוע הבא", "השבוע כולו" = שבוע שלם:',
    '  סמן wholeWeek=true וגם allDay=true, ותן ב-date יום כלשהו מאותו שבוע —',
    '  התאריך או היום שנאמר. אל תחשב בעצמך את תחילת השבוע ואת סופו:',
    '  האפליקציה מותחת את זה מיום ראשון עד שבת. השאר endDate ריק.',
    '- לפני שאתה מחזיר תאריך, מצא אותו בטבלה למעלה וודא שהיום בשבוע שלו הוא',
    '  באמת היום שנאמר. אם לא — התאריך שגוי, תקן אותו.'
  ];
}

/** "- השבוע הבא: יום ראשון 2026-08-30, יום שני 2026-08-31, …" */
function weekLine(label, sundayIso) {
  const days = [];
  for (let i = 0; i < 7; i++) days.push(HE_DAYS[i] + ' ' + plusDays(sundayIso, i));
  return '- ' + label + ': ' + days.join(', ') + '.';
}

/**
 * The answer to "which שישי" without any week to pick first. The two week rows
 * still leave a step — decide the row, then read it — and a Wednesday message
 * saying "בשישי הקרוב" came back a week late. This is the lookup itself.
 */
function nextEachDay(todayIso, todayDow) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    let ahead = (i - todayDow + 7) % 7;
    if (ahead === 0) ahead = 7;          // never today, same as the rule below
    days.push(HE_DAYS[i] + ' ' + plusDays(todayIso, ahead));
  }
  return '- המופע הקרוב הבא של כל יום (אף פעם לא היום עצמו): ' + days.join(', ') + '.';
}

/* Also shared between `parse` and `amend`. A bare hour is read literally and
 * never nudged into the afternoon: "3" is 03:00, not 15:00. The guess would be
 * right most of the time and silently wrong the rest, and a wrong hour looks
 * exactly as confident as a right one. Predictable beats clever here — anyone
 * who means the afternoon can say so, or fix it on the confirm screen. */
function TIME_RULES() {
  return [
    'כללי שעה:',
    '- כל השעות בפורמט HH:mm בשעון 24.',
    '- שעה שנאמרה בלי ציון חלק היום נקראת בדיוק כפי שנכתבה, בלי להזיז אותה:',
    '  "ב-3" = 03:00, "בשעה 8" = 08:00, "ב-4:30" = 04:30.',
    '- אל תניח אחר צהריים או ערב רק מפני שזה נראה סביר יותר לאירוע כזה.',
    '  זה נכון גם לאימונים, חוגים ומשחקים שבדרך כלל מתקיימים אחר הצהריים.',
    '- רק ציון מפורש מזיז את השעה: "בערב", "אחה"צ", "אחר הצהריים", "בלילה",',
    '  "בבוקר", PM/AM. "8 בערב" = 20:00, "3 אחה"צ" = 15:00, "8 בבוקר" = 08:00.',
    '- שעה שנכתבה כבר בשעון 24 ("15:00", "16:30") נשארת כפי שהיא.',
    '- טווח ("16:30 - 18:00") הוא שעת התחלה ושעת סיום של אותו אירוע.',
    '- בטווח, ציון חלק היום שנאמר בצד אחד חל גם על הצד השני:',
    '  "4:45 אחר הצהריים עד 6:00" = 16:45 עד 18:00, ולא עד 06:00.',
    '  "מ-8 בבוקר עד 10" = 08:00 עד 10:00.',
    '- שעת סיום שיוצאת מוקדמת משעת ההתחלה באותו טווח היא סימן שהפירוש שגוי.',
    '  קרא את הסיום באותו חלק יום כמו ההתחלה, אלא אם נאמר במפורש שהאירוע',
    '  נמשך אל תוך הלילה.'
  ];
}

function CONTENT_RULES() {
  return [
    'כללי תוכן:',
    '- תמיד החזר כותרת. לעולם אל תשאיר את title ריק.',
    '- אם הכותרת ודאית — סמן needsTitle=false.',
    '  אם היא ניחוש סביר — החזר אותה בכל זאת וסמן needsTitle=true.',
    '  המשתמש רואה כל כותרת ומאשר אותה לפני היצירה, ולכן הצעה עדיפה על שאלה.',
    '- הוסף שם של אדם לכותרת רק כשההודעה באמת מציינת אותו.',
    '  אחרת תאר את האירוע עצמו: "אסיפת הורים", "ארוחה משפחתית", "תור לרופא".',
    '- מילים שמתארות את ההודעה ולא את האירוע לא נכנסות לכותרת לעולם:',
    '  לוז, לו"ז, לו״ז, לוח זמנים, סדר יום, מערכת שעות, עדכון, תזכורת, הודעה.',
    '  הן כותרת של ההודעה, לא של מה שקורה ביומן.',
    '  "לוז אימונים לשבוע הבא" עם שורה של יום ראשון הוא אירוע בשם "אימון",',
    '  לא "לוז אימונים". קרא מהשורה של האירוע עצמו מה מתרחש בו.',
    /* Each of these is a hint about one family, and a deployment that has not
       been told about that family must not be handed an empty list to reason
       about — "the known venues are ." is worse than saying nothing. */
    ...(people().length
        ? ['- בני המשפחה, כשהם מוזכרים: ' + people().join(', ')] : []),
    ...(templates()
        ? ['- תבניות שמות מקובלות, כשהן מתאימות:' + templates()] : []),
    ...(venues().length ? [
      '- מיקום: המקומות המוכרים הם ' + venues().join(' / ') + '.',
      '  כשמה שנקרא דומה לאחד מהם — החזר את השם המדויק מהרשימה, גם אם בהודעה',
      '  או בתמונה הוא כתוב אחרת או עם שגיאת כתיב. שם מוכר עדיף על תעתיק מילולי.',
      '  זה חשוב במיוחד בתמונה: שם מקום מצולם חוזר עם אותיות מוחלפות,',
      '  ואין לתקן אותו לפי הצורה שנראתה אלא לפי הרשימה.',
      '  כשהמקום אינו אחד מהם — החזר אותו כפי שנאמר, בלי לכפות עליו שם מהרשימה.',
      '  אותו כלל חל על שם המקום בתוך הכותרת.'
    ] : []),
    '- כשהמיקום נקרא מתמונה ואינו אחד המקומות המוכרים — סמן needsLocation=true.',
    '  שם מקום לא מוכר שנקרא מצילום עלול לחזור עם אות מוחלפת, ואין ממה לוודא',
    '  אותו. סמן אותו כדי שהמשתמש יבדוק, במקום להחזיר ניחוש כאילו הוא ודאי.',
    '  מיקום שהוקלד כטקסט, או מגרש מוכר, אינו צריך את הסימון הזה.',
    '- location ו-note יכולים להיות ריקים.'
  ];
}

/**
 * @param {string}  text     free-form text (may be empty when an image is sent)
 * @param {Object=} file     { mediaType, data } — a photo, or a scanned PDF
 * @param {Array=}  history  prior [{role,content}] turns, oldest first
 */
function parseText(text, file, history) {
  const system = [
    'אתה מחלץ אירועים מטקסט חופשי בעברית או באנגלית.',
    'עליך תמיד לקרוא לכלי submit. אין להשיב בטקסט חופשי.',
    '',
    'כמה אירועים להחזיר:',
    '- הודעה אחת יכולה לתאר כמה אירועים, למשל לוח אימונים שבועי,',
    '  רשימת מפגשים בתאריכים שונים, או כמה שורות בהודעה אחת.',
    '  כל יום או תאריך עם שעה משלו הוא אירוע נפרד ברשימה.',
    '- כשההודעה מתארת אירוע אחד בלבד, החזר רשימה עם אירוע אחד. זה המצב הרגיל.',
    '- סדר את הרשימה לפי תאריך ושעה, מהמוקדם למאוחר.',
    '- לוח שבועי = מופע אחד לכל יום שנאמר, בשבוע הקרוב בלבד.',
    '  אל תשכפל את אותו אירוע לשבועות קדימה — לעולם.',
    '- כשנאמר שהאירוע חוזר ("כל שבוע", "כל יום ראשון", "מדי שבוע", "קבוע") —',
    '  סמן repeat="weekly" על אותו אירוע. זה יוצר סדרה שבועית אחת ביומן,',
    '  ולכן עדיין מופע אחד ברשימה ולא כמה.',
    '- אם נאמר עד מתי ("עד סוף העונה", "עד דצמבר", "לחודשיים") מלא גם repeatUntil.',
    '  אם לא נאמר — השאר את repeatUntil ריק; המשתמש יבחר את תאריך הסיום.',
    '- אל תמציא אירוע שלא נאמר, ואל תפצל אירוע אחד לשניים.',
    '- כאשר intent="update" החזר אירוע אחד בלבד.',
    '- פרטים משותפים שנאמרו פעם אחת (מיקום, שם, סוג האימון) חלים על כל',
    '  האירועים ברשימה. מלא אותם בכל אירוע, אל תשאיר אותם רק בראשון.',
    '',
    'מתי לשאול שאלה (status="question"):',
    '- כמעט אף פעם. רק כאשר אי אפשר לקבוע תאריך או שעת התחלה,',
    '  או כשיש סתירה ממשית בהודעה.',
    '- שאלה אחת בלבד בכל פעם, קצרה, בעברית.',
    '- אל תשאל על שעת סיום חסרה — החזר status="event" עם end ריק ו-needsEnd=true.',
    '- אל תשאל לעולם למי האירוע או לאיזה ילד הוא שייך. לא כל אירוע קשור לילד:',
    '  יש אירועים של ההורים, של כל המשפחה, או של אף אחד מסוים.',
    '  כשלא ברור למי האירוע — הצע כותרת בלי שם וסמן needsTitle=true.',
    '- אל תשאל על פרט שאפשר להסיק מההקשר או מהתבניות למטה.',
    '- אל תשאל לעולם באיזה אירוע קיים מדובר, או איזה מהם לעדכן. אינך רואה',
    '  את היומן; החיפוש נעשה אחריך. החזר intent="update" עם findText, והאפליקציה',
    '  תמצא את האירוע ותציג למשתמש את ההתאמות אם יש יותר מאחת.',
    '- כשחלק מהאירועים ברורים וחלק לא — אל תשאל. החזר את הברורים,',
    '  והשמט את מה שאי אפשר לתארך או לתזמן.',
    '',
    'כללי intent:',
    '- intent="update" רק אם ההודעה מתייחסת לאירוע שכבר קיים ביומן: שינוי שעה,',
    '  דחייה, הקדמה, העברה למגרש אחר, ביטול והחלפה. מילים אופייניות: הועבר, נדחה,',
    '  הוקדם, שונה, במקום, עבר ל, לא ב... אלא ב...',
    '- intent="delete" כאשר ההודעה אומרת שאירוע קיים מבוטל ואין לו תחליף:',
    '  בוטל, מבוטל, לא מתקיים, אין אימון, לא יהיה אימון.',
    '- ביטול שיש לו תחליף — "האימון בוטל, במקוםו אימון בחמישי" — הוא',
    '  intent="update" ולא delete: האירוע עובר, לא נעלם.',
    '- בכל מקרה אחר intent="create", כולל הודעה שמתארת אירוע חדש לגמרי.',
    '- שדות האירוע תמיד מתארים את המצב הסופי הרצוי, לא את השינוי בלבד.',
    '- כאשר intent="update" או intent="delete" מלא גם findText, ו-findDate אם ידוע.',
    '',
    ...DATE_RULES(),
    '',
    ...TIME_RULES(),
    '',
    ...CONTENT_RULES(),
    '',
    'אם צורף קובץ — תמונה או מסמך סרוק — קרא ממנו את הטקסט (צילום מסך של הודעה,',
    'לוח אימונים, טופס, פתק או סריקה) והתייחס אליו כאילו הוקלד. אם יש בו כמה',
    'אירועים, החזר את כולם, בדיוק לפי אותם כללים שחלים על טקסט.',
    'בסריקה של כמה עמודים — עבור על כולם, לא רק על הראשון.',
    '',
    'בשיחה מתמשכת: השתמש בכל מה שנאמר קודם. אל תחזור על שאלה שכבר נענתה.'
  ].join('\n');

  // Earlier turns arrive as plain strings; only the current turn can carry an image.
  const messages = [];
  if (Array.isArray(history)) {
    for (const turn of history) {
      if (!turn || !turn.content) continue;
      if (turn.role !== 'user' && turn.role !== 'assistant') continue;
      messages.push({ role: turn.role, content: String(turn.content) });
    }
  }

  const content = [];
  /* A scan arrives as a PDF, which the API takes as a document block rather
     than an image one — same request, different wrapper. Anything else is
     treated as a picture. */
  if (file && file.data) {
    const pdf = String(file.mediaType || '') === 'application/pdf';
    content.push(pdf
      ? { type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: file.data } }
      : { type: 'image',
          source: { type: 'base64', media_type: file.mediaType || 'image/jpeg', data: file.data } });
  }
  content.push({ type: 'text', text: text || 'חלץ את האירועים מהקובץ המצורף.' });
  messages.push({ role: 'user', content: content });

  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': PROPS.getProperty('ANTHROPIC_KEY'),
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify({
      model: (file && file.data) ? MODEL_IMAGE : MODEL_TEXT,
      /* A full weekly schedule is many events long, and Sonnet 5 thinks before
         it answers — that reasoning counts against this ceiling too. */
      /* Thirty events of JSON plus the reasoning that precedes them. Running
         out here does not fail loudly — it returns a shorter list — so there
         is room to spare and `overflow` reports it if it happens anyway. */
      max_tokens: 24000,
      system: system,
      messages: messages,
      tools: [EVENT_TOOL],
      tool_choice: { type: 'tool', name: 'submit' }
    }),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    return { ok: false, error: 'model error: ' + res.getContentText().slice(0, 300) };
  }

  const body = JSON.parse(res.getContentText());
  const call = (body.content || []).filter(function (b) { return b.type === 'tool_use'; })[0];

  // tool_choice makes this near-impossible, but a missing call must not throw.
  if (!call || !call.input) {
    return { ok: false, error: 'לא הצלחתי לקרוא את ההודעה. נסו לנסח אותה אחרת.' };
  }

  const out = call.input;

  if (out.status === 'question' && out.question) {
    return { ok: true, status: 'question', question: String(out.question) };
  }

  const parsed = (Array.isArray(out.events) ? out.events : [])
    .filter(function (raw) { return raw && typeof raw === 'object'; })
    .map(toEvent);

  /* One unusable event is still worth showing — the form lets the user fill in
     what the message left out. Several, and the undated ones are noise between
     the real ones, so they are dropped rather than queued. */
  const usable = parsed.length > 1
    ? parsed.filter(function (e) { return e.date && e.start; })
    : parsed;
  const events = usable.slice(0, MAX_EVENTS);

  /* Deletion is settled before anything below, and the order is the point.
     A cancellation has nothing to create, so the model rightly returns no
     events for it — which the empty-events guard would reject — and it is
     not an update, which the create branch below treats as everything else.
     Both of those swallowed it silently.

     Nothing is created here and nothing is editable: the reply carries the
     calendar's own event and the app asks one yes-or-no question. Falling
     back to create, the way an unmatched update does, would answer "cancel
     the training" by adding a training. */
  if (out.intent === 'delete') {
    const target = findCandidates(
      { text: out.findText || '', date: out.findDate || null }, events[0] || {});
    if (!target.list.length) {
      return { ok: true, status: 'nomatch', intent: 'delete', matching: target.report };
    }
    return {
      ok: true,
      status: 'event',
      intent: 'delete',
      match: target.list[0],
      alternatives: target.list.slice(1),
      matching: target.report
    };
  }

  if (!events.length) {
    return { ok: false, error: 'לא זיהיתי אירוע בהודעה. נסו לנסח אותה אחרת.' };
  }

  /* Two ways the list can come back short of what was really there, and the
     app is told about both. Silence would be the worst answer: someone handing
     over a whole timetable has no way of noticing that four of it are missing.

     `cap` — more events were read than we are willing to queue at once.
     `cut`  — the model ran out of room mid-answer, so its own list is
              unfinished. stop_reason is the only sign of that; the tool call
              still arrives, just with fewer events in it. */
  const overflow = usable.length > MAX_EVENTS ? 'cap'
                 : body.stop_reason === 'max_tokens' ? 'cut'
                 : '';

  /* An edit always refers to one existing event; the extra readings, if the
     model offered any, would each rewrite the same calendar entry. */
  if (out.intent !== 'update') {
    return {
      ok: true,
      status: 'event',
      intent: 'create',
      events: events,
      found: usable.length,          // how many were read, before any ceiling
      overflow: overflow || undefined,
      /* An app built before batches reads `event` and ignores `events`, and so
         creates the first one — the old behaviour, not a crash. */
      event: events[0],
      ambiguousDay: events[0].ambiguousDay || undefined
    };
  }

  const ev = events[0];
  const found = findCandidates({ text: out.findText || '', date: out.findDate || null }, ev);
  if (!found.list.length) {
    // an update with nothing to update would be a lie — fall back to create
    ev.note = [ev.note, 'לא נמצא ביומן אירוע קיים שמתאים לעדכון — ייווצר אירוע חדש.']
      .filter(String).join(' ');
    return { ok: true, status: 'event', intent: 'create', events: [ev], event: ev,
             matching: found.report };
  }

  return {
    ok: true,
    status: 'event',
    intent: 'update',
    events: [ev],
    event: ev,
    match: found.list[0],
    alternatives: found.list.slice(1),
    matching: found.report,
    ambiguousDay: ev.ambiguousDay || undefined
  };
}

// ---------- step 1b: "no, that one is next week" -> corrected event ----------
/**
 * The confirm screen has editable fields, but some corrections are far easier
 * to say than to type — "זה בשבוע הבא", "ראשון זה ה-6.9". This takes the event
 * as it currently stands on screen plus one sentence, and returns the whole
 * event again with the correction applied.
 *
 * Repetition is not in this tool's schema: the chips on the confirm screen own
 * that, and a model that quietly dropped repeat="weekly" while fixing a date
 * would be an unpleasant surprise. amendEvent carries it across untouched.
 */
const AMEND_TOOL = {
  name: 'submit',
  description: 'מחזיר את האירוע המתוקן במלואו, או שאלת הבהרה אחת.',
  input_schema: {
    type: 'object',
    properties: Object.assign({
      status: {
        type: 'string',
        enum: ['event', 'question'],
        description: 'question רק כשאי אפשר להבין את התיקון'
      },
      question: {
        type: 'string',
        description: 'שאלה אחת קצרה בעברית. ריק כאשר status=event'
      }
    }, BASE_FIELDS),
    required: ['status']
  }
};

/**
 * @param {Object}  current  the event as the confirm screen currently shows it
 * @param {string}  text     one sentence of correction
 * @param {Array=}  history  prior [{role,content}] turns of this correction
 * @param {string=} source   the original message, for context the fields lost
 */
function amendEvent(current, text, history, source) {
  if (!current || typeof current !== 'object') return { ok: false, error: 'missing event' };
  if (!String(text || '').trim())              return { ok: false, error: 'missing correction' };

  const system = [
    'אתה מתקן אירוע יחיד לפי הערה של המשתמש.',
    'עליך תמיד לקרוא לכלי submit. אין להשיב בטקסט חופשי.',
    '',
    'כללי תיקון:',
    '- החזר תמיד את כל שדות האירוע במצבם הסופי, לא רק את מה שהשתנה.',
    '- שנה רק את מה שההערה נוגעת בו. כל שאר השדות נשארים בדיוק כפי שהם.',
    '- ההערה מתייחסת לאירוע שמוצג למטה, לא להודעה המקורית כולה.',
    '- אם ההערה מתקנת תאריך, חשב אותו מחדש מהיסוד לפי כללי התאריך.',
    '- status="question" רק כשההערה באמת לא מובנת. אחרת תקן והחזר אירוע.',
    '',
    ...DATE_RULES(),
    '',
    ...TIME_RULES(),
    '',
    ...CONTENT_RULES()
  ].join('\n');

  const messages = [];
  if (Array.isArray(history)) {
    for (const turn of history) {
      if (!turn || !turn.content) continue;
      if (turn.role !== 'user' && turn.role !== 'assistant') continue;
      messages.push({ role: turn.role, content: String(turn.content) });
    }
  }

  const shown = [
    'האירוע כפי שהוא מוצג עכשיו:',
    'כותרת: '     + (current.title    || ''),
    'תאריך: '     + (current.date     || ''),
    'שעת התחלה: ' + (current.start    || ''),
    'שעת סיום: '  + (current.end      || ''),
    'מיקום: '     + (current.location || '')
  ];
  if (String(source || '').trim()) {
    shown.push('', 'ההודעה המקורית שממנה נוצר: ' + String(source).trim());
  }
  shown.push('', 'ההערה של המשתמש: ' + String(text).trim());

  messages.push({ role: 'user', content: [{ type: 'text', text: shown.join('\n') }] });

  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': PROPS.getProperty('ANTHROPIC_KEY'),
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify({
      model: MODEL_TEXT,          // a correction is always typed, never a photo
      max_tokens: 1000,
      system: system,
      messages: messages,
      tools: [AMEND_TOOL],
      tool_choice: { type: 'tool', name: 'submit' }
    }),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    return { ok: false, error: 'model error: ' + res.getContentText().slice(0, 300) };
  }

  const body = JSON.parse(res.getContentText());
  const call = (body.content || []).filter(function (b) { return b.type === 'tool_use'; })[0];
  if (!call || !call.input) {
    return { ok: false, error: 'לא הצלחתי לקרוא את התיקון. נסו לנסח אותו אחרת.' };
  }

  const out = call.input;
  if (out.status === 'question' && out.question) {
    return { ok: true, status: 'question', question: String(out.question) };
  }

  const ev = toEvent(out);

  /* A field the model left empty is one it had nothing to say about, not one
     the user asked to clear — clearing is what the field on screen is for. */
  ['title', 'date', 'start', 'location', 'endDate'].forEach(function (f) {
    if (!ev[f]) ev[f] = current[f] || '';
  });
  if (!ev.end) ev.end = current.end || null;

  /* allDay is a boolean and always arrives as one, so "false" cannot be told
     apart from "was not mentioned" — and a correction about the location would
     otherwise turn a school trip back into a timed event. It is turned on by
     saying so, and off by giving times, never merely by being about something
     else. */
  if (!ev.allDay) ev.allDay = hhmm(ev.start) ? false : !!current.allDay;
  if (ev.allDay) { ev.start = ''; ev.end = null; }

  // repetition is the app's business, not this tool's
  ev.repeat      = current.repeat === 'weekly' ? 'weekly' : 'none';
  ev.repeatUntil = current.repeatUntil || '';

  return { ok: true, status: 'event', event: ev };
}

/* A week here runs Sunday to Saturday, and "the whole week of 29/11" names one
 * by a single day inside it. Finding that week's Sunday is arithmetic, so it
 * is done here rather than asked of the model, for the same reason every other
 * date calculation is.
 * @param {string} iso any day in the week
 * @returns {string} the Sunday of that week
 */
function sundayOf(iso) {
  return plusDays(iso, -toDate(iso, '12:00').getDay());
}

/* A date said without a year means the next time that date comes round — the
 * same rule a bare weekday follows, and for the same reason: an event is set
 * forward, never backward. The model is told this, and is checked on it here,
 * because calendar arithmetic is where it has gone wrong every time before.
 * @param {string} dateStr yyyy-MM-dd
 * @returns {string} the same date, moved to next year if it has already gone.
 */
function rollYear(dateStr) {
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  // yyyy-MM-dd compares correctly as text, so no date objects are needed
  if (!isDate(dateStr) || dateStr >= today) return dateStr;
  return String(Number(dateStr.slice(0, 4)) + 1) + dateStr.slice(4);
}

/** One raw item from the model's `events` array, cleaned into what the app reads. */
function toEvent(raw) {
  const ev = {
    title:      String(raw.title || '').trim(),
    date:       raw.bareYear ? rollYear(raw.date || '') : (raw.date || ''),
    allDay:     !!raw.allDay,
    /* Inclusive here, and everywhere the app can see. Google's exclusive end is
       computed at the write and nowhere else, so there is one place to get it
       wrong instead of five. */
    endDate:    isDate(raw.endDate)
                ? (raw.bareYear ? rollYear(raw.endDate) : raw.endDate) : '',
    start:      hhmm(raw.start),
    end:        hhmm(raw.end) || null,  // null, never a guess
    location:   raw.location || '',
    needsEnd:   !!raw.needsEnd,
    needsTitle: !!raw.needsTitle,
    needsLocation: !!raw.needsLocation,
    note:       raw.note     || '',
    repeat:     raw.repeat === 'weekly' ? 'weekly' : 'none',
    /* An end date the model invented is worse than none: the app offers a
       default the user can see and change, and a bad date here would look
       just as confirmed as a good one. */
    repeatUntil: isDate(raw.repeatUntil) ? raw.repeatUntil : ''
  };

  /* A whole week is a day-long event whose ends nobody stated: the message
     names one day in it, and both ends follow from that. */
  if (raw.wholeWeek && isDate(ev.date)) {
    ev.allDay  = true;
    ev.date    = sundayOf(ev.date);
    ev.endDate = plusDays(ev.date, 6);
  }

  /* A day-long event has no clock, and a stray time from the model would put
     one back on screen for someone to wonder about. */
  if (ev.allDay) { ev.start = ''; ev.end = null; ev.needsEnd = false; }
  // a last day before the first is not a span, it is a misreading
  if (ev.endDate && ev.date && ev.endDate < ev.date) ev.endDate = '';

  /* The app must always have something to show and confirm. A blank title is
     the one case where the form has nothing to offer, so it never ships. */
  if (!ev.title) {
    ev.title = 'אירוע';
    ev.needsTitle = true;
  }

  /* "ביום רביעי" said on a Tuesday is the one genuinely ambiguous case: it
     resolves to tomorrow, but someone who meant tomorrow would have said מחר.
     Rather than guess, hand both dates back and let the app ask. */
  if (bareWeekdayIsTomorrow(raw.bareWeekday, ev.date)) {
    ev.ambiguousDay = {
      tomorrow: ev.date,
      nextWeek: plusDays(ev.date, 7),
      weekday:  String(raw.bareWeekday)
    };
  }

  return ev;
}

/** True when a bare weekday landed on tomorrow — the one case worth asking about. */
function bareWeekdayIsTomorrow(bare, date) {
  if (!bare || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return false;
  return date === plusDays(Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), 1);
}

function isDate(iso) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''));
}

/** Day arithmetic anchored at noon, so a DST shift cannot move the date. */
function plusDays(iso, n) {
  const d = toDate(iso, '12:00');
  d.setDate(d.getDate() + n);
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

// ---------- finding the event an edit refers to ----------
/** Words worth matching on: drops punctuation and one-letter noise. */
function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .split(/[^\u0590-\u05FFa-z0-9]+/)   // keep Hebrew, latin, digits
    .filter(w => w.length > 1);
}

/* Hebrew glues its particles onto the front of a word: האימון is אימון,
 * לשיעור is שיעור. Someone writing a correction in ordinary Hebrew uses
 * them; the event title does not. One letter only, so אימון and אימונים
 * stay apart. */
const PARTICLES = 'בלהומשכ';

function sameWord(a, b) {
  if (a === b) return true;
  const big   = a.length > b.length ? a : b;
  const small = a.length > b.length ? b : a;
  return big.length - small.length === 1 &&
         big.slice(1) === small &&
         PARTICLES.indexOf(big.charAt(0)) !== -1;
}

/** @returns {number} the fraction of b's words that appear in a. */
function overlap(a, b) {
  if (!a.length || !b.length) return 0;
  let hits = 0;
  for (const w of b) if (a.some(function (x) { return sameWord(x, w); })) hits++;
  return hits / b.length;
}

function shape(e) {
  const s = e.getStartTime(), t = e.getEndTime();
  return {
    id:        e.getId(),
    title:     e.getTitle(),
    date:      Utilities.formatDate(s, TZ, 'yyyy-MM-dd'),
    start:     Utilities.formatDate(s, TZ, 'HH:mm'),
    end:       Utilities.formatDate(t, TZ, 'HH:mm'),
    location:  e.getLocation() || '',
    recurring: e.isRecurringEvent(),
    allDay:    e.isAllDayEvent(),
    /* Google's stored end is the morning after; the app is told the last day
       the event actually covers. */
    endDate:   e.isAllDayEvent()
               ? Utilities.formatDate(new Date(t.getTime() - 864e5), TZ, 'yyyy-MM-dd')
               : ''
  };
}

// ---------- what else is already on that day ----------
/**
 * Read-only: the confirm screen shows this so an event is never added blind
 * into a day that is already full.
 */
function dayEvents(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) {
    return { ok: false, error: 'bad date' };
  }
  const from = toDate(dateStr, '00:00');
  const to   = new Date(from.getTime() + 864e5);

  const events = calendar().getEvents(from, to)
    .map(shape)
    .sort(function (a, b) {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;   // all-day first
      return a.start < b.start ? -1 : a.start > b.start ? 1 : 0;
    });

  return { ok: true, date: dateStr, events: events };
}

/**
 * Searches a two-week window centred on where the event is said to live now,
 * and ranks by how much of the search text appears in each title. Returns the
 * best match first, then up to four alternatives for the user to choose from.
 */
/**
 * @returns {{list: Array, report: Object}} the candidates, and an account of
 *   how they were arrived at. "It did not find my event" is unanswerable
 *   without knowing what it searched for, where, and what it scored — so the
 *   reply carries that back rather than leaving it to be guessed at.
 */
function findCandidates(find, ev) {
  /* A cancellation often names no date — "האימון של דנה בוטל" — and the
     search still has to happen somewhere. Today is the useful centre, since
     the window already reaches a week either side of it. */
  const anchor = (find && find.date) || ev.date ||
                 Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const needle = tokens((find && find.text) || ev.title);
  const report = {
    searchedFor: ((find && find.text) || ev.title || ''),
    words: needle.join(' '),
    anchor: anchor || '',
    scanned: 0,
    best: []
  };
  if (!anchor) return { list: [], report: report };

  // a full week either side of the anchor day (864e5 ms = one day)
  const base = toDate(anchor, '00:00');
  const from = new Date(base.getTime() - 7 * 864e5);
  const to   = new Date(base.getTime() + 8 * 864e5);
  const anchorDay = Utilities.formatDate(base, TZ, 'yyyy-MM-dd');

  const scored = calendar().getEvents(from, to).map(function (e) {
    const c = shape(e);
    /* Both directions: "תזיז את האימון של דנה לשלוש" carries eight
       words for a three-word title, and scoring only how much of the sentence
       the title covered left every real match near zero — low enough that the
       day bonus, not the name, decided which event was meant. */
    const t = tokens(c.title);
    const s = Math.max(overlap(t, needle), overlap(needle, t)) +
              (c.date === anchorDay ? 0.25 : 0);
    return { c: c, s: s };
  });

  report.scanned = scored.length;
  /* the highest scorers whether or not they passed, so a near miss is visible */
  report.best = scored.slice()
    .sort(function (a, b) { return b.s - a.s; })
    .slice(0, 5)
    .map(function (x) { return x.c.date + ' ' + x.c.title + '  = ' + x.s.toFixed(2); });

  const hits = scored
    .filter(function (x) { return x.s > 0; })
    .sort(function (a, b) { return b.s - a.s; })
    .slice(0, 5)
    .map(function (x) { return x.c; });

  return { list: hits, report: report };
}

// ---------- step 2: confirmed event -> calendar ----------
/**
 * The EventColor for whoever the title names, or null for an event that names
 * nobody. A colour name that is not in the enum resolves to null rather than
 * throwing — a typo in the config block must not stop an event being created.
 *
 * Both sides of the separator count: the name buttons write "[name] - event",
 * but the haircut template above is "תספורת - [name]", and that is just as
 * much that person's event. Prefixes are checked first so "דנה - משחק מול
 * איתי" belongs to דנה, whichever order the config happens to be written in.
 */
function colorFor(title) {
  const t = String(title || '');
  const named = function (name) {
    return t.indexOf(name + ' - ') === 0 ||
           t.length > name.length + 3 && t.slice(-(name.length + 3)) === ' - ' + name;
  };

  const colors = personColor();
  for (const name in colors) {
    if (t.indexOf(name + ' - ') === 0) return CalendarApp.EventColor[colors[name]] || null;
  }
  for (const name in colors) {
    if (named(name)) return CalendarApp.EventColor[colors[name]] || null;
  }
  return null;
}

/* Google takes an exclusive end for an all-day event: one day passes only its
 * own date, and a span passes the morning after the last day. Every other part
 * of this app treats the last day as inclusive, so the conversion lives here
 * alone rather than at each call.
 * @returns {{from: Date, to: ?Date, last: string}} `to` is null for a single day.
 */
function allDaySpan(ev) {
  const last = (isDate(ev.endDate) && ev.endDate > ev.date) ? ev.endDate : ev.date;
  return {
    from: toDate(ev.date, '00:00'),
    to:   last === ev.date ? null : toDate(plusDays(last, 1), '00:00'),
    last: last
  };
}

/* A day-long event is not a series: "every week, all of next week" is not a
 * thing the app offers, so repetition is simply not part of this path. */
function createAllDay(ev, user) {
  if (!isDate(ev.date)) return { ok: false, error: 'missing date' };

  const span = allDaySpan(ev);
  const opts = {
    location: ev.location || '',
    description: [ev.note || '', user ? 'נוצר על ידי: ' + user : '']
      .filter(String).join('\n')
  };

  const created = span.to
    ? calendar().createAllDayEvent(ev.title, span.from, span.to, opts)
    : calendar().createAllDayEvent(ev.title, span.from, opts);

  const color = colorFor(ev.title);
  if (color) created.setColor(color);

  return { ok: true, id: created.getId(), when: whenAllDay(ev.date, span.last) };
}

function createEvent(ev, user) {
  if (ev.allDay) return createAllDay(ev, user);
  if (!hhmm(ev.start)) return { ok: false, error: 'missing start time' };
  if (!hhmm(ev.end))   return { ok: false, error: 'missing end time' };

  const start = toDate(ev.date, ev.start);
  const end   = toDate(ev.date, ev.end);
  if (end <= start) end.setDate(end.getDate() + 1); // crosses midnight

  const opts = {
    location: ev.location || '',
    description: [ev.note || '', user ? 'נוצר על ידי: ' + user : '']
      .filter(String).join('\n')
  };

  const color = colorFor(ev.title);

  if (ev.repeat !== 'weekly') {
    const created = calendar().createEvent(ev.title, start, end, opts);
    if (color) created.setColor(color);
    return { ok: true, id: created.getId(), when: whenHe(start, end) };
  }

  /* A series is bounded on purpose. The app always sends an end date — these
     checks are here because the calendar is shared and an unbounded or
     mistyped series is not something anyone wants to undo by hand. */
  const until = String(ev.repeatUntil || '');
  if (!isDate(until)) {
    return { ok: false, error: 'סדרה חוזרת חייבת תאריך סיום.' };
  }
  if (until < ev.date) {
    return { ok: false, error: 'תאריך סיום הסדרה מוקדם מהאירוע עצמו.' };
  }
  if (until > plusDays(ev.date, MAX_SERIES_DAYS)) {
    return { ok: false, error: 'סדרה חוזרת מוגבלת לשנתיים קדימה.' };
  }

  /* until() is inclusive of the moment it is given, not of the day: handing it
     midnight would drop the last occurrence, so it gets the end of that day. */
  const rule = CalendarApp.newRecurrence()
    .addWeeklyRule()
    .until(toDate(until, '23:59'));

  const series = calendar().createEventSeries(ev.title, start, end, rule, opts);
  if (color) series.setColor(color);

  return {
    ok: true,
    id: series.getId(),
    when: whenHe(start, end),
    repeat: 'weekly',
    count: weeklyCount(ev.date, until)
  };
}

/** How many weekly occurrences fit between two dates, both ends included. */
function weeklyCount(fromIso, untilIso) {
  const days = Math.round(
    (toDate(untilIso, '12:00').getTime() - toDate(fromIso, '12:00').getTime()) / 864e5
  );
  return days < 0 ? 0 : Math.floor(days / 7) + 1;
}

// ---------- step 2b: confirmed edit -> existing calendar event ----------
/**
 * `scope` is always 'instance'. getEventById returns the single occurrence for
 * a recurring event, so mutating it here never touches the rest of the series
 * — which is the rule the brief sets. Anything other than 'instance' is
 * refused rather than quietly widened.
 */
/* The one action with nothing to undo. It never searches: it takes the id of
 * an event the user has already seen on screen and confirmed, so what is
 * deleted is always what was shown. */
function deleteEvent(id, scope) {
  if (!id) return { ok: false, error: 'missing event id' };
  if (scope && scope !== 'instance' && scope !== 'series') {
    return { ok: false, error: 'unsupported scope' };
  }

  const target = calendar().getEventById(id);
  if (!target) return { ok: false, error: 'event not found' };

  /* Read before deleting — afterwards there is nothing left to ask. */
  const title = target.getTitle();
  const when  = whenHe(target.getStartTime(), target.getEndTime());
  const whole = scope === 'series' && target.isRecurringEvent();

  if (whole) target.getEventSeries().deleteEventSeries();
  else       target.deleteEvent();

  return { ok: true, title: title, when: when, scope: whole ? 'series' : 'instance' };
}

function updateEvent(id, scope, ev, user) {
  if (!id)       return { ok: false, error: 'missing event id' };
  if (!ev.allDay && !hhmm(ev.start)) return { ok: false, error: 'missing start time' };
  if (!ev.allDay && !hhmm(ev.end))   return { ok: false, error: 'missing end time' };
  if (scope && scope !== 'instance') return { ok: false, error: 'unsupported scope' };

  const target = calendar().getEventById(id);
  if (!target) return { ok: false, error: 'event not found' };

  target.setTitle(ev.title);

  /* setAllDayDates and setTime each convert the event to their own kind, so an
     event can move between timed and day-long without being made again. */
  let when;
  if (ev.allDay) {
    const span = allDaySpan(ev);
    target.setAllDayDates(span.from, span.to || toDate(plusDays(ev.date, 1), '00:00'));
    when = whenAllDay(ev.date, span.last);
  } else {
    const start = toDate(ev.date, ev.start);
    const end   = toDate(ev.date, ev.end);
    if (end <= start) end.setDate(end.getDate() + 1); // crosses midnight
    target.setTime(start, end);
    when = whenHe(start, end);
  }

  /* An edit that moves an event to another child should move its colour too.
     Only ever set, never cleared: an event whose name was removed keeps the
     colour it had, because setColor has no "back to the board default". */
  const color = colorFor(ev.title);
  if (color) target.setColor(color);

  target.setLocation(ev.location || '');
  target.setDescription(
    [ev.note || '', user ? 'עודכן על ידי: ' + user : ''].filter(String).join('\n')
  );

  return { ok: true, id: target.getId(), when: when };
}

/** Builds a Date in Israel time — handles winter/summer clock automatically. */
/* The model is asked for HH:mm and usually obliges, but "4:45", "16.45" and a
 * stray space have all turned up. An unusable time has to become no time at
 * all rather than travel on as a value: in update mode the app prefers any
 * non-empty field over what the calendar already holds, so a time the model
 * could not express properly quietly erased a real one.
 * @returns {string} 'HH:mm', or '' when it is not a time.
 */
function hhmm(v) {
  const m = String(v == null ? '' : v).trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (!m) return '';
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return '';
  return ('0' + h).slice(-2) + ':' + ('0' + min).slice(-2);
}

function toDate(dateStr, timeStr) {
  return Utilities.parseDate(dateStr + ' ' + timeStr, TZ, 'yyyy-MM-dd HH:mm');
}

/**
 * "יום שלישי 4.11.2025 16:00–17:30" — 24h, Hebrew weekday. Both ends, since
 * this line is the whole summary of what was written, and after a batch it is
 * the only place any of it is read.
 *
 * SimpleDateFormat's EEEE has no locale here and emits English, so the day name
 * is looked up rather than formatted.
 *
 * @param {Date}  start
 * @param {Date=} end   omitted only where there is nothing to show
 */
/* An all-day event has no clock to report, so the line says the span instead.
 * Both ends are inclusive, which is how a person reads "12 עד 14 בנובמבר".
 * The word עד rather than a dash on purpose: a neutral dash between two runs
 * ending in digits gets reordered in a Hebrew line, which is the fault that
 * once had 16:30–18:00 reading back as 18:00–16:30.
 */
function whenAllDay(fromISO, lastISO) {
  const label = function (iso) {
    const p = iso.split('-').map(Number);
    const wd = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
    return HE_DAYS[wd] + ' ' + p[2] + '.' + p[1] + '.' + p[0];
  };
  if (!isDate(lastISO) || lastISO === fromISO) return label(fromISO) + ' · כל היום';

  const days = Math.round(
    (toDate(lastISO, '12:00').getTime() - toDate(fromISO, '12:00').getTime()) / 864e5) + 1;
  return label(fromISO) + ' עד ' + label(lastISO) + ' · ' + days + ' ימים';
}

function whenHe(start, end) {
  const iso = Utilities.formatDate(start, TZ, 'yyyy-MM-dd').split('-').map(Number);
  const wd  = new Date(Date.UTC(iso[0], iso[1] - 1, iso[2])).getUTCDay();
  const day = HE_DAYS[wd] + ' ' + iso[2] + '.' + iso[1] + '.' + iso[0];
  const from = Utilities.formatDate(start, TZ, 'HH:mm');
  if (!end) return day + ' ' + from;

  /* An event that runs past midnight ends on the following day, and saying so
     is worth more than keeping the line short. */
  const crosses = Utilities.formatDate(end, TZ, 'yyyy-MM-dd') !==
                  Utilities.formatDate(start, TZ, 'yyyy-MM-dd');
  const to = Utilities.formatDate(end, TZ, 'HH:mm');

  /* The dash between two times is a neutral character, and in a Hebrew line it
     takes the paragraph's direction — which splits the range into two runs laid
     out right to left, so "16:30–18:00" is read back as 18:00–16:30. Wrapping
     it in an isolate keeps the pair together and in order. */
  const range = LRI + from + '–' + to + PDI;
  return day + ' ' + range + (crosses ? ' (למחרת)' : '');
}

/* Unicode isolates: everything between them lays out left-to-right on its own,
   without disturbing the direction of the text around it. */
const LRI = '⁦';
const PDI = '⁩';

// ---------- one-off: clear out a batch that was entered by mistake ----------
/* Set these three, run listMatching() to see exactly what is caught, and only
 * then run removeMatching(). Nothing calls either of them.
 *
 * The two-step is the point: a title fragment is a blunt instrument, and the
 * difference between the right five events and someone's whole season is one
 * careless word. Read the list first. */
const PURGE_TEXT = '';              // a title fragment; nothing runs while empty
const PURGE_FROM = '2026-09-03';    // yyyy-MM-dd, inclusive
const PURGE_TO   = '2027-09-03';    // yyyy-MM-dd, exclusive

/** Everything whose title contains PURGE_TEXT in the window. Deletes nothing. */
function listMatching() {
  const hits = matchingEvents();
  hits.forEach(function (e) {
    const c = shape(e);
    Logger.log((c.recurring ? '[series] ' : '[single] ') +
               c.date + ' ' + c.start + '-' + c.end + '  ' + c.title);
  });
  Logger.log('--- ' + hits.length + ' event(s) match "' + PURGE_TEXT + '" between ' +
             PURGE_FROM + ' and ' + PURGE_TO + '. Nothing was deleted.');
}

/** Deletes what listMatching() showed. A recurring event goes as one series. */
function removeMatching() {
  const hits = matchingEvents();
  const doneSeries = {};
  let gone = 0, failed = 0;

  hits.forEach(function (e) {
    try {
      const title = e.getTitle();
      const when  = shape(e).date;
      if (e.isRecurringEvent()) {
        /* getEventSeries() hands back the series itself; there is no
           getEventSeriesId(), and an instance id is not a series id. */
        const series = e.getEventSeries();
        const id = series.getId();
        if (doneSeries[id]) return;
        doneSeries[id] = true;
        series.deleteEventSeries();
        Logger.log('deleted series: ' + title);
      } else {
        e.deleteEvent();
        Logger.log('deleted: ' + when + '  ' + title);
      }
      gone++;
    } catch (err) {
      failed++;
      Logger.log('could not delete "' + e.getTitle() + '": ' + err);
    }
  });

  Logger.log('--- deleted ' + gone + ', failed ' + failed);
}

function matchingEvents() {
  const needle = String(PURGE_TEXT).trim();
  if (!needle) throw new Error('PURGE_TEXT is empty — that would match everything');

  return calendar()
    .getEvents(toDate(PURGE_FROM, '00:00'), toDate(PURGE_TO, '00:00'))
    .filter(function (e) { return e.getTitle().indexOf(needle) !== -1; });
}

// ---------- one-off: bring existing events up to the current colours ----------
/**
 * Colour is applied when an event is written, so changing PERSON_COLOR leaves
 * everything already on the board as it was. Run this from the editor once
 * after changing the colours to bring the back catalogue into line.
 *
 * Nothing calls it — it is a bulk write across a shared calendar and should
 * happen because someone decided it should, not as a side effect of a deploy.
 * Safe to re-run: an event already the right colour is left untouched, and one
 * that names nobody is never given a colour it did not have.
 *
 * A recurring event is recoloured on its series, once, rather than per
 * occurrence — colouring instances one at a time would split the series into
 * exceptions.
 */
function recolorExisting() {
  const from = toDate(plusDays(Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), -RECOLOR_BACK), '00:00');
  const to   = toDate(plusDays(Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'),  RECOLOR_AHEAD), '00:00');

  const events = calendar().getEvents(from, to);
  const doneSeries = {};
  let changed = 0, already = 0, skipped = 0, failed = 0;

  for (const e of events) {
    const want = colorFor(e.getTitle());
    if (!want) { skipped++; continue; }          // names nobody: leave it alone

    try {
      let target = e;
      if (e.isRecurringEvent()) {
        target = e.getEventSeries();             // the series, not an instance id
        const id = target.getId();
        if (doneSeries[id]) continue;            // the series was handled already
        doneSeries[id] = true;
      }
      if (String(target.getColor()) === String(want)) { already++; continue; }
      target.setColor(want);
      changed++;
      Logger.log('recoloured: ' + e.getTitle() + '  (' + shape(e).date + ')');
    } catch (err) {
      failed++;
      Logger.log('could not recolour "' + e.getTitle() + '": ' + err);
    }
  }

  Logger.log('scanned ' + events.length + ' events from ' +
             Utilities.formatDate(from, TZ, 'yyyy-MM-dd') + ' to ' +
             Utilities.formatDate(to, TZ, 'yyyy-MM-dd'));
  Logger.log('changed ' + changed + ', already right ' + already +
             ', no name ' + skipped + ', failed ' + failed);
}

// ---------- run this once from the editor to verify setup ----------
/* Run this from the editor after setting the Script Properties. It says what
 * is configured and what is missing, then proves the model can be reached. */
function testSetup() {
  Logger.log('version: ' + BACKEND_VERSION);

  ['ANTHROPIC_KEY', 'SHARED_SECRET', 'CALENDAR_ID'].forEach(function (k) {
    Logger.log(k + ': ' + (PROPS.getProperty(k) ? 'set' : 'MISSING — required'));
  });

  Logger.log('calendar: ' + calendar().getName());

  /* Optional, and worth naming individually: a deployment missing all four
     works, but reads a family's shorthand no better than a stranger would. */
  Logger.log('PEOPLE: ' + (people().length ? people().join(', ') : '(none)'));
  const colors = personColor();
  Logger.log('PERSON_COLOR: ' + (Object.keys(colors).length
    ? Object.keys(colors).map(function (n) { return n + '=' + colors[n]; }).join(', ')
    : '(none)'));
  Logger.log('VENUES: ' + (venues().length ? venues().join(' / ') : '(none)'));
  Logger.log('TEMPLATES: ' + (templates() ? 'set' : '(none)'));

  /* Names configured for a colour but never offered as a button get no chip to
     write them into a title, so the colour would never be applied. */
  const orphans = Object.keys(colors).filter(function (n) {
    return people().indexOf(n) === -1;
  });
  if (orphans.length) Logger.log('note: coloured but not in PEOPLE — ' + orphans.join(', '));
  // all of these should come back as events with a title — never as a question
  /* v36 smoke-tested name recognition and venue snapping with one hardcoded
     sentence about one family. Built from this deployment's own configuration
     it tests the same two things, for whoever is actually running it. */
  const who = people()[0] || '';
  const where = venues()[0] || '';
  if (who || where) {
    Logger.log(JSON.stringify(parseText(
      'מחר אימון' + (who ? ' ל' + who : '') + (where ? ' ב' + where : '') + ' 16:00-17:30')));
  }

  Logger.log(JSON.stringify(parseText('מחר יש אימון ב-17:00')));
  Logger.log(JSON.stringify(parseText('אסיפת הורים ביום שלישי ב-20:00')));
  // three events, one per training day — not one event, and not three copies
  Logger.log(JSON.stringify(parseText(
    'לוח האימונים: ראשון 17:00-18:30, שלישי 17:00-18:30, חמישי 16:00-17:30'
  )));
  // still three — repeat="weekly" on each, rather than the same day duplicated
  Logger.log(JSON.stringify(parseText(
    'מהשבוע הבא יש אימונים קבועים כל שבוע: ראשון ושלישי 17:00-18:30, ' +
    'וחמישי 16:00-17:30, עד סוף העונה'
  )));
}
