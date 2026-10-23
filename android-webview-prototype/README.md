# NSNVC VB-GRAMG Android WebView prototype

An isolated Android Studio prototype. It does not change the GitHub Pages tracker or its Firebase/Firestore data.

## What it does
- Opens the configured official VB-GRAMG Registration Application Register in a WebView.
- Provides a native **Import / Preview** button outside the government page.
- On a deliberate tap, reads the largest HTML table from the rendered page and shows its first rows.
- Restricts top-level navigation to HTTPS pages on `dord.gov.in` and its subdomains.
- Does not expose `addJavascriptInterface`, save report data, call Firebase, or write to the contribution ledger.

## Run
1. Open this `android-webview-prototype` folder in Android Studio.
2. Use JDK 17 and install Android SDK Platform 35 when prompted.
3. Let Gradle sync and run on an Android device or emulator with internet access.

This source-only prototype does not include a Gradle wrapper. No APK has been built in this change.

## Limitations
- It previews raw table rows only; it does not yet map columns into the existing web importer schema.
- It does not send records into the existing importer and has no tracker/database integration.
- Government redirects, session behaviour, server availability, or an error page may prevent extraction.
- No live-device build or government-site test has been performed.

## Safety boundary
Extracted data remains transient in app memory for preview. No automatic import into the tracker occurs. Any future integration must preserve review/confirmation and keep the ledger untouched unless the user explicitly authorizes a separate update.
