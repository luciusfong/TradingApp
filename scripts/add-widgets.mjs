// Copies the home-screen widget sources into the Android project that Capacitor
// generates in CI, and registers the three widget receivers in its manifest.
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const main = 'android/app/src/main';
const pkg = `${main}/java/com/zlhng/tradingapp`;
if (!existsSync(`${pkg}/MainActivity.java`)) throw new Error(`Expected ${pkg}/MainActivity.java. Run "npx cap add android" first.`);

for (const f of readdirSync('widget/java')) cpSync(`widget/java/${f}`, `${pkg}/${f}`);
cpSync('widget/res', `${main}/res`, { recursive: true });

const receiver = (cls, name) => `
        <receiver android:name=".${cls}" android:exported="false" android:label="@string/widget_${name}_label">
            <intent-filter>
                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
            </intent-filter>
            <meta-data android:name="android.appwidget.provider" android:resource="@xml/widget_${name}" />
        </receiver>`;
const path = `${main}/AndroidManifest.xml`;
let xml = readFileSync(path, 'utf8');
if (!xml.includes('WatchlistWidget')) {
  if (!xml.includes('</application>')) throw new Error('No </application> in AndroidManifest.xml');
  xml = xml.replace('</application>', `${receiver('WatchlistWidget', 'watchlist')}${receiver('PositionsWidget', 'positions')}${receiver('NewsWidget', 'news')}\n    </application>`);
  writeFileSync(path, xml);
}
console.log('Widgets added to the Android project.');
