/*
 * Deployment-time browser compiler data origin configuration. Executable JS
 * and Worker entrypoints always remain on the application origin.
 *
 * Keep this file short-lived in the gateway cache. An operator may replace it
 * during deployment without rebuilding app.js, for example:
 *
 * globalThis.__SKETCHFORGE_TOOLCHAIN_ORIGINS__ = {
 *   "arduino-avr-uno": "https://cdn.example.com/sketchforge/avr/v4/",
 * };
 */
const BROWSER_TOOLCHAIN_ORIGINS_KEY = "__SKETCHFORGE_TOOLCHAIN_ORIGINS__";
const LEGACY_BROWSER_TOOLCHAIN_ORIGINS_KEY = "__ARDUINOFAST_TOOLCHAIN_ORIGINS__";

if (globalThis[BROWSER_TOOLCHAIN_ORIGINS_KEY] == null) {
  globalThis[BROWSER_TOOLCHAIN_ORIGINS_KEY]
    = globalThis[LEGACY_BROWSER_TOOLCHAIN_ORIGINS_KEY] ?? Object.freeze({});
}
