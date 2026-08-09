/*
 * Deployment-time browser compiler data origin configuration. Executable JS
 * and Worker entrypoints always remain on the application origin.
 *
 * Keep this file short-lived in the gateway cache. An operator may replace it
 * during deployment without rebuilding app.js, for example:
 *
 * globalThis.__ARDUINOFAST_TOOLCHAIN_ORIGINS__ = {
 *   "arduino-avr-uno": "https://cdn.example.com/arduinofast/avr/v4/",
 * };
 */
if (globalThis.__ARDUINOFAST_TOOLCHAIN_ORIGINS__ == null) {
  globalThis.__ARDUINOFAST_TOOLCHAIN_ORIGINS__ = Object.freeze({});
}
