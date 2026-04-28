# Pulse · WhatsApp Operations — Backend

שרת Node.js מקומי שמספק API ל־Dashboard. מבוסס על `whatsapp-web.js`, עם
SQLite לפרסיסטנס ו־scheduler מובנה לשליחה חד־פעמית או חוזרת (יום/שבוע/חודש).

> ⚠️ `whatsapp-web.js` משתמש ב־WhatsApp Web בצורה לא רשמית. שימוש
> מוגזם / שליחה לכמויות גדולות עלול לגרום לחסימה של מספר ה־WhatsApp.
> מיועד לשימוש פנימי בלבד, לא לקמפיינים המוניים.

---

## תוכן עניינים

1. [התקנה](#התקנה)
2. [הפעלה ראשונה](#הפעלה-ראשונה)
3. [חיבור הדשבורד](#חיבור-הדשבורד)
4. [API Reference](#api-reference)
5. [הגדרות (`.env`)](#הגדרות-env)
6. [פתרון תקלות](#פתרון-תקלות)

---

## התקנה

דרישות: **Node.js 18+** ו־npm. ב־Linux גם Chromium (אם לא מותקן).

```bash
cd whatsapp-backend
npm install
cp .env.example .env       # אופציונלי — להגדרות מותאמות
npm start
```

---

## הפעלה ראשונה

בהפעלה הראשונה תראה ב־console משהו כזה:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Pulse · WhatsApp Operations — Backend v1.0.0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[http]      listening on http://127.0.0.1:3001
[whatsapp]  initializing…
[whatsapp]  loading 50% — Loading your messages
[whatsapp]  QR ready — scan it from your phone
```

עכשיו פותחים את ה־dashboard, נכנסים ל־**Settings** → מגדירים את
ה־Backend URL לכתובת `http://127.0.0.1:3001`, ולוחצים **Save**.

ה־QR יופיע בתוך ה־frame ב־Settings. סורקים אותו דרך WhatsApp בנייד
(הגדרות → מכשירים מקושרים → קישור מכשיר). הסשן נשמר ב־`.wwebjs_auth/` —
לא צריך לסרוק שוב בהפעלות הבאות.

לאיפוס סשן (כדי לסרוק QR חדש):

```bash
npm run reset:session
```

לאיפוס מלא (סשן + DB + uploads):

```bash
npm run reset:all
```

---

## חיבור הדשבורד

האפשרות הנוחה ביותר: שמירת קבצי הדשבורד ב־`./public/` באותה תיקייה
של השרת. אז `http://127.0.0.1:3001` יציג את הדשבורד עצמו (אפס CORS).

```
whatsapp-backend/
├── server.js, db.js, ...
└── public/
    ├── index.html
    ├── app.css
    └── app.js
```

הדשבורד עושה `GET /api/status` כל ~6 שניות, ומציג בזמן אמת:
- סטטוס חיבור WhatsApp (טוען / ממתין ל־QR / מחובר)
- ה־QR עצמו (כ־data URL מוכן לרינדור)
- מספר הודעות ממתינות + תזמונים חוזרים פעילים

---

## API Reference

הכל ב־`/api`. גוף בקשות JSON, תשובות JSON עם `{ ok: true|false, ... }`.

### חיבור

- `GET /api/health` — liveness check
- `GET /api/status` — מצב WhatsApp + סטטיסטיקות יומיות
- `POST /api/logout` — מתנתק מ־WhatsApp Web (מחייב QR חדש)

### שליחה

```bash
# שליחה מיידית
curl -X POST http://127.0.0.1:3001/api/send \
  -H 'Content-Type: application/json' \
  -d '{"phone":"0501234567","message":"שלום מ־Pulse"}'

# שליחה לקבוצה (chat-id מסתיים ב־@g.us)
curl -X POST http://127.0.0.1:3001/api/send \
  -H 'Content-Type: application/json' \
  -d '{"phone":"120363194843299939@g.us","message":"שלום קבוצה"}'

# תזמון לעתיד (חד־פעמי)
curl -X POST http://127.0.0.1:3001/api/send \
  -H 'Content-Type: application/json' \
  -d '{"phone":"0501234567","message":"תזכורת","scheduleAt":"2026-04-28T10:00:00+03:00"}'

# בדיקת חיבור — לא נרשם בלוגים
curl -X POST http://127.0.0.1:3001/api/test \
  -H 'Content-Type: application/json' \
  -d '{"phone":"0501234567"}'
```

### העלאת קובץ

```bash
# מחזיר { url: "internal:./uploads/..." } שאפשר להעביר ל־/api/send כ־fileUrl
curl -X POST http://127.0.0.1:3001/api/upload -F file=@invoice.pdf
```

### תזמון חוזר

```bash
# יצירה
curl -X POST http://127.0.0.1:3001/api/recurring \
  -H 'Content-Type: application/json' \
  -d '{"phone":"0501234567","message":"תזכורת שבועית","frequency":"weekly","startAt":"2026-04-28T10:00:00+03:00"}'
# frequency: "hourly" | "daily" | "weekly" | "monthly"

# רשימה
curl http://127.0.0.1:3001/api/recurring

# השהייה / הפעלה
curl -X PATCH http://127.0.0.1:3001/api/recurring/1 \
  -H 'Content-Type: application/json' \
  -d '{"active":false}'

# מחיקה
curl -X DELETE http://127.0.0.1:3001/api/recurring/1
```

### תור חד־פעמי

- `GET /api/schedule?status=pending|sent|failed|cancelled|all`
- `DELETE /api/schedule/:id` — ביטול לפני שליחה

### לוגים

- `GET /api/logs?status=&q=&limit=` — היסטוריה מלאה (עד 1000)
- `DELETE /api/logs` — מחיקה מלאה (לא הפיכה)

### אנשי קשר וקבוצות

- `GET /api/contacts?q=&limit=` — אנשי קשר מ־WhatsApp
- `GET /api/groups?q=&limit=` — קבוצות
- `GET /api/profile-pic?id=<chat-id>` — URL לתמונת פרופיל (cached 15 דקות)

### הגדרות

- `GET /api/settings` — מחזיר את הגדרות השרת (כרגע: `stripNiqqud`)
- `PUT /api/settings` עם `{ stripNiqqud: true|false }` — שינוי

---

## הגדרות (`.env`)

| משתנה                       | ברירת מחדל              | תיאור                                          |
|-----------------------------|-------------------------|------------------------------------------------|
| `PORT`                      | `3001`                  | יציאת HTTP                                     |
| `HOST`                      | `127.0.0.1`             | bind address                                   |
| `CORS_ORIGIN`               | `*`                     | רשימה מופרדת בפסיקים, או `*`                  |
| `DB_PATH`                   | `./data/pulse.db`       | מיקום קובץ SQLite                              |
| `UPLOADS_DIR`               | `./uploads`             | היכן לשמור קבצים שהועלו                        |
| `SCHEDULE_TICK_INTERVAL`    | `15`                    | תדירות (שניות) של בדיקת תור מתוזמן/חוזר        |
| `SEND_THROTTLE_MS`          | `1500`                  | השהיה בין שליחות באותו batch                   |
| `SEND_BATCH_LIMIT`          | `10`                    | כמה הודעות נשלחות לכל היותר ב־tick אחד         |
| `PUPPETEER_EXECUTABLE_PATH` | (לא מוגדר)              | נתיב מפורש ל־Chromium אם הזיהוי האוטומטי נכשל |

---

## פתרון תקלות

**Chromium לא נמצא (Linux):**
```bash
sudo apt-get install -y chromium-browser
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser npm start
```

**WhatsApp נתקע ב־`loading 99%`:**
לפעמים גרסת WA Web משתנה. נסה:
```bash
npm run reset:session
npm start
```
ואז לסרוק QR מחדש.

**`NOT_REGISTERED` בשליחה:**
המספר אינו רשום ב־WhatsApp. השרת בודק זאת לפני השליחה כדי למנוע
חסימות מצד WhatsApp. ודא שהמספר תקין ובפורמט בינלאומי. (לקבוצות —
זה לא ייקרה, כי chat-id של קבוצה לא נבדק.)

**תזמון לא יורה במועד שהוגדר:**
ודא ש־WhatsApp מוצג כ־`ready` ב־`/api/status`. ב־PowerShell של השרת
תראה כל ~minute שורות diagnostic כמו:
```
[scheduler] heartbeat · 1 recurring · 0 scheduled · ready=true
```
אם `ready=false` — הסשן עדיין נטען או נותק.

**הודעה עם ניקוד / אימוג'ים נכשלת:**
ההגדרה `stripNiqqud` (default `true`) מסירה ניקוד אוטומטית לפני
שליחה — מטפל בבעיה ידועה של puppeteer + תווים מורכבים. אפשר לכבות
דרך הדשבורד או:
```bash
curl -X PUT http://127.0.0.1:3001/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"stripNiqqud":false}'
```

**מיקום הקבצים:**
- DB: `./data/pulse.db` (SQLite, WAL mode)
- WhatsApp session: `./.wwebjs_auth/` (אל תעלה ל־git)
- קבצים שהועלו: `./uploads/`

---

## ארכיטקטורה (תקציר)

```
┌─────────────┐  HTTP  ┌──────────────────────────┐
│  Dashboard  │ ◄────► │  server.js (Express)     │
│  (browser)  │        │  ├─ /api/status, /send…   │
└─────────────┘        │  ├─ db.js (SQLite)        │
                       │  ├─ scheduler.js          │
                       │  │   tick (15s)           │
                       │  │   ├ scheduled queue    │
                       │  │   └ recurring queue    │
                       │  └─ whatsapp.js ──┐       │
                       └───────────────────┼───────┘
                                           │ Puppeteer
                                           ▼
                                  ┌─────────────────┐
                                  │  WhatsApp Web   │
                                  │  (web.whatsapp) │
                                  └─────────────────┘
```

לולאה אחת פנימית כל 15 שניות מטפלת בשני סוגי תזמון:

1. **חד־פעמי** — בודק בטבלת `scheduled` שורות שעבר זמנן, מבצע claim
   אטומי, שולח, רושם ב־`logs`.
2. **חוזר** — בודק בטבלת `recurring_schedules`, שולח, ואז מחשב
   `next_run_at` הבא לפי ה־frequency (יום/שבוע/חודש) ועוגן ה־start.

---

בנוי באהבה כחלק ממערכת **Pulse · WhatsApp Operations**. 🛠️
