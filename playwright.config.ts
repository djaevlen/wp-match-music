import { defineConfig, devices } from '@playwright/test';

const PROTO_PORT = 5317;
// The local WordPress from wp-env (`npx wp-env start`); the e2e suite runs against its built plugin.
const WP_URL = 'http://localhost:8888';

// Muted output for automated runs. The e2e pages also route Web Audio into a gain of 0
// (tests/e2e/helpers.ts), which covers WebKit, where no launch option mutes.
const chromiumMuted = { args: ['--mute-audio'] };
const firefoxMuted = { firefoxUserPrefs: { 'media.volume_scale': '0.0' } };

export default defineConfig({
  testDir: './tests',
  // Audio timing is measured in real time: one browser at a time, nothing competing for the CPU.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  reporter: [['list']],
  webServer: {
    command: `npm run proto -- --port ${PROTO_PORT} --strictPort`,
    url: `http://localhost:${PROTO_PORT}/prototype/`,
    reuseExistingServer: true,
  },
  projects: [
    // Gate suite (tests/gate): the audio prototype on a Vite server.
    // Speakers are muted for automated runs (here, and by ?mute=1 in the page for every
    // browser). Both mute only the final output; the gate's meter taps the graph upstream.
    {
      name: 'chromium',
      testDir: './tests/gate',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${PROTO_PORT}`,
        launchOptions: chromiumMuted,
      },
    },
    {
      name: 'firefox',
      testDir: './tests/gate',
      use: {
        ...devices['Desktop Firefox'],
        baseURL: `http://localhost:${PROTO_PORT}`,
        launchOptions: firefoxMuted,
      },
    },
    {
      name: 'webkit',
      testDir: './tests/gate',
      use: { ...devices['Desktop Safari'], baseURL: `http://localhost:${PROTO_PORT}` },
    },

    // End-to-end suite (tests/e2e): the built plugin in wp-env. `npm run test:e2e`.
    { name: 'e2e-setup', testDir: './tests/e2e', testMatch: /global-setup\.ts$/ },
    {
      name: 'e2e-chromium',
      testDir: './tests/e2e',
      dependencies: ['e2e-setup'],
      use: { ...devices['Desktop Chrome'], baseURL: WP_URL, viewport: { width: 1280, height: 800 }, launchOptions: chromiumMuted },
    },
    {
      name: 'e2e-firefox',
      testDir: './tests/e2e',
      dependencies: ['e2e-setup'],
      use: { ...devices['Desktop Firefox'], baseURL: WP_URL, viewport: { width: 1280, height: 800 }, launchOptions: firefoxMuted },
    },
    {
      name: 'e2e-webkit',
      testDir: './tests/e2e',
      dependencies: ['e2e-setup'],
      use: { ...devices['Desktop Safari'], baseURL: WP_URL, viewport: { width: 1280, height: 800 } },
    },
  ],
});
