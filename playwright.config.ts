import { defineConfig, devices } from '@playwright/test';

const PROTO_PORT = 5317;

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
    // Speakers are muted for automated runs (here, and by ?mute=1 in the page for every
    // browser). Both mute only the final output; the gate's meter taps the graph upstream.
    {
      name: 'chromium',
      testDir: './tests/gate',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${PROTO_PORT}`,
        launchOptions: { args: ['--mute-audio'] },
      },
    },
    {
      name: 'firefox',
      testDir: './tests/gate',
      use: {
        ...devices['Desktop Firefox'],
        baseURL: `http://localhost:${PROTO_PORT}`,
        launchOptions: { firefoxUserPrefs: { 'media.volume_scale': '0.0' } },
      },
    },
    {
      name: 'webkit',
      testDir: './tests/gate',
      use: { ...devices['Desktop Safari'], baseURL: `http://localhost:${PROTO_PORT}` },
    },
  ],
});
