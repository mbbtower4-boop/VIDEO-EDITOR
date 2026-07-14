# VIDEO EDITOR — Installation & Usage Guide

*(עברית למטה — Hebrew version below)*

A tool that removes dead time (silence / frozen picture) from videos, creates
translated subtitles, and produces a Word task-list from what is said in the
video. **Everything runs on your own computer** — your videos are never
uploaded anywhere.

---

## 1. What you need

- A Windows 10/11 PC. An NVIDIA graphics card makes it much faster, but it is
  **not required** — everything works on a regular PC, just slower.
- About **10 GB of free disk space** (the AI models are large).
- Internet connection for the one-time installation only.

## 2. Installation (one time, ~15 minutes + downloads)

1. **Install Node.js**: go to <https://nodejs.org>, download the **LTS**
   version, run the installer, click Next-Next-Finish (defaults are fine).
2. **Download the tool**: go to
   <https://github.com/mbbtower4-boop/VIDEO-EDITOR>, click the green
   **Code** button → **Download ZIP**. Unzip it to a folder like
   `C:\VIDEO-EDITOR`.
   ⚠️ **Not inside OneDrive** (not Desktop/Documents if they are synced) —
   the installation downloads ~7 GB and OneDrive will try to upload all of it.
3. **Open a terminal in that folder**: open the unzipped folder in Explorer,
   click the address bar, type `cmd` and press Enter.
4. Run these two commands, **in lowercase exactly as written** (wait for each
   to finish; `NPM INSTALL` in capitals will NOT work):

   ```
   npm install
   npm run setup
   ```

   The second one downloads about **7 GB** of tools and AI models (video
   engine, speech recognition, task-extraction model) — let it run; it can
   take a while depending on your internet. It ends with "Setup complete".
   - If you don't need the Word tasks report you can save ~5 GB with
     `npm run setup -- --no-llm` instead.
5. **Start the app**: double-click **`VideoEditor.vbs`** in the folder.
   (Don't run it as administrator.)

That's it. From now on, just double-click `VideoEditor.vbs`.

## 3. How to use

### Cut the dead time out of a video

1. **Open** → choose your MP4. The video is analyzed automatically.
2. Look at the timeline at the bottom: **red blocks** are what will be removed
   (silence / frozen picture).
   - Click a red block to keep/remove it.
   - Drag its edges to adjust it.
   - Drag across an empty part of the "cuts" lane to mark your own cut.
   - Turn on **"Preview with cuts applied"** and press play — you'll hear the
     video exactly as it will be after cutting.
   - The sliders on the right control the sensitivity.
3. **Export** → choose where to save. Done — you get a shorter MP4.

### Subtitles + translation

1. Open the **trimmed** video (or continue right after exporting).
2. Click **Transcribe speech (local)** — the speech is converted to text on
   your PC (nothing is uploaded).
3. Click a language tab (עברית / English / Русский / Беларуская) → **Translate**.
4. Choose the output:
   - **Burn-in** — the subtitles are printed permanently on the picture
     (visible in any player). Most common choice.
   - **Embed tracks** — all languages inside one MP4 as switchable subtitles
     (e.g. in VLC: Subtitle menu).
   - **Save .srt / Save all** — subtitle files next to the video.

   *Note about translation methods:* the "MyMemory (free web)" method works
   with no setup. The "Claude API" method gives the best quality but needs an
   API key (⚙ Settings).

### Word task list ("mission tasks")

1. After transcribing (and translating, if you want the tasks in another
   language), click **Tasks report (Word)**.
2. You get a `.docx` checklist of every instruction said in the video —
   with checkboxes, details and priorities. Runs fully offline on the local
   AI model; no API key needed.

### Updating to a new version

1. Download the latest ZIP from the GitHub page (**Code → Download ZIP**) and
   extract it.
2. **Move the `tools` folder** from your old folder into the new one — this
   keeps the gigabytes you already downloaded.
3. In the new folder run `npm install` and then `npm run setup` (it skips
   everything that is already downloaded and finishes quickly).

### Troubleshooting

- **"Unknown command: INSTALL"** — the commands must be lowercase: `npm install`.
- **"SETUP FAILED: whisper ... smoke test failed"** — first update to the
  latest version (see above): newer versions print the exact error, verify
  that downloads are complete, and switch to a smaller speech model
  automatically on low-memory PCs. Then run `npm run setup` again and read
  the message it prints.
- **Antivirus / company laptop** — this is the most common cause on work
  computers: the antivirus silently blocks the downloaded `whisper-cli.exe` /
  `ffmpeg.exe`. Check the antivirus quarantine/history, **add an exclusion
  for the tool's folder** (ask IT if it's managed), then run `npm run setup`
  again.
- **NVIDIA GPUs** — any reasonably modern NVIDIA card (GeForce RTX / Quadro /
  RTX A-series) is supported and used automatically. No NVIDIA card at all is
  also fine — the tool runs on the CPU, just slower.
- Setup can always be re-run safely: `npm run setup` never re-downloads what
  already exists.

### Tips

- The window title shows the version (e.g. "VIDEO EDITOR v1.2.3").
- Space = play/pause, J/L = jump 10s back/forward, Ctrl+O = open, Ctrl+E = export.
- Something stuck? The **Cancel** button stops the current job.

---

---

# עורך וידאו — הוראות התקנה ושימוש

כלי שמסיר "זמן מת" (שקט / תמונה קפואה) מסרטונים, יוצר כתוביות מתורגמות,
ומפיק קובץ Word עם רשימת משימות מתוך מה שנאמר בסרטון. **הכול רץ על המחשב
שלך** — הסרטונים לא נשלחים לשום מקום.

## 1. מה צריך

- מחשב עם Windows 10/11. כרטיס מסך של NVIDIA מזרז מאוד, אבל **לא חובה** —
  הכול עובד גם על מחשב רגיל, רק לאט יותר.
- בערך **10 ג'יגה** מקום פנוי בדיסק (מודלי ה-AI גדולים).
- חיבור לאינטרנט רק להתקנה החד-פעמית.

## 2. התקנה (פעם אחת, כרבע שעה + הורדות)

1. **התקנת Node.js**: נכנסים ל-<https://nodejs.org>, מורידים את גרסת
   ה-**LTS**, מריצים את ההתקנה ולוחצים הלאה-הלאה-סיום.
2. **הורדת הכלי**: נכנסים ל-<https://github.com/mbbtower4-boop/VIDEO-EDITOR>,
   לוחצים על הכפתור הירוק **Code** ← **Download ZIP**, ומחלצים לתיקייה כמו
   `C:\VIDEO-EDITOR`.
   ⚠️ **לא בתוך OneDrive** (לא בשולחן העבודה/מסמכים אם הם מסונכרנים) —
   ההתקנה מורידה כ-7 ג'יגה ו-OneDrive ינסה להעלות את הכול לענן.
3. **פתיחת טרמינל בתיקייה**: פותחים את התיקייה בסייר הקבצים, לוחצים על שורת
   הכתובת, מקלידים `cmd` ולוחצים Enter.
4. מריצים את שתי הפקודות, **באותיות קטנות בדיוק כמו שכתוב** (מחכים שכל
   אחת תסתיים; `NPM INSTALL` באותיות גדולות לא יעבוד):

   ```
   npm install
   npm run setup
   ```

   הפקודה השנייה מורידה בערך **7 ג'יגה** של כלים ומודלים — לתת לה לרוץ.
   בסיום מופיע "Setup complete".
   - מי שלא צריך את דוח המשימות ב-Word יכול לחסוך כ-5 ג'יגה עם
     `npm run setup -- --no-llm`.
5. **הפעלה**: לחיצה כפולה על **`VideoEditor.vbs`** שבתיקייה.
   (לא להריץ כמנהל מערכת.)

זהו. מעכשיו פשוט לוחצים פעמיים על `VideoEditor.vbs`.

## 3. איך משתמשים

### חיתוך הזמן המת מסרטון

1. **Open** ← בוחרים MP4. הסרטון מנותח אוטומטית.
2. בציר הזמן למטה: **בלוקים אדומים** = מה שיוסר (שקט / תמונה קפואה).
   - לחיצה על בלוק אדום — משאירים/מסירים אותו.
   - גרירת הקצוות — כוונון מדויק.
   - גרירה על אזור ריק בשורת ה-cuts — סימון חיתוך ידני.
   - מסמנים **"Preview with cuts applied"** ומנגנים — שומעים את הסרטון
     בדיוק כפי שייצא אחרי החיתוך.
   - המחוונים מימין שולטים ברגישות.
3. **Export** ← בוחרים איפה לשמור. מקבלים MP4 קצר יותר.

### כתוביות + תרגום

1. פותחים את הסרטון **החתוך** (או ממשיכים מיד אחרי הייצוא).
2. לוחצים **Transcribe speech (local)** — הדיבור הופך לטקסט על המחשב שלך.
3. בוחרים לשונית שפה (עברית / English / Русский / Беларуская) ← **Translate**.
4. בוחרים פלט:
   - **Burn-in** — הכתוביות מוטבעות על התמונה לצמיתות (נראות בכל נגן).
     הבחירה הנפוצה.
   - **Embed tracks** — כל השפות בקובץ MP4 אחד ככתוביות שאפשר להחליף
     (למשל ב-VLC: תפריט Subtitle).
   - **Save .srt / Save all** — קובצי כתוביות ליד הסרטון.

   *לגבי שיטות תרגום:* שיטת "MyMemory (free web)" עובדת בלי שום הגדרה.
   שיטת "Claude API" נותנת את האיכות הטובה ביותר אבל דורשת מפתח API
   (בהגדרות ⚙).

### רשימת משימות ב-Word

1. אחרי תמלול (ותרגום, אם רוצים את המשימות בשפה אחרת), לוחצים
   **Tasks report (Word)**.
2. מתקבל קובץ `.docx` עם צ'קליסט של כל הוראה שנאמרה בסרטון — עם תיבות
   סימון, פירוט ועדיפויות. רץ לגמרי אופליין על מודל ה-AI המקומי, בלי מפתח API.

### עדכון לגרסה חדשה

1. מורידים את ה-ZIP העדכני מעמוד ה-GitHub‏ (**Code ← Download ZIP**) ומחלצים.
2. **מעבירים את תיקיית `tools`** מהתיקייה הישנה לחדשה — כך נשמרות הג'יגות
   שכבר ירדו.
3. בתיקייה החדשה מריצים `npm install` ואז `npm run setup` (הוא מדלג על כל
   מה שכבר ירד ומסתיים מהר).

### פתרון תקלות

- **"Unknown command: INSTALL"** — הפקודות חייבות אותיות קטנות: `npm install`.
- **"SETUP FAILED: whisper ... smoke test failed"** — קודם כל לעדכן לגרסה
  האחרונה (ראו למעלה): הגרסאות החדשות מדפיסות את השגיאה המדויקת, מוודאות
  שההורדות שלמות, ועוברות אוטומטית למודל דיבור קטן במחשב עם מעט זיכרון.
  אחר כך להריץ שוב `npm run setup` ולקרוא את ההודעה שמודפסת.
- **אנטי-וירוס / מחשב של העבודה** — הסיבה הנפוצה ביותר במחשבים ארגוניים:
  האנטי-וירוס חוסם בשקט את `whisper-cli.exe` / `ffmpeg.exe` שהורדו. בודקים
  בהסגר/היסטוריה של האנטי-וירוס, **מוסיפים החרגה לתיקיית הכלי** (אם המחשב
  מנוהל — לבקש מה-IT), ומריצים שוב `npm run setup`.
- **כרטיסי NVIDIA** — כל כרטיס NVIDIA מודרני (GeForce RTX / Quadro /
  RTX A-series) נתמך ומנוצל אוטומטית. גם בלי כרטיס NVIDIA בכלל הכול עובד —
  על המעבד, רק לאט יותר.
- תמיד אפשר להריץ שוב את ההתקנה בבטחה: `npm run setup` לא מוריד מחדש את מה
  שכבר קיים.

### טיפים

- כותרת החלון מציגה את הגרסה (למשל "VIDEO EDITOR v1.2.3").
- רווח = ניגון/עצירה, J/L = קפיצה 10 שניות אחורה/קדימה, Ctrl+O = פתיחה,
  Ctrl+E = ייצוא.
- משהו נתקע? כפתור **Cancel** עוצר את הפעולה הנוכחית.
