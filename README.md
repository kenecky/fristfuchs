# Fristfuchs – Abos & Verträge im Blick

Eine installierbare Web-App (PWA), die alle Abos und Verträge an einem Ort zeigt: monatliche Kosten, Zahlungskonto, Abschluss, Laufzeit, Kündigungsfrist und **bis wann spätestens gekündigt werden muss**.

## Funktionen

- **Übersicht**: Kosten pro Monat und Jahr, Zahl der aktiven Verträge, anstehende Kündigungsfristen und Kosten nach Kategorie
- **Verträge**: Suche, Filter nach Status und Kategorie, Sortierung nach Frist oder Kosten
- **Konten**: eigene Kontenverwaltung mit Art, Bank, IBAN (mit Prüfziffer-Check, gekürzt angezeigt), Kartenendziffern bzw. PayPal-E-Mail; Monatssumme je Konto; Auswahl im Vertrag, Umbenennen wirkt auf alle Verträge
- **Automatische Fristberechnung** aus Abschlussdatum, Mindestlaufzeit, Verlängerung und Kündigungsfrist (Tage, Wochen oder Monate)
- Farbliche Warnung: rot ab 7 Tagen vor der Frist, gelb innerhalb der Vorwarnzeit (einstellbar, Standard 30 Tage)
- **Erinnerungen**: Browser-Benachrichtigung beim Öffnen der App sowie Export als Kalendertermin (.ics, mit Alarm 14 und 3 Tage vorher), einzeln oder alle Fristen zusammen
- Unterschiedliche Zahlungsintervalle (wöchentlich bis jährlich), umgerechnet auf Monatskosten
- Status: aktiv, gekündigt (läuft aus) und beendet
- **Dokumente** pro Vertrag: PDFs und Fotos anhängen (z. B. Vertrag, abfotografierte Kündigungsbestätigung), beim Hochladen benennen, später umbenennen oder löschen
  - Vorschaubild der ersten Seite in der Liste
  - Eingebauter Betrachter mit Blättern und Zoom (Buttons, Doppeltipp, Pinch, Strg + Mausrad)
  - Teilen bzw. Herunterladen des Originals
  - Große Fotos werden automatisch auf max. 2400 px verkleinert, PDFs bleiben unverändert
- Backup und Wiederherstellung als JSON (inklusive Dokumente), Export als CSV (für Excel)
- **Logos**: automatisch für rund 100 bekannte Anbieter oder über die eingetragene Website (geladen über DuckDuckGo, danach lokal gespeichert, unter „Mehr“ abschaltbar); alternativ eigenes Bild oder nur Anfangsbuchstabe
- Gesten: auf der Übersicht im oberen Bildschirmdrittel nach unten ziehen zum Aktualisieren; geöffnete Verträge nach unten wegwischen zum Schließen
- Eigene Sicherheitsabfragen beim Löschen und Importieren (keine Browser-Popups)
- Hell- und Dunkelmodus, läuft offline, auf dem Startbildschirm installierbar

## Datenschutz

Alle Daten bleiben **ausschließlich lokal im Browser** des jeweiligen Geräts: Verträge im localStorage, Dokumente in IndexedDB. Es gibt keinen Server und kein Konto. Deshalb gilt:

- Daten werden nicht automatisch zwischen Handy und PC synchronisiert. Zum Übertragen ein Backup exportieren und auf dem anderen Gerät importieren.
- Wer die Browserdaten löscht, löscht auch die Verträge. Regelmäßig ein Backup machen!

**Ausnahme Logos:** Ist „Logos automatisch laden“ eingeschaltet (Standard), fragt die App bei DuckDuckGo das Symbol zur Webadresse des Anbieters ab (z. B. `netflix.com`). Dabei werden keine weiteren Daten übertragen, und jedes Logo wird nur einmal geladen. Wer das nicht möchte, schaltet es unter „Mehr“ aus.

## So wird die Kündigungsfrist berechnet

| Feld | Bedeutung |
|---|---|
| Vertragsbeginn | Startdatum der ersten Laufzeit |
| Mindestlaufzeit | Erste Laufzeit in Monaten (leer/0 = keine) |
| Verlängerung | Um wie viele Monate sich der Vertrag danach automatisch verlängert (z. B. 1 oder 12). Leer/0 = danach unbefristet, also jederzeit mit Frist kündbar |
| Kündigungsfrist | Wie lange vor Laufzeitende die Kündigung spätestens eingehen muss |

Beispiel: Abschluss am 15.12.2024, 24 Monate Mindestlaufzeit, danach monatliche Verlängerung, 1 Monat Kündigungsfrist. Die Mindestlaufzeit endet am 14.12.2026, die Frist dafür wäre der 14.11.2026 gewesen. Ist dieser Tag vorbei, zeigt die App die nächste Frist: **14.12.2026** zum Laufzeitende am 14.01.2027.

> Hinweis: Seit März 2022 dürfen sich Verbraucherverträge in Deutschland nach der Mindestlaufzeit in der Regel nur noch auf unbestimmte Zeit verlängern, mit höchstens einem Monat Kündigungsfrist. Für solche Verträge „Verlängerung = 1 Monat“ und „Kündigungsfrist = 1 Monat“ eintragen. Die berechneten Daten sind eine Hilfe und ersetzen nicht den Blick in den Vertrag.

## Starten und Hosten

Die App braucht keinen Build-Schritt: HTML, CSS und JavaScript, ohne Abhängigkeiten.

**Lokal testen:**

```bash
python3 -m http.server 8080
# dann http://localhost:8080 öffnen
```

**Kostenlos veröffentlichen mit GitHub Pages:**
Repository → *Settings* → *Pages* → Source: „Deploy from a branch“ → Branch `main`, Ordner `/ (root)` → speichern.
Die App ist dann unter `https://<benutzer>.github.io/fristfuchs/` erreichbar.

PWA-Funktionen (Offline, Installation) brauchen HTTPS oder `localhost`.

**Auf dem Handy installieren:**
- iPhone (Safari): Teilen-Symbol → „Zum Home-Bildschirm“
- Android (Chrome): Menü → „App installieren“

## Dateien

| Datei | Inhalt |
|---|---|
| `index.html` | Oberfläche |
| `styles.css` | Gestaltung (responsiv, hell/dunkel) |
| `app.js` | Logik: Speichern, Fristberechnung, Dokumente, Export, Benachrichtigungen |
| `sw.js` | Service Worker (Offline-Cache, Klick auf Benachrichtigung) |
| `manifest.webmanifest` | PWA-Manifest |
| `icons/` | App-Icons |
| `vendor/pdfjs/` | [PDF.js](https://github.com/mozilla/pdf.js) 4.10.38 von Mozilla (Apache-2.0) zur PDF-Anzeige |

Bei Änderungen an den Dateien die Konstante `CACHE` in `sw.js` hochzählen, damit installierte Apps das Update laden.
