// Capacitor generates the Android project in CI. This copies the app's own native
// code into it (the home-screen widget and the background Screener alert job, kept
// in native/), registers them in the manifest and applies the backup rules.
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const main = 'android/app/src/main';
const pkg = `${main}/java/com/zlhng/tradingapp`;
if (!existsSync(`${pkg}/MainActivity.java`)) throw new Error(`Expected ${pkg}/MainActivity.java. Run "npx cap add android" first.`);

for (const f of readdirSync('native/java')) cpSync(`native/java/${f}`, `${pkg}/${f}`);
cpSync('native/res', `${main}/res`, { recursive: true });

const components = `
        <receiver android:name=".TradingWidget" android:exported="false" android:label="@string/widget_label">
            <intent-filter>
                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
            </intent-filter>
            <meta-data android:name="android.appwidget.provider" android:resource="@xml/widget_trading" />
        </receiver>
        <service android:name=".ScreenerJob" android:exported="true" android:permission="android.permission.BIND_JOB_SERVICE" />
    </application>`;
// Showing notifications, and keeping the hourly alert job across a restart of the phone.
const permissions = ['android.permission.POST_NOTIFICATIONS', 'android.permission.RECEIVE_BOOT_COMPLETED'];

const path = `${main}/AndroidManifest.xml`;
let xml = readFileSync(path, 'utf8');
if (!xml.includes('TradingWidget')) {
  if (!xml.includes('</application>') || !xml.includes('</manifest>')) throw new Error('AndroidManifest.xml is not in the expected shape.');
  xml = xml.replace('</application>', components.trimStart().replace(/^/, '\n        '));
  // Tokens are kept in Capacitor Preferences; these rules keep that store out of Android's backups.
  if (!xml.includes('dataExtractionRules')) {
    if (!xml.includes('<application')) throw new Error('No <application> tag in AndroidManifest.xml.');
    xml = xml.replace('<application', '<application\n        android:fullBackupContent="@xml/backup_rules"\n        android:dataExtractionRules="@xml/data_extraction_rules"');
  }
  for (const p of permissions) {
    if (!xml.includes(`"${p}"`)) xml = xml.replace('</manifest>', `    <uses-permission android:name="${p}" />\n</manifest>`);
  }
  writeFileSync(path, xml);
}
console.log('Native widget and alert job added to the Android project.');
